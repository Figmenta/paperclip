import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// FIG kill switch (fig/v2026.626.0-r2/-r3, incident 2026-07-23).
//
// This is a DYNAMIC proof, on an isolated ephemeral (embedded) Postgres, that
// PAPERCLIP_RECOVERY_OWNER_DISABLED=1 flips the real stranded-issue escalation
// entrypoint `recovery.escalateStrandedAssignedIssue(...)` -- the exact function
// `reconcileStrandedAssignedIssues()` invokes at every escalation site -- from
//   OLD (gremlin):    pick an agent recovery owner  + wake an LLM executor
//   NEW (contained):  park the escalation on the board + wake NOBODY
// using IDENTICAL seeded input in both cases.
//
// The entire behavioural difference lives in
// `resolveStrandedIssueRecoveryOwnerAgentId`, whose first line early-returns
// null when the flag is "1". That null propagates to ownerType=board /
// ownerAgentId=null and short-circuits the wake dispatch.

const KILL_SWITCH = "PAPERCLIP_RECOVERY_OWNER_DISABLED";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping FIG kill-switch board-park proof on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("FIG kill switch PAPERCLIP_RECOVERY_OWNER_DISABLED: agent-wake -> board-park proof", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let originalKillSwitch: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fig-killswitch-boardpark-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    // Snapshot the ambient value so we can restore it after each case and never
    // leak a mutation onto the vitest process.
    originalKillSwitch = process.env[KILL_SWITCH];
  });

  afterEach(async () => {
    if (originalKillSwitch === undefined) {
      delete process.env[KILL_SWITCH];
    } else {
      process.env[KILL_SWITCH] = originalKillSwitch;
    }
    // Fresh state between cases so they cannot cross-contaminate.
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // IDENTICAL seeding for both cases: a company with an invokable CTO manager,
  // an invokable coder that reports to the CTO, and one stranded assigned issue
  // owned by the coder. With the flag OFF the CTO resolves as the recovery owner
  // (assignee.reportsTo + cto/ceo role candidate, invokable, no budget block).
  async function seedStrandedScenario() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `FK${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Kill Switch Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  it("CASE A (control, kill switch OFF): resolves an AGENT recovery owner and WAKES an LLM (the gremlin)", async () => {
    // Guarantee the flag is OFF regardless of ambient env.
    delete process.env[KILL_SWITCH];
    expect(process.env[KILL_SWITCH]).toBeUndefined();

    const { managerId, coderId, sourceIssue } = await seedStrandedScenario();
    const wakeSpy = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup: wakeSpy });

    // Same latestRun fixture shape both cases use.
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(actionRows).toHaveLength(1);
    const action = actionRows[0]!;

    // GREMLIN behaviour: an agent is picked as the recovery owner...
    expect(action.ownerType).toBe("agent");
    expect(action.ownerAgentId).not.toBeNull();
    expect(action.ownerAgentId).toBe(managerId);
    // ...and an LLM wake WAS dispatched to that owner.
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(wakeSpy.mock.calls[0]?.[0]).toBe(managerId);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue?.status).toBe("blocked");

    // Verbatim, greppable evidence line for the report.
    console.log(
      `[PROOF][CASE A / flag OFF] ownerType=${action.ownerType} ownerAgentId=${action.ownerAgentId} wakeSpyCalls=${wakeSpy.mock.calls.length} wokeAgentId=${String(wakeSpy.mock.calls[0]?.[0])} (expected managerId=${managerId})`,
    );
  });

  it("CASE B (contained, kill switch ON): parks on the BOARD and wakes NO LLM", async () => {
    process.env[KILL_SWITCH] = "1";
    expect(process.env[KILL_SWITCH]).toBe("1");

    const { coderId, sourceIssue } = await seedStrandedScenario();
    const wakeSpy = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup: wakeSpy });

    // IDENTICAL latestRun fixture shape as CASE A.
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(actionRows).toHaveLength(1);
    const action = actionRows[0]!;

    // CONTAINMENT: the escalation parks on the board, no agent owner...
    expect(action.ownerType).toBe("board");
    expect(action.ownerAgentId).toBeNull();
    // ...and NO LLM wake was dispatched. Zero gremlins.
    expect(wakeSpy).toHaveBeenCalledTimes(0);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue?.status).toBe("blocked");

    console.log(
      `[PROOF][CASE B / flag ON] ownerType=${action.ownerType} ownerAgentId=${String(action.ownerAgentId)} wakeSpyCalls=${wakeSpy.mock.calls.length}`,
    );
  });
});
