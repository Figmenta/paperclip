import type { ChildProcess } from "node:child_process";

/**
 * The embedded-postgres library (`embedded-postgres@18.1.0-beta.16`) manages the
 * postmaster as an unmanaged child process exposed on `instance.process`. The
 * library only observes that child during `start()` (a `close` listener that
 * rejects the start promise); once the server is up nothing watches the child.
 * If the postmaster dies mid-run, the Node process only finds out when the next
 * query fails with `ECONNREFUSED`, and the exit code + signal are lost.
 *
 * This supervisor attaches a persistent `exit` listener to the postmaster child
 * so an UNEXPECTED death is logged with `{ exitCode, signal, uptimeMs }` under
 * the `embedded-postgres-exit` tag, and (optionally) triggers a targeted respawn
 * of just the PG child — without restarting the whole Node process.
 */

/** Minimal shape of the embedded-postgres instance this supervisor needs. */
export interface SupervisableEmbeddedPostgres {
  /** The postmaster child process, assigned by the library's `start()`. */
  process?: ChildProcess | undefined;
  /** Re-spawns the postmaster with the same options. */
  start(): Promise<void>;
}

/** Structural subset of the pino logger used here. */
export interface EmbeddedPostgresSupervisorLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface EmbeddedPostgresRespawnPolicy {
  /** When false, only exit-logging happens; the root watchdog remains the fallback. */
  enabled: boolean;
  /** Maximum consecutive respawn attempts before giving up. */
  maxAttempts: number;
  /** First backoff delay; doubled each attempt up to `maxDelayMs`. */
  baseDelayMs: number;
  /** Upper bound on the backoff delay. */
  maxDelayMs: number;
}

export interface AttachEmbeddedPostgresSupervisorOptions {
  instance: SupervisableEmbeddedPostgres;
  logger: EmbeddedPostgresSupervisorLogger;
  port: number;
  dataDir: string;
  /**
   * Returns true when the Node process is intentionally shutting the cluster
   * down (SIGINT/SIGTERM handler). An exit seen while this is true is expected
   * and must NOT be logged as a failure nor trigger a respawn.
   */
  isShuttingDown: () => boolean;
  respawn?: EmbeddedPostgresRespawnPolicy;
  /** Injectable clock (defaults to Date.now) — keeps the module unit-testable. */
  now?: () => number;
  /** Injectable timer (defaults to setTimeout) — keeps the module unit-testable. */
  scheduleTimer?: (cb: () => void, ms: number) => void;
}

export const DEFAULT_EMBEDDED_POSTGRES_RESPAWN_POLICY: EmbeddedPostgresRespawnPolicy = {
  enabled: false,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

/**
 * Reads the respawn policy from the environment. Targeted respawn is opt-in
 * (`PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE=true`) so the default runtime behavior
 * — root watchdog restarts the whole process — is unchanged until deliberately
 * enabled.
 */
export function readEmbeddedPostgresRespawnPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedPostgresRespawnPolicy {
  const enabled = env.PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE === "true";
  const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    enabled,
    maxAttempts: parsePositiveInt(
      env.PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_MAX_ATTEMPTS,
      DEFAULT_EMBEDDED_POSTGRES_RESPAWN_POLICY.maxAttempts,
    ),
    baseDelayMs: parsePositiveInt(
      env.PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_BASE_DELAY_MS,
      DEFAULT_EMBEDDED_POSTGRES_RESPAWN_POLICY.baseDelayMs,
    ),
    maxDelayMs: parsePositiveInt(
      env.PAPERCLIP_EMBEDDED_POSTGRES_SUPERVISE_MAX_DELAY_MS,
      DEFAULT_EMBEDDED_POSTGRES_RESPAWN_POLICY.maxDelayMs,
    ),
  };
}

/**
 * Attach a persistent exit supervisor to the running embedded-postgres child.
 * Call this once, right after `instance.start()` has resolved.
 */
export function attachEmbeddedPostgresSupervisor(
  options: AttachEmbeddedPostgresSupervisorOptions,
): void {
  const {
    instance,
    logger,
    port,
    dataDir,
    isShuttingDown,
    respawn = DEFAULT_EMBEDDED_POSTGRES_RESPAWN_POLICY,
    now = () => Date.now(),
    scheduleTimer = (cb, ms) => {
      const timer = setTimeout(cb, ms);
      // Do not keep the event loop alive solely for a pending respawn.
      (timer as { unref?: () => void }).unref?.();
    },
  } = options;

  let startedAt = now();
  let respawnAttempts = 0;

  const backoffDelayMs = (attempt: number): number =>
    Math.min(respawn.maxDelayMs, respawn.baseDelayMs * 2 ** attempt);

  const scheduleRespawn = (): void => {
    if (respawnAttempts >= respawn.maxAttempts) {
      logger.error(
        { port, dataDir, respawnAttempts, maxAttempts: respawn.maxAttempts },
        "embedded-postgres supervisor: respawn attempt cap reached; giving up (root watchdog remains the fallback)",
      );
      return;
    }

    const delayMs = backoffDelayMs(respawnAttempts);
    const attempt = respawnAttempts + 1;
    respawnAttempts = attempt;
    logger.warn(
      { port, dataDir, attempt, maxAttempts: respawn.maxAttempts, delayMs },
      "embedded-postgres supervisor: scheduling targeted respawn of PG child",
    );

    scheduleTimer(() => {
      // A shutdown may have begun while the backoff timer was pending.
      if (isShuttingDown()) {
        return;
      }
      void instance
        .start()
        .then(() => {
          startedAt = now();
          respawnAttempts = 0;
          logger.warn(
            { port, dataDir, attempt },
            "embedded-postgres supervisor: PG child respawned successfully",
          );
          // Watch the freshly spawned child.
          attach();
        })
        .catch((err: unknown) => {
          logger.error(
            { err, port, dataDir, attempt, maxAttempts: respawn.maxAttempts },
            "embedded-postgres supervisor: targeted respawn failed",
          );
          if (!isShuttingDown()) {
            scheduleRespawn();
          }
        });
    }, delayMs);
  };

  function attach(): void {
    const child = instance.process;
    if (!child) {
      logger.warn(
        { port, dataDir },
        "embedded-postgres supervisor: no child process handle to watch",
      );
      return;
    }

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      // Expected exit during an intentional cluster shutdown: stay silent.
      if (isShuttingDown()) {
        return;
      }

      const uptimeMs = now() - startedAt;
      logger.error(
        { exitCode: code, signal, uptimeMs, port, dataDir, respawnAttempt: respawnAttempts },
        "embedded-postgres-exit",
      );

      if (!respawn.enabled) {
        logger.warn(
          { port, dataDir },
          "embedded-postgres supervisor: targeted respawn disabled; relying on root watchdog to recover",
        );
        return;
      }

      scheduleRespawn();
    });
  }

  attach();
}
