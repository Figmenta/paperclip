import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import type { BoardApiKeyClass } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";

export const BOARD_API_KEY_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const CLI_AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * Independent restatement of the board API key lifetime policy (180 days),
 * used as a startup tripwire by {@link assertBoardApiKeyTtlPolicy}.
 *
 * Why it exists (FIG-1672): `server/dist/` is a gitignored build artifact and
 * the server `start` script runs `node dist/index.js`. A stale `dist/` built
 * from an older `src` (when this TTL was 30 days) would silently regress the
 * board key lifetime with no signal. This constant plus the startup assertion
 * turn that silent drift into a loud startup failure.
 *
 * If you are deliberately changing the policy, update BOTH this value and
 * {@link BOARD_API_KEY_TTL_MS} above.
 */
const BOARD_API_KEY_TTL_POLICY_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Fails loud at startup if the effective board API key TTL has drifted from
 * policy. Accepts the effective value as an argument (defaulting to the live
 * {@link BOARD_API_KEY_TTL_MS}) so the invariant is unit-testable for both the
 * matching and mismatching cases. See FIG-1672.
 */
export function assertBoardApiKeyTtlPolicy(effectiveTtlMs: number = BOARD_API_KEY_TTL_MS): void {
  if (effectiveTtlMs !== BOARD_API_KEY_TTL_POLICY_MS) {
    const dayMs = 24 * 60 * 60 * 1000;
    throw new Error(
      `Board API key TTL policy violation: effective BOARD_API_KEY_TTL_MS=${effectiveTtlMs}ms ` +
        `(${effectiveTtlMs / dayMs}d) does not match required policy ` +
        `${BOARD_API_KEY_TTL_POLICY_MS}ms (${BOARD_API_KEY_TTL_POLICY_MS / dayMs}d). This usually means a ` +
        `stale build is being served (e.g. 'node dist/index.js' against an outdated dist). Rebuild the ` +
        `server with 'pnpm --filter @paperclipai/server build' so dist matches src. (FIG-1672)`,
    );
  }
}

export type CliAuthChallengeStatus = "pending" | "approved" | "cancelled" | "expired";

export function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createBoardApiToken() {
  return `pcp_board_${randomBytes(24).toString("hex")}`;
}

export function createCliAuthSecret() {
  return `pcp_cli_auth_${randomBytes(24).toString("hex")}`;
}

export function boardApiKeyExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + BOARD_API_KEY_TTL_MS);
}

export function cliAuthChallengeExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + CLI_AUTH_CHALLENGE_TTL_MS);
}

function challengeStatusForRow(row: typeof cliAuthChallenges.$inferSelect): CliAuthChallengeStatus {
  if (row.cancelledAt) return "cancelled";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  if (row.approvedAt && row.boardApiKeyId) return "approved";
  return "pending";
}

