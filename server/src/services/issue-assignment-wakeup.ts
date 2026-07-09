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

/**
 * FIG-63 Layer 1: the shape a not_invokable dispatch is surfaced with. `reason` is the
 * invokability block reason (paused, terminated, pending_approval, or a broken reporting
 * chain), `agentStatus` the raw agent status at the time the wake was refused.
 */
export interface NotInvokableDispatchInfo {
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  agentStatus: string | null;
  message: string;
}

/**
 * FIG-63 Layer 1: distinguish a "the assignee is not invokable" 409 (paused / terminated /
 * pending_approval / broken reporting chain) from every OTHER conflict the wake path can
 * throw (e.g. a budget block, which is also a 409). Only the invokability conflict carries
 * BOTH a string `reason` and the `invalidOrgChain` discriminator in its details — a budget
 * block carries neither — so this is a precise, false-positive-free classifier.
 */
function readNotInvokableConflict(
  err: unknown,
): { reason: string; agentStatus: string | null } | null {
  if (!(err instanceof HttpError) || err.status !== 409) return null;
  const details = err.details;
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (!("invalidOrgChain" in record) || !("reason" in record)) return null;
  const reason = record.reason;
  if (typeof reason !== "string") return null;
  const status = record.status;
  return { reason, agentStatus: typeof status === "string" ? status : null };
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
  /**
   * FIG-63 Layer 1: invoked when the wake is refused because the assignee is not invokable,
   * so the refusal is surfaced (issue comment + activity event) instead of being swallowed
   * as a WARN. Optional — a caller that does not pass it still gets a LOUD log line (never a
   * silent success), but no rail-visible signal.
   */
  reportNotInvokable?: (info: NotInvokableDispatchInfo) => Promise<void>;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch(async (err) => {
      // FIG-63 Layer 1: an assignee Paperclip refuses to wake must NEVER be a silent
      // no-op (the FIG-60 incident: an issue assigned to a paused agent produced no run,
      // zero comments, and only a WARN — invisible for ~2 days). Surface the not_invokable
      // class LOUDLY: a rail-visible signal via `reportNotInvokable` plus a distinct log
      // line. Transient/other errors keep the prior warn-and-(maybe)-rethrow behaviour.
      const notInvokable = readNotInvokableConflict(err);
      if (notInvokable) {
        logger.warn(
          { issueId: input.issue.id, reason: notInvokable.reason, agentStatus: notInvokable.agentStatus },
          "assignee not invokable on issue assignment — surfacing signal, no run opened",
        );
        if (input.reportNotInvokable) {
          try {
            await input.reportNotInvokable({
              issue: input.issue,
              reason: notInvokable.reason,
              agentStatus: notInvokable.agentStatus,
              message: err instanceof Error ? err.message : String(err),
            });
          } catch (reportErr) {
            logger.error(
              { reportErr, issueId: input.issue.id },
              "failed to surface not_invokable dispatch signal",
            );
          }
        }
        return null;
      }
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
