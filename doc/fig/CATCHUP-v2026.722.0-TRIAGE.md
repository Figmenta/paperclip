# Catchup triage — fig layer vs upstream `v2026.722.0`

Refs FIG-454 (step 1 of 2). Read-only analysis: **prod was not modified**.

- Prod base: `fig/v2026.626.0-r7`, HEAD `707457f88`, detached, clean tree (`/home/ivan/paperclip2-prod`).
- Target base: upstream `v2026.722.0`.
- Delta `v2026.626.0..v2026.722.0`: 349 commits, 1852 files, +325394/-22554.
- fig layer: 10 commits / 8 logical patches over 13 files, +1169/-7.
- Method: every upstream claim below is a line in `git show v2026.722.0:<path>`, read from a scratch
  clone (`git clone --local --shared` → `git checkout v2026.722.0`). Line numbers are `v2026.722.0`
  unless a line is explicitly labelled `v2026.626.0` or prod HEAD `707457f88`.
- Where this document lives: `Figmenta/paperclip` `master`, which descends from
  `canary/v2026.525.0-canary.1` and contains **neither** the prod line (none of the eight fig commits
  is an ancestor of `master`) **nor** `v2026.626.0`/`v2026.722.0`. `master` is a home for the document,
  not for the port. Step 2 branches from `v2026.722.0`, not from here.

## Headline

**Zero patches were absorbed by upstream. All eight are still necessary — five port as-is; three need work
(§2 a design call, §3 which rides with it, §7 a small extension); one sub-change inside §5 is dead code and
should be dropped.**

The premise that made this look expensive — "upstream rewrote the subsystems we patched" — is true of
the *file* churn and false of the *anchor* sites. `heartbeat.ts` took +5016/-417 and `routes/issues.ts`
+2680/-506 across the delta, but four of the exact regions the fig layer hooks into are **byte-identical
between `v2026.626.0` and `v2026.722.0`**:

| region | v626 vs v722 |
|---|---|
| `routes/issues.ts` `shouldImplicitlyMoveCommentedIssueToTodo` | identical |
| `routes/issues.ts` `shouldHumanCommentResumeInProgressScheduledRetry` | identical |
| `recovery/service.ts` `reconcileUnassignedBlockingIssues` | identical |
| `services/issues.ts` `remove:` | identical |

So the porting cost is **not** distributed like the churn. Five of the eight patches re-apply mechanically
(§1, §4, §5, §6, §8).

Upstream moved under a patch in exactly two places, and they are not the same kind of problem:

- **FIG-132's hard-TTL reaper** (§2) — upstream added two skip conditions the patch would step over.
  This one needs a *decision*, not a merge.
- **FIG-380's delete-FK cleanup** (§7) — upstream added a ninth blocking FK to `issues.id`
  (`company_skill_test_runs.issue_id`, `RESTRICT`) that the patch does not know about. Mechanical to
  find, small to fix, but it is a code change, not a verbatim re-apply, and the fig regression test
  that pins this set goes red on the new base until it is done.

## Verdicts

| # | Patch | Verdict | Port cost |
|---|---|---|---|
| 1 | FIG-67 fail-loud wake | still necessary | low, mechanical |
| 2 | FIG-132 hard-TTL reaper (heartbeat) | still necessary — **needs rework** | high: 2 new upstream guards to reconcile |
| 2b | FIG-132 bounded `unassigned_blocker_recovery` | still necessary | low, verbatim |
| 3 | orphan backstop must not preempt the agent's own timeout | still necessary | rides with #2 |
| 4 | `PAPERCLIP_RECOVERY_OWNER_DISABLED` kill switch | still necessary | low, verbatim |
| 5 | FIG-352 (`86239be0e`) — 2 more kill-switch guards + 1 flip | still necessary (2 of 3 sub-changes) | low — **drop the flip, it is dead code** |
| 6 | FIG-276 board_key comments inert on terminal issues | still necessary | low, verbatim |
| 7 | FIG-380 delete FK | still necessary — **needs one added cleanup** | low for the 8 known FKs; **+1 new FK** (`RESTRICT`, `notNull`) needs a design call and turns the fig FK test red until fixed |
| 8 | coder image attachments | still necessary | low, verbatim |

