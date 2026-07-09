import { describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.js";
import { queueIssueAssignmentWakeup, type NotInvokableDispatchInfo } from "./issue-assignment-wakeup.js";

const ISSUE = { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" };

// The exact shape heartbeat.wakeup throws for a not-invokable agent (heartbeat.ts):
// conflict(message, { status, reason, invalidOrgChain, ...details }).
function notInvokableConflict(reason: string, status: string) {
  return conflict("Agent is not invokable in its current state", {
    status,
    reason,
    invalidOrgChain: false,
    agentId: "agent-1",
    agentStatus: status,
  });
}

describe("queueIssueAssignmentWakeup — FIG-63 fail-loud", () => {
  it("surfaces a not_invokable 409 via reportNotInvokable and does NOT rethrow", async () => {
    const reportNotInvokable = vi.fn<[NotInvokableDispatchInfo], Promise<void>>().mockResolvedValue();
    const heartbeat = { wakeup: vi.fn().mockRejectedValue(notInvokableConflict("paused", "paused")) };

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: ISSUE,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      rethrowOnError: true, // even with rethrow set, a not_invokable is surfaced, not thrown
      reportNotInvokable,
    });

    expect(reportNotInvokable).toHaveBeenCalledTimes(1);
    const info = reportNotInvokable.mock.calls[0][0];
    expect(info.reason).toBe("paused");
    expect(info.agentStatus).toBe("paused");
    expect(info.issue.id).toBe("issue-1");
  });

  it("does not swallow silently when no reporter is wired (still resolves, no throw)", async () => {
    const heartbeat = { wakeup: vi.fn().mockRejectedValue(notInvokableConflict("terminated", "terminated")) };
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: ISSUE,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      }),
    ).resolves.toBeNull();
  });

  it("treats a budget-block 409 as transient (NOT not_invokable) and rethrows when asked", async () => {
    // A budget block is also a 409 but carries neither `reason` nor `invalidOrgChain`.
    const reportNotInvokable = vi.fn();
    const heartbeat = {
      wakeup: vi.fn().mockRejectedValue(conflict("Budget exceeded", { scopeType: "company", scopeId: "c1" })),
    };
    await expect(
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: ISSUE,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
        rethrowOnError: true,
        reportNotInvokable,
      }),
    ).rejects.toThrow(/Budget exceeded/);
    expect(reportNotInvokable).not.toHaveBeenCalled();
  });

  it("happy path: wakeup resolves, reporter never fires", async () => {
    const reportNotInvokable = vi.fn();
    const heartbeat = { wakeup: vi.fn().mockResolvedValue({ ok: true }) };
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: ISSUE,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      reportNotInvokable,
    });
    expect(reportNotInvokable).not.toHaveBeenCalled();
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
  });

  it("skips entirely for a backlog issue or a null assignee", async () => {
    const heartbeat = { wakeup: vi.fn() };
    queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "i", assigneeAgentId: null, status: "todo" },
      reason: "r",
      mutation: "create",
      contextSource: "s",
    });
    queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "i", assigneeAgentId: "a", status: "backlog" },
      reason: "r",
      mutation: "create",
      contextSource: "s",
    });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });
});
