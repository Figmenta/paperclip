// FIG-763 F3 — Binding invariant probe.
//
// SQL-only check that catches the entire binding_missing class without a live
// secret resolution. For every agents.adapter_config.env.{KEY} of shape
// { type:'secret_ref', secretId }, asserts that a matching company_secret_bindings
// row exists. Fails loud with non-zero exit + a report of every gap.
//
// Usage:
//   DATABASE_URL=... tsx scripts/probe-binding-invariant.ts
//
// Exit 0 = all bindings present. Exit 1 = at least one missing.

import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const QUERY = sql`
WITH ref AS (
  SELECT a.id::text AS agent_id, a.company_id::text AS company_id, kv.key AS env_key,
         (kv.value->>'secretId')::uuid AS secret_id,
         'adapter_config.env.' || kv.key AS config_path
  FROM agents a,
       LATERAL jsonb_each(COALESCE(a.adapter_config->'env', '{}'::jsonb)) AS kv(key, value)
  WHERE jsonb_typeof(kv.value) = 'object'
    AND kv.value->>'type' = 'secret_ref'
    AND kv.value->>'secretId' IS NOT NULL
)
SELECT ref.agent_id, ref.company_id, ref.env_key, ref.secret_id::text AS secret_id, ref.config_path
FROM ref
LEFT JOIN company_secret_bindings b
  ON b.company_id::text = ref.company_id
 AND b.secret_id = ref.secret_id
 AND b.target_type = 'agent'
 AND b.target_id = ref.agent_id
 AND b.config_path = ref.config_path
WHERE b.id IS NULL
ORDER BY ref.company_id, ref.agent_id, ref.env_key
`;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createDb(dbUrl);
  const result = await db.execute(QUERY);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    console.log(JSON.stringify({ ok: true, missing: 0 }));
    process.exit(0);
  }
  console.error(
    JSON.stringify({ ok: false, missing: list.length, sample: list.slice(0, 10) }, null, 2),
  );
  process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
