import { describe, expect, it } from "vitest";
import { conflict } from "../errors.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

// FIG-67 Layer 1: a wake refused because the assignee is not invokable (409 with an
// invokability reason) must NEVER be swallowed as a WARN — it must post a SYSTEM comment on
// the just-assigned issue so a paused/terminated assignee can never silently no-op a dispatch.

type Recorded = { inserts: Array<Record<string, unknown>>; updates: number };

function makeFakeDb(recorded: Recorded, agentName = "Ivan") {
  return {
    select() {
      return {
        from() {
          return this;
        },
        where() {
          return this;
        },
        limit() {
          return Promise.resolve([{ name: agentName }]);
        },
      };
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          recorded.inserts.push(v);
          return Promise.resolve();
        },
      };
    },
    update() {
      return {
        set() {
          return this;
        },
        where() {
          recorded.updates += 1;
          return Promise.resolve();
        },
      };
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("queueIssueAssignmentWakeup fail-loud (FIG-67 Layer 1)", () => {
  it("posts a system comment when the assignee is not invokable (paused)", async () => {
    const recorded: Recorded = { inserts: [], updates: 0 };
    const heartbeat = {
      wakeup: () =>
        Promise.reject(
          conflict("Agent is not invokable in its current state", {
            status: "paused",
            reason: "paused",
          }),
        ),
    };

    await queueIssueAssignmentWakeup({
      heartbeat,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeFakeDb(recorded) as any,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo", companyId: "co-1" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    await flush();

    expect(recorded.inserts).toHaveLength(1);
    const comment = recorded.inserts[0];
    expect(comment.authorType).toBe("system");
    expect(comment.issueId).toBe("issue-1");
    expect(String(comment.body)).toContain("not invokable");
    expect(String(comment.body)).toContain("Ivan");
    expect(recorded.updates).toBe(1);
  });

  it("does NOT post a comment for an ordinary (non-invokability) wake error", async () => {
    const recorded: Recorded = { inserts: [], updates: 0 };
    const heartbeat = { wakeup: () => Promise.reject(new Error("transient network blip")) };

    await queueIssueAssignmentWakeup({
      heartbeat,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeFakeDb(recorded) as any,
      issue: { id: "issue-2", assigneeAgentId: "agent-2", status: "todo", companyId: "co-1" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    await flush();

    expect(recorded.inserts).toHaveLength(0);
  });

  it("skips backlog issues and unassigned issues (no wake attempted)", async () => {
    const recorded: Recorded = { inserts: [], updates: 0 };
    let woke = false;
    const heartbeat = {
      wakeup: () => {
        woke = true;
        return Promise.resolve(null);
      },
    };

    queueIssueAssignmentWakeup({
      heartbeat,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeFakeDb(recorded) as any,
      issue: { id: "issue-3", assigneeAgentId: "agent-3", status: "backlog", companyId: "co-1" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    await flush();

    expect(woke).toBe(false);
    expect(recorded.inserts).toHaveLength(0);
  });
});