export function boardAuthService(db: Db) {
  async function resolveBoardAccess(userId: string) {
    const [user, memberships, adminRole] = await Promise.all([
      db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows),
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      user,
      companyIds: memberships.map((row) => row.companyId),
      memberships,
      isInstanceAdmin: Boolean(adminRole),
    };
  }

  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    const access = await resolveBoardAccess(input.userId);
    const companyIds = new Set(access.companyIds);

    if (companyIds.size === 0 && input.requestedCompanyId?.trim()) {
      companyIds.add(input.requestedCompanyId.trim());
    }

    if (companyIds.size === 0 && input.boardApiKeyId?.trim()) {
      const challengeCompanyIds = await db
        .select({ requestedCompanyId: cliAuthChallenges.requestedCompanyId })
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.boardApiKeyId, input.boardApiKeyId.trim()))
        .then((rows) =>
          rows
            .map((row) => row.requestedCompanyId?.trim() ?? null)
            .filter((value): value is string => Boolean(value)),
        );
      for (const companyId of challengeCompanyIds) {
        companyIds.add(companyId);
      }
    }

    if (companyIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id));
      for (const companyId of allCompanyIds) {
        companyIds.add(companyId);
      }
    }

    return Array.from(companyIds);
  }

  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    const now = new Date();
    return db
      .select()
      .from(boardApiKeys)
      .where(
        and(
          eq(boardApiKeys.keyHash, tokenHash),
          isNull(boardApiKeys.revokedAt),
        ),
      )
      .then((rows) => rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null);
  }

  async function touchBoardApiKey(id: string) {
    await db.update(boardApiKeys).set({ lastUsedAt: new Date() }).where(eq(boardApiKeys.id, id));
  }

  async function revokeBoardApiKey(id: string) {
    const now = new Date();
    return db
      .update(boardApiKeys)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(and(eq(boardApiKeys.id, id), isNull(boardApiKeys.revokedAt)))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createNamedBoardApiKey(input: {
    userId: string;
    name: string;
    expiresAt?: Date | null;
  }) {
    const token = createBoardApiToken();
    const created = await db
      .insert(boardApiKeys)
      .values({
        userId: input.userId,
        name: input.name.trim(),
        keyHash: hashBearerToken(token),
        expiresAt: input.expiresAt === undefined ? boardApiKeyExpiresAt() : input.expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      id: created.id,
      name: created.name,
      token,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
      revokedAt: created.revokedAt,
      expiresAt: created.expiresAt,
    };
  }

  async function listBoardApiKeys(
    userId: string,
    opts: { includeInactive?: boolean } = {},
  ) {
    const conditions = [eq(boardApiKeys.userId, userId)];
    if (!opts.includeInactive) {
      const activeExpirationCondition = or(
        isNull(boardApiKeys.expiresAt),
        gt(boardApiKeys.expiresAt, new Date()),
      );
      conditions.push(
        isNull(boardApiKeys.revokedAt),
      );
      if (activeExpirationCondition) conditions.push(activeExpirationCondition);
    }
    return db
      .select({
        id: boardApiKeys.id,
        name: boardApiKeys.name,
        createdAt: boardApiKeys.createdAt,
        lastUsedAt: boardApiKeys.lastUsedAt,
        revokedAt: boardApiKeys.revokedAt,
        expiresAt: boardApiKeys.expiresAt,
      })
      .from(boardApiKeys)
      .where(and(...conditions))
      .orderBy(sql`${boardApiKeys.createdAt} desc`);
  }

  async function getBoardApiKeyForUser(keyId: string, userId: string) {
    return db
      .select({
        id: boardApiKeys.id,
        userId: boardApiKeys.userId,
        name: boardApiKeys.name,
        createdAt: boardApiKeys.createdAt,
        lastUsedAt: boardApiKeys.lastUsedAt,
        revokedAt: boardApiKeys.revokedAt,
        expiresAt: boardApiKeys.expiresAt,
      })
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
  }

  async function createCliAuthChallenge(input: {
    command: string;
    clientName?: string | null;
    requestedAccess: "board" | "instance_admin_required";
    keyClass?: BoardApiKeyClass | null;
    requestedCompanyId?: string | null;
  }) {
    const keyClass: BoardApiKeyClass = input.keyClass === "service" ? "service" : "human_cli";
    const challengeSecret = createCliAuthSecret();
    const pendingBoardToken = createBoardApiToken();
    const expiresAt = cliAuthChallengeExpiresAt();
    const labelBase = input.clientName?.trim() || "paperclipai cli";
    const pendingKeyName =
      input.requestedAccess === "instance_admin_required"
        ? `${labelBase} (instance admin)`
        : `${labelBase} (board)`;

    const created = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: input.command.trim(),
        clientName: input.clientName?.trim() || null,
        requestedAccess: input.requestedAccess,
        keyClass,
        requestedCompanyId: input.requestedCompanyId?.trim() || null,
        pendingKeyHash: hashBearerToken(pendingBoardToken),
        pendingKeyName,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      challenge: created,
      challengeSecret,
      pendingBoardToken,
    };
  }

  async function getCliAuthChallenge(id: string) {
    return db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getCliAuthChallengeBySecret(id: string, token: string) {
    const challenge = await getCliAuthChallenge(id);
    if (!challenge) return null;
    if (!tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) return null;
    return challenge;
  }

  async function describeCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) return null;

    const [company, approvedBy] = await Promise.all([
      challenge.requestedCompanyId
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(eq(companies.id, challenge.requestedCompanyId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      challenge.approvedByUserId
        ? db
            .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, challenge.approvedByUserId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    return {
      id: challenge.id,
      status: challengeStatusForRow(challenge),
      command: challenge.command,
      clientName: challenge.clientName ?? null,
      requestedAccess: challenge.requestedAccess as "board" | "instance_admin_required",
      keyClass: (challenge.keyClass === "service" ? "service" : "human_cli") as BoardApiKeyClass,
      requestedCompanyId: challenge.requestedCompanyId ?? null,
      requestedCompanyName: company?.name ?? null,
      approvedAt: challenge.approvedAt?.toISOString() ?? null,
      cancelledAt: challenge.cancelledAt?.toISOString() ?? null,
      expiresAt: challenge.expiresAt.toISOString(),
      approvedByUser: approvedBy
        ? {
            id: approvedBy.id,
            name: approvedBy.name,
            email: approvedBy.email,
          }
        : null,
    };
  }

  async function approveCliAuthChallenge(id: string, token: string, userId: string) {
    const access = await resolveBoardAccess(userId);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`,
      );

      const challenge = await tx
        .select()
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id))
        .then((rows) => rows[0] ?? null);
      if (!challenge || !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) {
        throw notFound("CLI auth challenge not found");
      }

      const status = challengeStatusForRow(challenge);
      if (status === "expired") return { status, challenge };
      if (status === "cancelled") return { status, challenge };

      if (challenge.requestedAccess === "instance_admin_required" && !access.isInstanceAdmin) {
        throw forbidden("Instance admin required");
      }

      let boardKeyId = challenge.boardApiKeyId;
      if (!boardKeyId) {
        // SERVICE-class keys are non-expiring (expires_at NULL); HUMAN_CLI keys
        // carry the board-key TTL. Validation (findBoardApiKeyByToken) already
        // honors a NULL expires_at as "never expires". The human approval step
        // above gates every mint regardless of class. See FIG-1673.
        const isServiceKey = challenge.keyClass === "service";
        const createdKey = await tx
          .insert(boardApiKeys)
          .values({
            userId,
            name: challenge.pendingKeyName,
            keyHash: challenge.pendingKeyHash,
            keyClass: isServiceKey ? "service" : "human_cli",
            expiresAt: isServiceKey ? null : boardApiKeyExpiresAt(),
          })
          .returning()
          .then((rows) => rows[0]);
        boardKeyId = createdKey.id;
      }

      const approvedAt = challenge.approvedAt ?? new Date();
      const updated = await tx
        .update(cliAuthChallenges)
        .set({
          approvedByUserId: userId,
          boardApiKeyId: boardKeyId,
          approvedAt,
          updatedAt: new Date(),
        })
        .where(eq(cliAuthChallenges.id, challenge.id))
        .returning()
        .then((rows) => rows[0] ?? challenge);

      return { status: "approved" as const, challenge: updated };
    });
  }

  async function cancelCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const status = challengeStatusForRow(challenge);
    if (status === "approved") return { status, challenge };
    if (status === "expired") return { status, challenge };
    if (status === "cancelled") return { status, challenge };

    const updated = await db
      .update(cliAuthChallenges)
      .set({
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cliAuthChallenges.id, challenge.id))
      .returning()
      .then((rows) => rows[0] ?? challenge);

    return { status: "cancelled" as const, challenge: updated };
  }

  async function assertCurrentBoardKey(keyId: string | undefined, userId: string | undefined) {
    if (!keyId || !userId) throw conflict("Board API key context is required");
    const key = await db
      .select()
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
    if (!key || key.revokedAt) throw notFound("Board API key not found");
    return key;
  }

  return {
    resolveBoardAccess,
    findBoardApiKeyByToken,
    touchBoardApiKey,
    revokeBoardApiKey,
    createNamedBoardApiKey,
    listBoardApiKeys,
    getBoardApiKeyForUser,
    createCliAuthChallenge,
    getCliAuthChallengeBySecret,
    describeCliAuthChallenge,
    approveCliAuthChallenge,
    cancelCliAuthChallenge,
    assertCurrentBoardKey,
    resolveBoardActivityCompanyIds,
  };
}
