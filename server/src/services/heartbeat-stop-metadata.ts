import { DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC } from "@paperclipai/adapter-utils/execution-target";

export type HeartbeatRunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

// Adapter types whose runs execute as local child processes (or over SSH) and
// therefore receive `DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC` from
// `resolveAdapterExecutionTargetTimeoutSec` when their config leaves
// `timeoutSec` unset. Keeping this list in lockstep with the enforcement path
// is what makes resultJson report `timeoutConfigured:true` /
// `effectiveTimeoutSec:5400` / `timeoutSource:"default"` instead of the old
// lying `timeoutConfigured:false` (the FIG-1774 incident symptom). The single
// source of truth for the value is the shared constant imported above.
//
// Note: this is keyed on adapterType only, so it cannot see when a local
// adapter is pinned to a sandbox execution target (where the effective default
// is DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC instead). That edge case keeps
// the historical approximation; the common local-execution case is exact.
const LOCAL_DEFAULT_TIMEOUT_ADAPTER_TYPES = new Set([
  "opencode_local",
  "claude_local",
  "codex_local",
  "pi_local",
  "grok_local",
  "gemini_local",
  "cursor",
]);

export type HeartbeatRunStopReason =
  | "completed"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "adapter_failed";

export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  timeoutConfigured: boolean;
  timeoutSource: "config" | "default" | "unknown";
}

export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function defaultTimeoutSecForAdapter(adapterType: string) {
  if (adapterType === "openclaw_gateway") return 120;
  if (LOCAL_DEFAULT_TIMEOUT_ADAPTER_TYPES.has(adapterType)) return DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC;
  return 0;
}

export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const hasTimeoutMs = hasOwn(config, "timeoutMs");
    const rawTimeoutMs = hasTimeoutMs ? readFiniteNumber(config.timeoutMs) : 0;
    const timeoutMs = Math.max(0, Math.floor(rawTimeoutMs ?? 0));
    return {
      effectiveTimeoutSec: timeoutMs / 1000,
      effectiveTimeoutMs: timeoutMs,
      timeoutConfigured: timeoutMs > 0,
      timeoutSource: hasTimeoutMs ? "config" : "default",
    };
  }

  const hasTimeoutSec = hasOwn(config, "timeoutSec");
  const defaultTimeoutSec = defaultTimeoutSecForAdapter(adapterType);
  const rawTimeoutSec = hasTimeoutSec ? readFiniteNumber(config.timeoutSec) : defaultTimeoutSec;
  const timeoutSec = Math.max(0, Math.floor(rawTimeoutSec ?? defaultTimeoutSec));

  return {
    effectiveTimeoutSec: timeoutSec,
    timeoutConfigured: timeoutSec > 0,
    timeoutSource: hasTimeoutSec ? "config" : "default",
  };
}

export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig);
  const stopReason = inferHeartbeatRunStopReason(input);
  return {
    ...timeoutPolicy,
    stopReason,
    timeoutFired: stopReason === "timeout",
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  return {
    ...(resultJson ?? {}),
    stopReason: existingMaxTurnStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: metadata.effectiveTimeoutSec,
    timeoutConfigured: metadata.timeoutConfigured,
    timeoutSource: metadata.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    ...(metadata.effectiveTimeoutMs != null ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