---

### 1. FIG-67 — fail loud when an issue-assignment wake refuses a non-invokable assignee

**Still necessary.** Upstream `services/issue-assignment-wakeup.ts` is still 57 lines and still ends in
the swallow this patch exists to kill:

```
services/issue-assignment-wakeup.ts:53
  logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
```

The 409 the patch parses is unchanged: `services/heartbeat.ts:15347-15352` still throws
`conflict(invokability.message, { status: agent.status, reason: invokability.reason, ... })`, and
`services/agent-invokability.ts:13-23` (`AgentInvokabilityBlockReason`) is byte-identical to v626 — so
the patch's hardcoded `INVOKABILITY_BLOCK_REASONS` set of 10 reasons is still exhaustive and still in sync.

Upstream has a *partial*, non-issue-visible equivalent — `heartbeat.ts:15343`
`writeSkippedRequest("agent.not_invokable", …)` — but it already existed at v626 (`heartbeat.ts:11049`),
it writes a skipped-request row, and nothing of it reaches the issue thread. Nothing was absorbed.

**Port.** Two deltas vs v626, both trivial: the upstream file gained an optional `taskKey` (threaded into
`payload` and `contextSnapshot`), and the four `queueIssueAssignmentWakeup` call sites in `routes/issues.ts`
that need the extra `db` argument move to **`7178/7344/7547/9181`**. Those four sites are at
`5284/5444/5645/7137` on prod HEAD `707457f88` — the tree that actually carries the `db,` argument — and at
`5265/5424/5624/7113` on stock `v2026.626.0`. Two further call
sites exist upstream (`services/routines.ts:1857`, `routes/summary-slots.ts:136`); the fig patch degrades
gracefully there (no `db` → structured log without the comment), so passing `db` to them is optional
hardening, not a port requirement.

### 2. FIG-132 — hard-TTL reaper backstop

**Still necessary, and this is the one that needs rework.**

Necessary: `services/heartbeat.ts:11347` is still `async function reapOrphanedRuns(opts?: { staleThresholdMs?: number })`
— no absolute-age ceiling anywhere. The guards the patch deliberately preempts are intact at 11388-11412
(`runningProcesses.has(run.id) || activeRunExecutions.has(run.id)`, `isProcessAlive`, `DETACHED_PROCESS_ERROR_CODE`),
so an orphaned run can still hold an issue checkout indefinitely (the FIG-131 symptom).

Every helper the patch calls survives, same names, same file: `setRunStatus` (7554),
`classifyAndPersistRunLiveness` (11327), `releaseEnvironmentLeasesForRun` (5772),
`releaseIssueExecutionAndPromote` (14370), `appendRunEvent` (8174), `nextRunEventSeq` (8255),
`finalizeAgentStatus` (11071), `mergeRunStopMetadataForAgent` (11130), `startNextQueuedRunForAgent` (11681).
The freshness columns it reads (`lastOutputAt`, `lastUsefulActionAt`, `updatedAt`, `startedAt`) all still exist.

**But upstream added two new skip conditions inside the same loop, and the patch inserts itself *above* both:**

1. **Monitor runs.** `heartbeat.ts:11362-11383` pre-loads `monitorNextCheckAtByIssue`, and 11441-11447 uses it:
   a lost `issue_monitor_due` dispatch with no future wake now sets `shouldRetry` so the monitor is re-armed.
   The hard-TTL branch finalizes with `releaseIssueExecutionAndPromote` and explicitly does **not** queue a
   process-loss retry — so porting it as-is means a monitor run past the ceiling is reaped **without** its
   monitor being re-armed. Silent death of a monitor, introduced by the port.
2. **Hot-restart adoption.** `heartbeat.ts:11399-11403`: a run with a live pid/pgid carrying
   `readHotRestartAdoptionMetadata(...)` is skipped, because it was legitimately adopted across a restart.
   The hard-TTL branch would kill an adopted long-running run at 30m.

