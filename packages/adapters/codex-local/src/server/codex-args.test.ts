import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });

  it("swaps gpt-5.3-codex-spark for gpt-5.3-codex on ChatGPT-subscription auth", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
      },
      { billingType: "subscription" },
    );

    expect(result.model).toBe("gpt-5.3-codex");
    expect(result.modelSwappedReason).toContain("gpt-5.3-codex-spark");
    expect(result.modelSwappedReason).toContain("ChatGPT-subscription");
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
  });

  it("leaves gpt-5.3-codex-spark untouched on API-key auth", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex-spark",
      },
      { billingType: "api" },
    );

    expect(result.model).toBe("gpt-5.3-codex-spark");
    expect(result.modelSwappedReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex-spark",
      "-",
    ]);
  });

  it("leaves gpt-5.3-codex-spark untouched when billingType is not provided", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex-spark",
    });

    expect(result.model).toBe("gpt-5.3-codex-spark");
    expect(result.modelSwappedReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex-spark",
      "-",
    ]);
  });
});
