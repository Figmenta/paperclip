import { describe, expect, it } from "vitest";
import { BOARD_API_KEY_TTL_MS, assertBoardApiKeyTtlPolicy } from "./board-auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("board API key TTL policy invariant (FIG-1672)", () => {
  it("encodes the 180-day policy in the live constant", () => {
    expect(BOARD_API_KEY_TTL_MS).toBe(180 * DAY_MS);
  });

  it("passes startup when the effective TTL matches policy", () => {
    // Default argument exercises the real, compiled BOARD_API_KEY_TTL_MS — the
    // exact value the server checks at startup.
    expect(() => assertBoardApiKeyTtlPolicy()).not.toThrow();
    expect(() => assertBoardApiKeyTtlPolicy(180 * DAY_MS)).not.toThrow();
  });

  it("fails loud when the effective TTL has regressed to the stale 30-day value", () => {
    // Simulates a stale `dist/` build (the dist trap) serving the old 30d TTL.
    expect(() => assertBoardApiKeyTtlPolicy(30 * DAY_MS)).toThrow(/policy violation/i);
  });

  it("fails loud for any non-policy TTL", () => {
    expect(() => assertBoardApiKeyTtlPolicy(0)).toThrow();
    expect(() => assertBoardApiKeyTtlPolicy(90 * DAY_MS)).toThrow();
    expect(() => assertBoardApiKeyTtlPolicy(365 * DAY_MS)).toThrow();
  });
});