Neither condition existed at v626. This is exactly the "forcing a patch onto a rewritten subsystem
reintroduces a bug" case, and it is the only one of the eight where the reintroduced bug would be
**silent** — nothing in the test net fails, the monitor simply stops. §7 is the other place upstream moved
under a patch, but there the failure is a loud 500 and the fig FK test goes red on the new base first.

**Port decision required in step 2:** the hard-TTL branch must either (a) run *after* the monitor and
hot-restart classification and reuse upstream's `shouldRetry` decision instead of hard-releasing, or
(b) explicitly exempt `wakeReason === "issue_monitor_due"` and hot-restart-adopted runs. (a) is the
smaller behavioural surface; (b) is the smaller diff. Recommendation: (a).

**2b. Bounded `unassigned_blocker_recovery`** (same commit, `recovery/service.ts`): **verbatim port.**
`reconcileUnassignedBlockingIssues` (`recovery/service.ts:1086-1195`) is byte-identical to v626 — still no
attempt counter, no backoff, no escalation; the insertion point (after the `isAgentInvokable` check, before
`issuesSvc.getRelationSummaries` at 1134) is unchanged, and the escalation helper's dependencies
(`agentWakeupRequests`, `issuesSvc.addComment`, `logActivity`) are all in place.

### 3. Orphan backstop must not preempt an agent's own timeout (`707457f88`, r7)

**Still necessary; ports with #2.** It is a modifier of the same block (`HARD_TTL_AGENT_GRACE_MS`, the
`adapterConfig.timeoutSec`-derived per-run ceiling). The hazard it closes still exists: agents still declare
`timeoutSec` (`services/heartbeat-stop-metadata.ts:70-77` still reads it) and `reapOrphanedRuns` still has no
notion of it, so without this modifier the backstop can kill a run *before* the agent's own graceful timeout
would have ended it and reported on the issue.

### 4. `PAPERCLIP_RECOVERY_OWNER_DISABLED` kill switch (incident 2026-07-23)

**Still necessary, verbatim port.** No upstream equivalent exists: there is no env var and no instance
setting that disables recovery-owner resolution in `v2026.722.0` (the only near-miss,
`services/attention.ts:78` `HUMAN_RECOVERY_OWNER_TYPES`, is a display filter, not a switch).

All four injection points survive, and all four are top-of-function early returns, so the port is
insertion-only regardless of body churn. Two commits carry two guards each — the table says which,
because step 2 cherry-picks by commit:

| site | v2026.722.0 | added by |
|---|---|---|
| `resolveStaleRunOwnerAgentId` | `services/recovery/service.ts:1698` | `337fe1fd1` (original kill switch, `@@ -1454`) |
| `resolveStrandedIssueRecoveryOwnerAgentId` | `services/recovery/service.ts:2414` | `337fe1fd1` (`@@ -2145`) |
| `resolveEscalationOwnerAgentId` | `services/recovery/service.ts:4654` | `86239be0e` (FIG-352, `@@ -3665`) |
| `resolveReviewOwnerAgentId` | `services/productivity-review.ts:582` | `86239be0e` (FIG-352, `@@ -523`) |

`337fe1fd1` is `1 file changed, 6 insertions(+)` — the first two rows only.

### 5. FIG-352 (`86239be0e`) — two more guards, and one sub-change to drop

`86239be0e` is `2 files changed, 7 insertions(+), 1 deletion(-)` and has **three** sub-changes: the last
two guards in the §4 table (`resolveEscalationOwnerAgentId`, `resolveReviewOwnerAgentId`), still necessary
and still insertion-only — and one fallback flip that should not travel.

**Drop the third sub-change.** The commit also flips the fallback in

```
services/recovery/service.ts:5191-5194
  const autoRecoveryEnabled = asBoolean(experimentalSettings.enableIssueGraphLivenessAutoRecovery, true) || opts?.force === true;
```

from `true` to `false`. That line is **dead code, at v626 as well as at v722**:
`packages/adapter-utils/src/server-utils.ts:364` is `asBoolean(value, fallback) => typeof value === "boolean" ? value : fallback`,
and `services/instance-settings.ts:224` / `:256` normalize `enableIssueGraphLivenessAutoRecovery` to a
concrete `false` on every path (`?? false` when parsed, `false` in the unset default). The value handed to
`asBoolean` is therefore always a boolean and the fallback is unreachable. Auto-recovery is off because of
the settings default, not because of this line. Carrying it forward preserves a false belief about what
disables auto-recovery; drop it and keep this commit's two real guards (four in total with `337fe1fd1`).

