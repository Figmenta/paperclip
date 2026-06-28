import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, boardApiKeys, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boardAuthService } from "../services/board-auth.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board service-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * FIG-1673 — SERVICE-class board keys are non-expiring (expires_at NULL) and a
 * distinct, queryable class from the expiring HUMAN_CLI keys. These tests
 * exercise the full mint path (challenge → approve) against a real database and
 * assert the DoD: a service key validates with a NULL expires_at and never
 * expires, and the class is distinguishable in board_api_keys.
 */
describeEmbeddedPostgres("board API key service class (FIG-1673)", () => {
  let db!: ReturnType<typeof createDb>;
  let boardAuth!: ReturnType<typeof boardAuthService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-service-key-");
    db = createDb(tempDb.connectionString);
    boardAuth = boardAuthService(db);

    userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Service Key Approver",
      email: `approver-${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function mintApprovedKey(keyClass: "human_cli" | "service" | undefined) {
    const created = await boardAuth.createCliAuthChallenge({
      command: `mint ${keyClass ?? "default"}`,
      clientName: `client-${keyClass ?? "default"}`,
      requestedAccess: "board",
      keyClass,
    });

    const result = await boardAuth.approveCliAuthChallenge(
      created.challenge.id,
      created.challengeSecret,
      userId,
    );
    expect(result.status).toBe("approved");
    const keyId = result.challenge.boardApiKeyId;
    expect(keyId).toBeTruthy();

    const row = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, keyId!))
      .then((rows) => rows[0]);

    return { token: created.pendingBoardToken, row };
  }

  it("mints a non-expiring service key that validates (DoD)", async () => {
    const { token, row } = await mintApprovedKey("service");

    // Class is distinguishable + the key never expires.
    expect(row?.keyClass).toBe("service");
    expect(row?.expiresAt).toBeNull();

    // Validation honors the NULL expires_at — the key resolves (HTTP-200 path).
    const validated = await boardAuth.findBoardApiKeyByToken(token);
    expect(validated?.id).toBe(row?.id);
    expect(validated?.keyClass).toBe("service");
    expect(validated?.expiresAt).toBeNull();
  });

  it("defaults to an expiring human_cli key when no class is requested", async () => {
    const { token, row } = await mintApprovedKey(undefined);

    expect(row?.keyClass).toBe("human_cli");
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row?.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const validated = await boardAuth.findBoardApiKeyByToken(token);
    expect(validated?.id).toBe(row?.id);
    expect(validated?.keyClass).toBe("human_cli");
  });

  it("surfaces the requested class on the challenge describe view", async () => {
    const created = await boardAuth.createCliAuthChallenge({
      command: "describe service",
      requestedAccess: "board",
      keyClass: "service",
    });
    const described = await boardAuth.describeCliAuthChallenge(
      created.challenge.id,
      created.challengeSecret,
    );
    expect(described?.keyClass).toBe("service");
  });
});
