// FIG-763 F3 — Idempotent company_secret_bindings reconcile.
//
// Walks all agents.adapter_config.env across every company. For every env var
// of shape { type: 'secret_ref', secretId } it ensures a company_secret_bindings
// row exists keyed by (company_id, secret_id, target_type='agent',
// target_id=agent_id, config_path='adapter_config.env.{KEY}'), version_selector='latest',
// required=true.
//
// Versions figos's manual 2026-05-29 backfill. Safe to run repeatedly. Designed to be
// invoked as the post-migrate / post-restart step inside deploy-paperclip.sh.
//
// Usage:
//   DATABASE_URL=... tsx scripts/reconcile-bindings.ts              # dry-run
//   DATABASE_URL=... tsx scripts/reconcile-bindings.ts --apply --label deploy-2026-05-29
//
// Exit code 0 on success, 1 on error, 2 on validation gaps (apply mode only).

import { agents, companySecretBindings, companySecrets, createDb } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

type SecretRef = { type: "secret_ref"; secretId: string; version?: number | "latest" };

function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.type === "secret_ref" && typeof v.secretId === "string" && v.secretId.length > 0;
}

function asEnvRecord(adapterConfig: unknown): Record<string, unknown> | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return null;
  const env = (adapterConfig as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  return env as Record<string, unknown>;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const labelIdx = process.argv.indexOf("--label");
  const label = labelIdx >= 0 ? process.argv[labelIdx + 1] : `reconcile-${new Date().toISOString()}`;

  const db = createDb(dbUrl);
  const allAgents = await db.select().from(agents);

  let inspected = 0;
  let candidateRefs = 0;
  let missingSecret = 0;
  let alreadyBound = 0;
  let upserted = 0;

  for (const agent of allAgents) {
    inspected += 1;
    const env = asEnvRecord(agent.adapterConfig);
    if (!env) continue;

    for (const [key, raw] of Object.entries(env)) {
      if (!isSecretRef(raw)) continue;
      candidateRefs += 1;
      const ref = raw;
      const configPath = `adapter_config.env.${key}`;

      // Validate the secret exists in the same company.
      const secretRow = await db
        .select({ id: companySecrets.id, companyId: companySecrets.companyId })
        .from(companySecrets)
        .where(eq(companySecrets.id, ref.secretId))
        .then((r) => r[0] ?? null);
      if (!secretRow || secretRow.companyId !== agent.companyId) {
        console.warn(
          `[WARN] agent=${agent.id} configPath=${configPath} secretId=${ref.secretId} not found in company ${agent.companyId}`,
        );
        missingSecret += 1;
        continue;
      }

      const existing = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, agent.companyId),
            eq(companySecretBindings.targetType, "agent"),
            eq(companySecretBindings.targetId, agent.id),
            eq(companySecretBindings.configPath, configPath),
          ),
        )
        .then((r) => r[0] ?? null);

      const versionSelector =
        typeof ref.version === "number" ? String(ref.version) : "latest";

      if (existing && existing.secretId === ref.secretId && existing.versionSelector === versionSelector) {
        alreadyBound += 1;
        continue;
      }

      if (apply) {
        if (existing) {
          await db
            .update(companySecretBindings)
            .set({
              secretId: ref.secretId,
              versionSelector,
              required: true,
              label,
              updatedAt: new Date(),
            })
            .where(eq(companySecretBindings.id, existing.id));
        } else {
          await db.insert(companySecretBindings).values({
            companyId: agent.companyId,
            secretId: ref.secretId,
            targetType: "agent",
            targetId: agent.id,
            configPath,
            versionSelector,
            required: true,
            label,
          });
        }
        upserted += 1;
      } else {
        console.log(
          `[DRY-RUN] would upsert binding: company=${agent.companyId} agent=${agent.id} configPath=${configPath} secretId=${ref.secretId} version=${versionSelector}`,
        );
        upserted += 1;
      }
    }
  }

  console.log(
    JSON.stringify(
      { inspected, candidateRefs, alreadyBound, upserted, missingSecret, apply, label },
      null,
      2,
    ),
  );

  if (missingSecret > 0) {
    console.error(`[FAIL] ${missingSecret} secret_ref(s) point to a secret missing/cross-company`);
    process.exit(2);
  }
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