### 6. FIG-276 — system-owned (board_key) result comments inert on terminal issues

**Still necessary, verbatim port.** Both predicates are byte-identical to v626 —
`routes/issues.ts:1718` `shouldImplicitlyMoveCommentedIssueToTodo` (still `if (input.actorType !== "user") return false;`,
still no `actorSource` parameter) and `routes/issues.ts:1748` `shouldHumanCommentResumeInProgressScheduledRetry`.
The hook the patch needs is also intact: `routes/authz.ts:196-213` `getActorInfo` still returns `board_key`
inside the `actorType: "user"` branch, carrying `actorSource: "board_key"`. Bug and fix surface both survive.

Call sites for the four `actorSource` additions: `routes/issues.ts:7697` + `7720`, inside
`router.patch("/issues/:id")` (opens at `7623`), and `9716` + `9738`, inside
`router.post("/issues/:id/comments")` (opens at `9669`).

**No upstream test breaks on this guard**: `server/src/__tests__/issue-comment-reopen-routes.test.ts:178-196`
(`installActor`) defaults its board actor to `source: "local_implicit"`, so the two upstream tests that assert
a human comment *does* move an issue to todo (`:821`, `:856`) never enter the `board_key` branch.

### 7. FIG-380 — clear NO ACTION child rows before deleting an issue

**Still necessary — and it is the second place upstream moved under a patch.** The hook is untouched:
`services/issues.ts` `remove:` (6753-6784) is byte-identical to v626 — it collects attachment assets and
issue documents, then goes straight to `.delete(issues)`. `DELETE /api/issues/:id` therefore still 500s on
any issue that has a comment.

The eight FKs the patch already handles are all still there, all still bare `.references(() => issues.id)`
with no `onDelete` in `packages/db/src/schema/`:

`cost_events.ts:15`, `finance_events.ts:16`, `feedback_votes.ts:10`, `issue_comments.ts:19`,
`issue_read_states.ts:10`, `issue_inbox_archives.ts:13`, `issue_thread_interactions.ts:18`, and the
self-FK `issues.ts:30` (`parentId`).

**A ninth appeared in the delta, and the patch does not know about it:**

```
packages/db/src/schema/company_skills.ts:202
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
```

in `company_skill_test_runs`. The table is new — `git diff v2026.626.0 v2026.722.0 -- packages/db/src/schema/company_skills.ts`
is `1 file changed, 104 insertions(+)`, and the v626 blob of that file has no `issues.id` reference at all.
`RESTRICT` blocks the DELETE exactly as `NO ACTION` does. A full enumeration of every `issues.id` FK in
`packages/db/src/schema/` at `v2026.722.0` gives these nine and nothing else; at `v2026.626.0` it gives the
first eight. So: port `remove:` verbatim and `DELETE /api/issues/:id` still 500s — now on any issue that is
the harness issue of a skill test run.

**And this row is not a copy of the other eight.** The column is `notNull()`, so detaching it (the
`cost_events`/`finance_events` treatment) is impossible. Nor is deleting the row obviously right: upstream
never hard-deletes such an issue. `services/company-skills.ts:6386-6388` (run deletion) and `:6404-6414`
(`pruneExpiredTestHarnessIssues`) *hide* it — `issues.hiddenAt` — and stamp `harnessIssueDeletedAt`, keeping
the run row; the run row is described in that code as the source of truth. `RESTRICT` plus the unique index
`company_skill_test_runs_company_issue_idx` on `(company_id, issue_id)` read as a deliberate invariant, not
an oversight. Step 2 picks one:

- **(a)** delete the run row inside the transaction — cheapest, and destroys a skill-test audit record that
  upstream deliberately only soft-deletes;
- **(b)** refuse the delete with a typed 422 naming the blocking run — honours upstream's invariant, but
  turns a working `DELETE` into a failure for a new class of issue;
