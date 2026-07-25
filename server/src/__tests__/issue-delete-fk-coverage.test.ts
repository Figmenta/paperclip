import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as dbModule from "@paperclipai/db";

/**
 * FIG-380 regression guard.
 *
 * `DELETE /api/issues/:id` used to return 500 for any issue that had a comment: the
 * `issue_comments.issue_id` FK is NO ACTION, so Postgres rejected the delete. The fix lives in
 * `issuesService.remove()`, which clears every NO ACTION child row inside the delete transaction.
 *
 * That fix is only complete for the tables it knows about. This test pins the set of FKs that
 * point at `issues.id` and that Postgres will NOT resolve on its own, so adding a new child table
 * without `onDelete` fails here — loudly, at build time — instead of silently reintroducing the
 * 500 in production.
 *
 * If this test fails, do not edit the list on its own: handle the new column in
 * `services/issues.ts` `remove()` first (detach if the row outlives the issue, delete if it does
 * not), then add it here.
 */

const HANDLED_BY_REMOVE = [
  // detached (issueId set to null) — ledger/audit rows outlive the issue they were charged to
  "cost_events.issue_id",
  "finance_events.issue_id",
  // detached (re-parented to the removed issue's parent) — tree splice, never a subtree cascade
  "issues.parent_id",
  // deleted — meaningless without the issue
  "feedback_votes.issue_id",
  "issue_comments.issue_id",
  "issue_inbox_archives.issue_id",
  "issue_read_states.issue_id",
  "issue_thread_interactions.issue_id",
];

// Postgres resolves these itself; remove() must not care about them.
const DB_RESOLVED_ACTIONS = new Set(["cascade", "set null", "set default"]);

function collectUnresolvedIssueForeignKeys(): string[] {
  const tables = Object.values(dbModule).filter((value): value is PgTable => is(value, PgTable));
  const unresolved: string[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      if (getTableConfig(reference.foreignTable).name !== "issues") continue;
      if (DB_RESOLVED_ACTIONS.has((foreignKey.onDelete ?? "no action").toLowerCase())) continue;
      for (const column of reference.columns) {
        unresolved.push(`${config.name}.${column.name}`);
      }
    }
  }

  return [...new Set(unresolved)].sort();
}

describe("issue delete FK coverage (FIG-380)", () => {
  it("finds foreign keys pointing at issues.id", () => {
    // Sanity check on the introspection itself: if drizzle stops exposing inline FKs through
    // getTableConfig this test would pass vacuously and guard nothing.
    const tables = Object.values(dbModule).filter((value): value is PgTable => is(value, PgTable));
    const referencingIssues = tables.filter((table) =>
      getTableConfig(table).foreignKeys.some(
        (fk) => getTableConfig(fk.reference().foreignTable).name === "issues",
      ),
    );
    expect(referencingIssues.length).toBeGreaterThan(10);
  });

  it("every FK Postgres will not resolve on its own is handled by issuesService.remove()", () => {
    expect(collectUnresolvedIssueForeignKeys()).toEqual([...HANDLED_BY_REMOVE].sort());
  });
});
