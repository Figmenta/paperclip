import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachEmbeddedPostgresSupervisor,
  readEmbeddedPostgresRespawnPolicyFromEnv,
  type EmbeddedPostgresRespawnPolicy,
  type SupervisableEmbeddedPostgres,
} from "../embedded-postgres-supervisor.js";

/** A stand-in for the postmaster ChildProcess: only `once('exit', ...)` is used. */
function makeFakeChild(): EventEmitter & { kill: (code: number | null, signal: NodeJS.Signals | null) => void } {
  const emitter = new EventEmitter() as EventEmitter & {
    kill: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  emitter.kill = (code, signal) => emitter.emit("exit", code, signal);
  return emitter;
}

/** Minimal embedded-postgres instance whose `start()` swaps in a fresh child. */
function makeFakeInstance(): SupervisableEmbeddedPostgres & {
  currentChild: ReturnType<typeof makeFakeChild>;
  startCalls: number;
  startImpl: () => Promise<void>;
} {
  const instance: SupervisableEmbeddedPostgres & {
    currentChild: ReturnType<typeof makeFakeChild>;
    startCalls: number;
    startImpl: () => Promise<void>;
  } = {
    currentChild: makeFakeChild(),
    startCalls: 0,
    startImpl: async () => {},
    get process() {
      return this.currentChild as unknown as SupervisableEmbeddedPostgres["process"];
    },
    async start() {
      this.startCalls += 1;
      await this.startImpl();
      // A successful start replaces the postmaster child.
      this.currentChild = makeFakeChild();
    },
  };
  return instance;
}

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

/** Collects scheduled timer callbacks so tests can fire them deterministically. */
function makeManualTimer() {
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  return {
    scheduled,
    scheduleTimer: (cb: () => void, ms: number) => {
      scheduled.push({ cb, ms });
    },
    async runNext() {
      const next = scheduled.shift();
      if (!next) throw new Error("no scheduled timer");
      next.cb();
      // Let any async work inside the callback settle.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const RESPAWN_OFF: EmbeddedPostgresRespawnPolicy = {
  enabled: false,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

const RESPAWN_ON: EmbeddedPostgresRespawnPolicy = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

describe("attachEmbeddedPostgresSupervisor", () => {
  it("logs embedded-postgres-exit with exitCode, signal and uptimeMs on unexpected death", () => {
    const instance = makeFakeInstance();
    const logger = makeLogger();
    let clock = 1_000;

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_OFF,
      now: () => clock,
    });

    clock = 4_500; // 3500ms uptime
    // Simulate the postmaster being killed (e.g. `kill <postmaster pid>`).
    instance.currentChild.kill(null, "SIGKILL");

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0];
    expect(message).toBe("embedded-postgres-exit");
    expect(payload).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      uptimeMs: 3_500,
      port: 54329,
      dataDir: "/tmp/pgdata",
    });
  });

  it("captures a numeric exit code when the child exits without a signal", () => {
    const instance = makeFakeInstance();
    const logger = makeLogger();

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_OFF,
      now: () => 0,
    });

    instance.currentChild.kill(1, null);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ exitCode: 1, signal: null });
  });

  it("stays silent when the exit happens during an intentional shutdown", () => {
    const instance = makeFakeInstance();
    const logger = makeLogger();
    let shuttingDown = false;

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => shuttingDown,
      respawn: RESPAWN_ON,
      now: () => 0,
    });

    shuttingDown = true;
    instance.currentChild.kill(0, "SIGINT");

    expect(logger.error).not.toHaveBeenCalled();
    expect(instance.startCalls).toBe(0);
  });

  it("does not respawn when the policy is disabled; defers to the root watchdog", () => {
    const instance = makeFakeInstance();
    const logger = makeLogger();
    const timer = makeManualTimer();

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_OFF,
      now: () => 0,
      scheduleTimer: timer.scheduleTimer,
    });

    instance.currentChild.kill(null, "SIGKILL");

    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      "embedded-postgres-exit",
    );
    expect(timer.scheduled).toHaveLength(0);
    expect(instance.startCalls).toBe(0);
  });

  it("respawns the PG child with backoff and re-arms the supervisor on the new child", async () => {
    const instance = makeFakeInstance();
    const logger = makeLogger();
    const timer = makeManualTimer();

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_ON,
      now: () => 0,
      scheduleTimer: timer.scheduleTimer,
    });

    // First death → schedule respawn (attempt 1, base delay).
    instance.currentChild.kill(null, "SIGKILL");
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0].ms).toBe(100);

    await timer.runNext();
    expect(instance.startCalls).toBe(1);

    // The supervisor must now watch the freshly respawned child.
    instance.currentChild.kill(null, "SIGSEGV");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGSEGV" }),
      "embedded-postgres-exit",
    );
    // A successful respawn resets the attempt counter → back to base delay.
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0].ms).toBe(100);
  });

  it("gives up after the respawn attempt cap and leaves the root watchdog as fallback", async () => {
    const instance = makeFakeInstance();
    instance.startImpl = async () => {
      throw new Error("respawn failed");
    };
    const logger = makeLogger();
    const timer = makeManualTimer();

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_ON,
      now: () => 0,
      scheduleTimer: timer.scheduleTimer,
    });

    // Initial death schedules attempt 1.
    instance.currentChild.kill(null, "SIGKILL");
    // Each failed start reschedules until the cap (maxAttempts = 3) is hit.
    await timer.runNext(); // attempt 1 fails → schedule 2
    await timer.runNext(); // attempt 2 fails → schedule 3
    await timer.runNext(); // attempt 3 fails → cap reached, no reschedule

    expect(instance.startCalls).toBe(3);
    expect(timer.scheduled).toHaveLength(0);
    const gaveUp = logger.error.mock.calls.some(
      ([, msg]) => typeof msg === "string" && msg.includes("attempt cap reached"),
    );
    expect(gaveUp).toBe(true);
  });

  it("warns when there is no child process handle to watch", () => {
    const logger = makeLogger();
    const instance: SupervisableEmbeddedPostgres = {
      process: undefined,
      start: async () => {},
    };

    attachEmbeddedPostgresSupervisor({
      instance,
      logger,
      port: 54329,
      dataDir: "/tmp/pgdata",
      isShuttingDown: () => false,
      respawn: RESPAWN_OFF,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("no child process handle"),
    );
  });
});

describe("readEmbeddedPostgresRespawnPolicyFromEnv", () => {
  it("defaults to disabled respawn (root watchdog fallback)", () => {
    const policy = readEmbeddedPostgresRespawnPolicyFromEnv({});
    expect(policy.enabled).toBe(false);
    expect(policy.maxAttempts).toBe(5);
    expect(policy.baseDelayMs).toBe(500);
    expect(policy.maxDelayMs).toBe(10_000);
  });

  it("enables respawn and honors integer overrides", () => {
    const policy = readEmbeddedPostgresRespawnPolicyFromEnv({
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE: "true",
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_MAX_ATTEMPTS: "7",
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_BASE_DELAY_MS: "250",
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_MAX_DELAY_MS: "20000",
    });
    expect(policy).toEqual({
      enabled: true,
      maxAttempts: 7,
      baseDelayMs: 250,
      maxDelayMs: 20_000,
    });
  });

  it("falls back to defaults for non-integer or non-positive overrides", () => {
    const policy = readEmbeddedPostgresRespawnPolicyFromEnv({
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE: "true",
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_MAX_ATTEMPTS: "notanumber",
      PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_BASE_DELAY_MS: "-5",
    });
    expect(policy.maxAttempts).toBe(5);
    expect(policy.baseDelayMs).toBe(500);
  });
});
