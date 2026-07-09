import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

// FIG-67 Layer 1: the invokability block reasons that heartbeat.wakeup() surfaces on the
// 409 it throws (errors.ts conflict() with details.reason, driven by agent-invokability.ts).
// A wake that fails for one of these reasons is a DISPATCH that produced no run — it must be
// made loud (system comment + structured event), never swallowed as a WARN. Kept in sync with
// agent-invokability.ts AgentInvokabilityBlockReason.
const INVOKABILITY_BLOCK_REASONS = new Set([
  "missing",
  "paused",
  "terminated",
  "pending_approval",
  "unknown_status",
  "manager_missing",
  "manager_company_mismatch",
  "manager_terminated",
  "reporting_cycle",
  "reporting_chain_too_deep",
]);

// Structured marker any observer (Orchestra's dispatch reconciler, log-based alerting) can key
// on to detect a swallowed not-invokable wake. FIG-67 Layer 1/3.
export const DISPATCH_NOT_INVOKABLE_EVENT = "dispatch.assignee_not_invokable";

function extractNotInvokable(err: unknown): { reason: string; status: string | null } | null {
  if (
    err instanceof HttpError &&
    err.status === 409 &&
    err.details &&
    typeof err.details === "object"
  ) {
    const details = err.details as Record<string, unknown>;
    const reason = typeof details.reason === "string" ? details.reason : null;
    if (reason && INVOKABILITY_BLOCK_REASONS.has(reason)) {
      return { reason, status: typeof details.status === "string" ? details.status : null };
    }
  }
  return null;
}

// FIG-67 Layer 1: convert the silent WARN into a first-class, operator-visible signal on the
// just-assigned issue. Posts a SYSTEM comment ("assignee <name> is not invokable (<status>);
// no run was opened") and emits a structured error log carrying DISPATCH_NOT_INVOKABLE_EVENT.
// Best-effort and fully isolated — a failure to surface must never re-break the assignment
// hot path, so every step is guarded. Returns nothing; the caller already returned null.
async function surfaceNotInvokableDispatch(
  db: Db,
  input: {
    issueId: string;
    companyId: string;
    agentId: string;
    reason: string;
    status: string | null;
  },
) {
  let agentName = input.agentId;
  try {
    const [row] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (row?.name) agentName = row.name;
  } catch (err) {
    logger.warn({ err, agentId: input.agentId }, "not-invokable surface: agent name lookup failed");
  }

  const statusLabel = input.status ?? input.reason;
  const body =
    `⚠️ Dispatch produced no run: assignee **${agentName}** is not invokable ` +
    `(status: \`${statusLabel}\`, reason: \`${input.reason}\`). The assignment was recorded ` +
    `but no heartbeat run was opened. Resume/reassign the agent, or dispatch to an invokable ` +
    `assignee, to make this work run.`;

  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      body,
    });
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
  } catch (err) {
    logger.error(
      { err, issueId: input.issueId, agentId: input.agentId },
      "not-invokable surface: failed to post system comment",
    );
  }

  // Structured event (log-observable) — NOT a swallowed WARN. Orchestra's reconciler and any
  // log alerting key on `event`. Emitted at error level so it is never filtered as noise.
  logger.error(
    {
      event: DISPATCH_NOT_INVOKABLE_EVENT,
      issueId: input.issueId,
      companyId: input.companyId,
      agentId: input.agentId,
      agentName,
      reason: input.reason,
      agentStatus: input.status,
    },
    "issue assignment wake refused: assignee not invokable, no run opened",
  );
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string; companyId?: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
  // FIG-67 Layer 1: when provided, a not-invokable wake failure is surfaced as a system
  // comment on the issue instead of being swallowed. Optional so legacy callers/tests degrade
  // to the louder structured log without the comment.
  db?: Db;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
    })
    .catch((err) => {
      // FIG-67 Layer 1: a not-invokable/409 wake is a DISPATCH that opened no run. Never
      // swallow it as a WARN — surface it loudly (system comment + structured event) so a
      // paused/terminated assignee can never silently no-op a dispatch again.
      const notInvokable = extractNotInvokable(err);
      if (notInvokable && input.db && input.issue.companyId && input.issue.assigneeAgentId) {
        void surfaceNotInvokableDispatch(input.db, {
          issueId: input.issue.id,
          companyId: input.issue.companyId,
          agentId: input.issue.assigneeAgentId,
          reason: notInvokable.reason,
          status: notInvokable.status,
        });
      } else if (notInvokable) {
        // No db/companyId in hand (legacy caller / test) — still make it loud, not a WARN.
        logger.error(
          {
            event: DISPATCH_NOT_INVOKABLE_EVENT,
            issueId: input.issue.id,
            agentId: input.issue.assigneeAgentId,
            reason: notInvokable.reason,
            agentStatus: notInvokable.status,
          },
          "issue assignment wake refused: assignee not invokable, no run opened",
        );
      } else {
        logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      }
      if (input.rethrowOnError) throw err;
      return null;
    });
}