- **(c)** (b), except delete the run row when it is already soft-deleted (`deletedAt` set) — the only state
  in which upstream itself treats the row as discardable.

Recommendation: **(c)**. It keeps `DELETE /api/issues/:id` from 500-ing without silently discarding a live
audit row, and it is the option whose behaviour is already spelled out upstream.

**Port cost.** The eight-FK part is verbatim. The ninth is a code change in `remove()` plus one entry in
`HANDLED_BY_REMOVE`, gated on the (a)/(b)/(c) call — and the fig regression test is red until both land
(see "Test net" below).

### 8. Coder image attachments (canale allegati B)

**Still necessary, verbatim port.** `server/src/services/fig/` does not exist upstream, and upstream still
has no path that materializes issue image attachments for a filesystem-multimodal local coder: the only
image handling in `heartbeat.ts` is base64 redaction for logs (`:564`, `:2014`). The anchor is intact —
`heartbeat.ts:12926` `context.paperclipWorkspace = { cwd: executionWorkspace.cwd, … }`, with `issueRef` in
scope and `context.paperclipTaskMarkdown` already assigned at `:12129`.

## Test net for step 2

Two of the four fig test files are ours alone, so no upstream churn can touch them — but only one of the
two carries over untouched:

- `issue-assignment-wakeup-fail-loud.test.ts` — carries over untouched.
- `issue-delete-fk-coverage.test.ts` — **goes red on the new base, by design.** It introspects every drizzle
  FK pointing at `issues.id`, skips `DB_RESOLVED_ACTIONS = new Set(["cascade", "set null", "set default"])`
  (`:38`) — which does not whitelist `restrict` — and then asserts strict equality (`:73`, `toEqual`)
  between what survives and the hardcoded eight-entry `HANDLED_BY_REMOVE` (`:23-35`). On `v2026.722.0`
  `company_skill_test_runs.issue_id` lands in the collected set and that assertion fails. This is the guard
  firing exactly as intended — its own docstring says "do not edit the list on its own: handle the new
  column in `services/issues.ts` `remove()` first ... then add it here" — but it means step 2 owes a code
  change plus a list entry here, not a re-append. Whether `restrict` should also be treated as a distinct
  category from `no action` in `DB_RESOLVED_ACTIONS` is a naming question only: both block the delete, so
  the current set is still correct as written.

The other two files are upstream's and need re-appending, not rewriting:

- `__tests__/heartbeat-process-recovery.test.ts` (+3605/-1250 upstream) — every fixture the fig tests use
  survives with the same signature: `seedRunFixture` (`:460-471`, still exposing `processPid`, `includeIssue`,
  `agentStatus`, and still stamping the fixed `2026-03-19` clock the hard-TTL test depends on),
  `spawnAliveProcess`, `waitForValue`, `childProcesses`. The 185 fig lines re-append as new `it()` blocks.
  They will need one update: the hard-TTL assertions must encode whichever monitor/hot-restart decision
  §2 resolves.
- `__tests__/issue-comment-reopen-routes.test.ts` — same story, `installActor` (`:178`) unchanged.

## Consequence for step 2

Port order, cheapest and least entangled first:

1. FIG-276 (§6), coder image attachments (§8), kill switch — all four guards (§4, i.e. `337fe1fd1` plus
   `86239be0e` minus the dropped flip, §5), bounded `unassigned_blocker_recovery` (§2b) — verbatim, one
   commit each, with their tests.
2. FIG-67 (§1) — mechanical, only the call-site line numbers move.
3. FIG-380 (§7) — the eight-FK part is verbatim, then the (a)/(b)/(c) call on
   `company_skill_test_runs.issue_id`, then `HANDLED_BY_REMOVE` gets its ninth entry.
   `issue-delete-fk-coverage.test.ts` is the acceptance signal: red until both land, green after.
4. FIG-132 hard-TTL + the r7 grace modifier (§2, §3) — **last**, and only after deciding how the ceiling
   composes with upstream's monitor re-arm and hot-restart adoption. This is a design step, not a merge step.

Rollback for step 2 stays the pin: `git checkout fig/v2026.626.0-r7` restores prod exactly.
