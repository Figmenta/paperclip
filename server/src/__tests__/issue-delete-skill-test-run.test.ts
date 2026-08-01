import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySkills,
  companySkillTestRuns,
  companySkillVersions,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/**
 * FIG-785 §7 regression guard, the behavioural half.
 *
 * Porting FIG-380 to upstream v2026.722.0 met a ninth FK pointing at `issues.id`:
 * `company_skill_test_runs.issue_id`, RESTRICT + notNull, on a table that does not exist at
 * v2026.626.0. RESTRICT blocks a DELETE exactly as NO ACTION does, so without handling it
 * `DELETE /api/issues/:id` 500s for the harness issue of a skill test run.
 *
 * It cannot be detached (notNull) and upstream never hard-deletes such an issue — its own
 * deleteTestRun() soft-deletes the run and calls the row the source of truth. So remove()
 * refuses with a typed 422 while a LIVE run points at the issue, and hard-deletes the run row
 * only once it is already soft-deleted.
 *
 * `issue-delete-fk-coverage.test.ts` pins the FK SET; this file pins the BEHAVIOUR. Without it
 * both branches of that decision are unexecuted by any test.
 */
describeEmbeddedPostgres("issue delete vs skill test run harness issue (FIG-785 §7)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-delete-skill-test-run-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companySkillTestRuns);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedHarnessIssueWithTestRun(input: { runDeletedAt: Date | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const versionId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SkillTester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "demo-skill",
      slug: "demo-skill",
      name: "Demo Skill",
      markdown: "# demo",
    });
    await db.insert(companySkillVersions).values({
      id: versionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 1,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Skill test harness issue",
      status: "done",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      harnessKind: "skill_test",
    });
    await db.insert(companySkillTestRuns).values({
      id: runId,
      companyId,
      skillId,
      skillVersionId: versionId,
      agentId,
      issueId,
      inputSnapshot: "input",
      status: "succeeded",
      deletedAt: input.runDeletedAt,
    });

    return { companyId, issueId, runId };
  }

  it("refuses the delete with a 422 while a live test run still points at the issue", async () => {
    const { issueId, runId } = await seedHarnessIssueWithTestRun({ runDeletedAt: null });
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);

    await expect(svc.remove(issueId)).rejects.toMatchObject({
      status: 422,
      details: { blockingSkillTestRunId: runId },
    });

    // The refusal must be total: neither the issue nor the audit row may be touched.
    const survivingIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(survivingIssue).toBeTruthy();
    const survivingRun = await db
      .select()
      .from(companySkillTestRuns)
      .where(eq(companySkillTestRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(survivingRun).toBeTruthy();
    expect(survivingRun?.deletedAt).toBeNull();
  }, 20_000);

  it("deletes the issue and the run row once the run is already soft-deleted", async () => {
    const { issueId, runId } = await seedHarnessIssueWithTestRun({
      runDeletedAt: new Date("2026-07-30T00:00:00.000Z"),
    });
    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);

    // Would 500 on a bare RESTRICT FK; the soft-deleted row is the one state upstream itself
    // treats as discardable, so remove() clears it inside the same transaction.
    await expect(svc.remove(issueId)).resolves.toBeTruthy();

    const goneIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(goneIssue).toBeNull();
    const goneRun = await db
      .select()
      .from(companySkillTestRuns)
      .where(eq(companySkillTestRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(goneRun).toBeNull();
  }, 20_000);
});
