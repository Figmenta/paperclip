import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC } from "@paperclipai/adapter-utils/execution-target";
import { resolveHeartbeatRunTimeoutPolicy } from "../services/heartbeat-stop-metadata.ts";

describe("resolveHeartbeatRunTimeoutPolicy", () => {
  it("returns 5400s default for claude_local", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("claude_local", null);
    expect(result.effectiveTimeoutSec).toBe(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC);
    expect(result.timeoutConfigured).toBe(true);
    expect(result.timeoutSource).toBe("default");
  });

  it("returns 5400s default for codex_local", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("codex_local", null);
    expect(result.effectiveTimeoutSec).toBe(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC);
  });

  it("returns 5400s default for ssh", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("ssh", null);
    expect(result.effectiveTimeoutSec).toBe(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC);
  });

  it("returns 5400s default for pi_local", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("pi_local", null);
    expect(result.effectiveTimeoutSec).toBe(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC);
  });

  it("returns 5400s default for cursor", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("cursor", null);
    expect(result.effectiveTimeoutSec).toBe(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC);
  });

  it("respects configured override for claude_local", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("claude_local", { timeoutSec: 3600 });
    expect(result.effectiveTimeoutSec).toBe(3600);
    expect(result.timeoutSource).toBe("config");
  });

  it("returns 120 for openclaw_gateway", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("openclaw_gateway", null);
    expect(result.effectiveTimeoutSec).toBe(120);
  });

  it("returns 0 (no timeout) for unknown adapter type", () => {
    const result = resolveHeartbeatRunTimeoutPolicy("process", null);
    expect(result.effectiveTimeoutSec).toBe(0);
    expect(result.timeoutConfigured).toBe(false);
  });

  it("DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC is 5400", () => {
    expect(DEFAULT_LOCAL_ADAPTER_TIMEOUT_SEC).toBe(5_400);
  });
});
