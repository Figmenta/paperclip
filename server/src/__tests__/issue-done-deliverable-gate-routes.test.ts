import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FIG-1817: machine-enforced "no done without a deliverable" gate.
// Mirrors the harness in issue-execution-policy-routes.test.ts.

// The route harness pays a cold-start transform cost on the first test; give
// generous timeouts so a slow first test cannot bleed a late async log() call
// into the next test.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => [] as unknown[]),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

function inProgressCodingIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1817",
    title: "Coding task",
    // Execution signal => scope B classifies this as action/coding work.
    executionWorkspaceId: null,
    executionRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    executionPolicy: null,
    executionState: null,
  };
}

// A generic (non-coding) issue with no execution signal — scope B leaves it ungated.
function inProgressGenericIssue() {
  return {
    ...inProgressCodingIssue(),
    title: "Generic task",
    executionRunId: null,
  };
}

function agentActor(): TestActor {
  return { type: "agent", agentId: AGENT_ID, companyId: "company-1", runId: "run-1" };
}

describe("issue done-deliverable gate (FIG-1817)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", issueId: ISSUE_ID });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...inProgressCodingIssue(),
      ...patch,
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit";
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects an agent-authored done transition with no deliverable and audits it", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("[deliverable]");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "deliverable",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_blocked_missing_deliverable" }),
    );
  });

  // The gate runs before the update; the inbound comment is persisted afterwards
  // (a pipeline the lightweight harness does not fully wire). We therefore assert
  // gate-passage precisely: update WAS called and no block audit was emitted.
  it("passes the gate when the closing PATCH carries a [deliverable] comment", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());

    await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "[deliverable] branch forge/foo, PR #42" });

    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_blocked_missing_deliverable" }),
    );
  });

  it("allows done when a prior [deliverable] comment already exists", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());
    mockIssueService.listComments.mockResolvedValue([
      { id: "c1", authorAgentId: AGENT_ID, body: "[deliverable] see PR #42" },
    ]);

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows done when a work product (branch/PR) is registered", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());
    mockWorkProductService.listForIssue.mockResolvedValue([
      { id: "wp-1", type: "pull_request", provider: "github", url: "https://github.com/x/y/pull/42" },
    ]);

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("passes the gate with a --no-artifact justification from the closing agent", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());

    await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "--no-artifact investigation only, no code was required" });

    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_blocked_missing_deliverable" }),
    );
  });

  it("rejects a bare --no-artifact with no justification", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "--no-artifact" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ missing: "deliverable" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not gate a non-coding issue with no execution signal (scope B)", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressGenericIssue());

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_blocked_missing_deliverable" }),
    );
  });

  it("does not gate board-authored done transitions", async () => {
    mockIssueService.getById.mockResolvedValue(inProgressCodingIssue());

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
