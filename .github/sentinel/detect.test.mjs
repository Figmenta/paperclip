/**
 * Silence sentinel — detection tests. Zero dependencies: `node --test`.
 *
 * The centrepiece is the real case from 2026-07-27, Figmenta/orchestra#550: a
 * finished, approved, mergeable PR whose approvals sat on superseded shas while
 * the head had moved on. The engine correctly refused the expired verdict, the
 * card was already closed, so nobody was ever woken. That PR carries no
 * GitHub-native review — the approval lived in the loop's verdict layer — so the
 * case cannot be replayed against the live API. It is replayed here instead,
 * with its exact shas, against the generic GitHub review shape the detector
 * reads.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THRESHOLDS,
  diffFindings,
  escalationTier,
  evaluate,
  resolveApprovalState,
} from "./detect.mjs";

const NOW = Date.parse("2026-07-27T18:00:00Z");
const MINUTE = 60_000;
const ago = (m) => NOW - m * MINUTE;

function snapshot(overrides = {}) {
  return {
    nowMs: NOW,
    repo: "Figmenta/orchestra",
    thresholds: DEFAULT_THRESHOLDS,
    openPulls: [],
    mergedPulls: [],
    deploy: { enabled: false, source: "none", successfulShas: [] },
    director: { enabled: false },
    ...overrides,
  };
}

function pull(overrides = {}) {
  return {
    repo: "Figmenta/orchestra",
    number: 1,
    title: "a pull request",
    url: "https://github.com/Figmenta/orchestra/pull/1",
    headSha: "a".repeat(40),
    draft: false,
    updatedAtMs: ago(10),
    reviews: [],
    checkRuns: [],
    ...overrides,
  };
}

/** Figmenta/orchestra#550, as observed on 2026-07-27. */
const PR_550_HEAD = "b8de063d0f54fb50b41d467b0b9bcc3f5345640c";
const PR_550_SUPERSEDED = ["f1605d7d" + "0".repeat(32), "19e0093c" + "0".repeat(32)];

function pull550() {
  return pull({
    number: 550,
    title: "agent single-flight",
    url: "https://github.com/Figmenta/orchestra/pull/550",
    headSha: PR_550_HEAD,
    headCommittedAtMs: ago(180),
    reviews: [
      { reviewer: "griso", state: "APPROVED", commitSha: PR_550_SUPERSEDED[0], submittedAtMs: ago(600) },
      { reviewer: "griso", state: "APPROVED", commitSha: PR_550_SUPERSEDED[1], submittedAtMs: ago(400) },
    ],
  });
}

test("the #550 case: an approval left behind by a moving head is reported", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));

  const stale = findings.filter((f) => f.condition === "stale_approval");
  assert.equal(stale.length, 1, "exactly one stale_approval");
  assert.equal(stale[0].subject, "#550 agent single-flight");
  assert.match(stale[0].detail, /b8de063d/, "names the current head");
  assert.match(stale[0].detail, /19e0093c/, "names the approval it was orphaned from");
  assert.equal(stale[0].ageMinutes, 180);

  // It must not also be reported as approved-not-merged: the approval is not
  // live, and saying both would be the sentinel arguing with itself.
  assert.equal(findings.filter((f) => f.condition === "approved_not_merged").length, 0);
});

test("#550 stays silent while the decay is still young", () => {
  const young = pull550();
  young.headCommittedAtMs = ago(DEFAULT_THRESHOLDS.staleApprovalMinutes - 1);
  const { findings } = evaluate(snapshot({ openPulls: [young] }));
  assert.equal(findings.length, 0);
});

test("a quiet repository produces no findings and no alerts", () => {
  const clean = snapshot({
    openPulls: [
      pull({ number: 10, reviews: [], checkRuns: [{ name: "ci", status: "in_progress", startedAtMs: ago(3) }] }),
      pull({
        number: 11,
        headSha: "c".repeat(40),
        reviews: [{ reviewer: "vega", state: "APPROVED", commitSha: "c".repeat(40), submittedAtMs: ago(2) }],
      }),
    ],
  });

  const { findings } = evaluate(clean);
  assert.deepEqual(findings, []);

  const { alerts } = diffFindings(findings, { findings: {} }, { nowMs: NOW });
  assert.deepEqual(alerts, [], "an empty scan says nothing anywhere");
});

test("a standing condition is announced once, not on every scan", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));

  const first = diffFindings(findings, { findings: {} }, { nowMs: NOW });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].reason, "new");

  const second = diffFindings(findings, first.nextState, { nowMs: NOW + MINUTE });
  assert.deepEqual(second.alerts, [], "the second look at the same problem is silent");

  const third = diffFindings(findings, second.nextState, { nowMs: NOW + 2 * MINUTE });
  assert.deepEqual(third.alerts, []);
});

test("a condition that worsens speaks again", () => {
  const worsening = pull550();
  worsening.headCommittedAtMs = ago(40); // tier 0 at a 30m threshold
  const early = evaluate(snapshot({ openPulls: [worsening] }));
  const first = diffFindings(early.findings, { findings: {} }, { nowMs: NOW });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].tier, 0);

  worsening.headCommittedAtMs = ago(70); // crosses 2x
  const later = evaluate(snapshot({ openPulls: [worsening] }));
  const second = diffFindings(later.findings, first.nextState, { nowMs: NOW });
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].reason, "worsened");
  assert.equal(second.alerts[0].tier, 1);
  assert.equal(second.alerts[0].previousTier, 0);

  // Same band again → back to silence.
  const third = diffFindings(later.findings, second.nextState, { nowMs: NOW });
  assert.deepEqual(third.alerts, []);
});

test("a resolved condition is forgotten, so its return counts as new", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));
  const first = diffFindings(findings, { findings: {} }, { nowMs: NOW });

  const cleared = diffFindings([], first.nextState, { nowMs: NOW });
  assert.equal(cleared.resolved.length, 1);
  assert.deepEqual(cleared.nextState.findings, {});

  const returned = diffFindings(findings, cleared.nextState, { nowMs: NOW });
  assert.equal(returned.alerts.length, 1);
  assert.equal(returned.alerts[0].reason, "new");
});

test("a partial read never resurrects an old alert", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));
  const first = diffFindings(findings, { findings: {} }, { nowMs: NOW });

  // The PR could not be read this round: carry it, do not clear it.
  const degraded = diffFindings([], first.nextState, { nowMs: NOW, scanComplete: false });
  assert.deepEqual(degraded.alerts, []);
  assert.equal(Object.keys(degraded.nextState.findings).length, 1);

  const recovered = diffFindings(findings, degraded.nextState, { nowMs: NOW });
  assert.deepEqual(recovered.alerts, [], "still the same problem, still silent");
});

test("a new head is a new situation", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));
  const first = diffFindings(findings, { findings: {} }, { nowMs: NOW });

  const moved = pull550();
  moved.headSha = "d".repeat(40);
  const after = evaluate(snapshot({ openPulls: [moved] }));
  const second = diffFindings(after.findings, first.nextState, { nowMs: NOW });
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].reason, "new");
});

test("an approved, mergeable PR that never merges is reported", () => {
  const approved = pull({
    number: 549,
    reviews: [
      { reviewer: "griso", state: "APPROVED", commitSha: "a".repeat(40), submittedAtMs: ago(90) },
      { reviewer: "sam", state: "COMMENTED", commitSha: "a".repeat(40), submittedAtMs: ago(5) },
    ],
  });

  const { findings } = evaluate(snapshot({ openPulls: [approved] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].condition, "approved_not_merged");
  assert.equal(findings[0].ageMinutes, 90, "aged from the approval, not from the comment");
});

test("a red or still-running head is not a missing merge", () => {
  const approvedOn = (checkRuns) =>
    pull({
      number: 601,
      checkRuns,
      reviews: [{ reviewer: "griso", state: "APPROVED", commitSha: "a".repeat(40), submittedAtMs: ago(90) }],
    });

  // Still running: the merge has not failed to start, it cannot start yet.
  assert.deepEqual(
    evaluate(snapshot({ openPulls: [approvedOn([{ name: "ci", status: "in_progress", startedAtMs: ago(50) }])] }))
      .findings.filter((f) => f.condition === "approved_not_merged"),
    [],
  );

  // Red: a failing check is itself a loud event, and someone owes work on it.
  assert.deepEqual(
    evaluate(
      snapshot({
        openPulls: [
          approvedOn([{ name: "ci", status: "completed", conclusion: "failure", startedAtMs: ago(50) }]),
        ],
      }),
    ).findings.filter((f) => f.condition === "approved_not_merged"),
    [],
  );

  // Green, approved, past the threshold, still open: that is the real thing.
  const green = evaluate(
    snapshot({
      openPulls: [
        approvedOn([
          { name: "ci", status: "completed", conclusion: "success", startedAtMs: ago(80) },
          { name: "smoke", status: "completed", conclusion: "skipped", startedAtMs: ago(80) },
        ]),
      ],
    }),
  ).findings;
  assert.equal(green.length, 1);
  assert.equal(green[0].condition, "approved_not_merged");

  // A repository with no CI at all behaves as it did before.
  const noChecks = evaluate(snapshot({ openPulls: [approvedOn([])] })).findings;
  assert.equal(noChecks.length, 1);
  assert.equal(noChecks[0].condition, "approved_not_merged");
});

test("a renewal buried behind a wall of bot reviews clears the finding", () => {
  // The shape that a one-page read would get wrong: the reviews endpoint is
  // oldest-first, so the stale approval leads and the renewal trails.
  const noisy = pull550();
  for (let index = 0; index < 120; index += 1) {
    noisy.reviews.push({
      reviewer: `bot-${index}`,
      state: "COMMENTED",
      commitSha: PR_550_HEAD,
      submittedAtMs: ago(300 - index),
    });
  }
  assert.equal(
    evaluate(snapshot({ openPulls: [noisy] })).findings.filter((f) => f.condition === "stale_approval").length,
    1,
    "comments alone never renew an approval",
  );

  noisy.reviews.push({
    reviewer: "griso",
    state: "APPROVED",
    commitSha: PR_550_HEAD,
    submittedAtMs: ago(20),
  });
  assert.deepEqual(
    evaluate(snapshot({ openPulls: [noisy] })).findings.filter((f) => f.condition === "stale_approval"),
    [],
    "the renewal must be seen even when it is the 122nd review",
  );
});

test("an alert that reached nobody is not recorded as announced", () => {
  const { findings } = evaluate(snapshot({ openPulls: [pull550()] }));
  const first = diffFindings(findings, { findings: {} }, { nowMs: NOW });
  assert.equal(first.alerts.length, 1);

  // Delivery failed, so the shell rolls the ledger back the way main() does.
  const rolledBack = { ...first.nextState, findings: { ...first.nextState.findings } };
  for (const alert of first.alerts) delete rolledBack.findings[alert.fingerprint];

  const retry = diffFindings(findings, rolledBack, { nowMs: NOW + 15 * MINUTE });
  assert.equal(retry.alerts.length, 1, "an undelivered alert is spoken again");
  assert.equal(retry.alerts[0].reason, "new");
});

test("requested changes are an ordinary loop-back, not silence", () => {
  const blocked = pull({
    reviews: [
      { reviewer: "griso", state: "APPROVED", commitSha: "a".repeat(40), submittedAtMs: ago(300) },
      { reviewer: "sam", state: "CHANGES_REQUESTED", commitSha: "a".repeat(40), submittedAtMs: ago(200) },
    ],
  });
  assert.deepEqual(evaluate(snapshot({ openPulls: [blocked] })).findings, []);

  const decayedButBlocked = pull550();
  decayedButBlocked.reviews.push({
    reviewer: "sam",
    state: "CHANGES_REQUESTED",
    commitSha: PR_550_SUPERSEDED[1],
    submittedAtMs: ago(300),
  });
  assert.deepEqual(evaluate(snapshot({ openPulls: [decayedButBlocked] })).findings, []);
});

test("only the newest review per reviewer binds", () => {
  const flipped = resolveApprovalState(
    [
      { reviewer: "griso", state: "CHANGES_REQUESTED", commitSha: "x", submittedAtMs: ago(100) },
      { reviewer: "griso", state: "APPROVED", commitSha: "x", submittedAtMs: ago(50) },
    ],
    "x",
  );
  assert.equal(flipped.changesRequested, false);
  assert.equal(flipped.approvalsOnHead.length, 1);

  const withdrawn = resolveApprovalState(
    [
      { reviewer: "griso", state: "APPROVED", commitSha: "x", submittedAtMs: ago(100) },
      { reviewer: "griso", state: "CHANGES_REQUESTED", commitSha: "x", submittedAtMs: ago(50) },
    ],
    "x",
  );
  assert.equal(withdrawn.changesRequested, true);
  assert.equal(withdrawn.approvals.length, 0);
});

test("draft pull requests are exempt", () => {
  const draft = pull550();
  draft.draft = true;
  assert.deepEqual(evaluate(snapshot({ openPulls: [draft] })).findings, []);
});

test("a check that never finishes is reported, a running one is not", () => {
  const running = pull({
    checkRuns: [{ name: "lint-and-smoke", status: "in_progress", startedAtMs: ago(20) }],
  });
  assert.deepEqual(evaluate(snapshot({ openPulls: [running] })).findings, []);

  const hung = pull({
    checkRuns: [
      { name: "lint-and-smoke", status: "in_progress", startedAtMs: ago(95) },
      { name: "web-smoke", status: "queued", startedAtMs: ago(70) },
      { name: "done", status: "completed", startedAtMs: ago(400) },
    ],
  });
  const { findings } = evaluate(snapshot({ openPulls: [hung] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].condition, "ci_stuck");
  assert.equal(findings[0].ageMinutes, 95, "aged from the oldest unfinished check");
  assert.match(findings[0].detail, /lint-and-smoke, web-smoke/);
  assert.doesNotMatch(findings[0].detail, /done/, "finished checks are not counted");
});

test("merged-but-never-served stays quiet unless deploy evidence exists", () => {
  const merged = {
    repo: "Figmenta/orchestra",
    number: 540,
    title: "a merged change",
    url: "https://github.com/Figmenta/orchestra/pull/540",
    mergedAtMs: ago(120),
    mergeCommitSha: "e".repeat(40),
  };

  // No configured source: absent evidence is not proof of a missing deploy.
  const off = evaluate(snapshot({ mergedPulls: [merged] }));
  assert.deepEqual(off.findings, []);
  assert.ok(off.skipped.some((entry) => entry.condition === "merged_not_deployed"));

  const undeployed = evaluate(
    snapshot({
      mergedPulls: [merged],
      deploy: { enabled: true, source: "workflow:deploy.yml", successfulShas: ["f".repeat(40)] },
    }),
  );
  assert.equal(undeployed.findings.length, 1);
  assert.equal(undeployed.findings[0].condition, "merged_not_deployed");

  const deployed = evaluate(
    snapshot({
      mergedPulls: [merged],
      deploy: { enabled: true, source: "workflow:deploy.yml", successfulShas: ["e".repeat(40)] },
    }),
  );
  assert.deepEqual(deployed.findings, []);
});

test("the director deadman is wired and reported as off", () => {
  const off = evaluate(snapshot());
  const entry = off.skipped.find((item) => item.condition === "director_deadman");
  assert.ok(entry, "absence is declared, not hidden");
  assert.match(entry.reason, /Maestro/);

  const idle = evaluate(
    snapshot({
      director: { enabled: true, name: "maestro", queueDepth: 3, lastActivityAtMs: ago(45) },
    }),
  );
  assert.equal(idle.findings.length, 1);
  assert.equal(idle.findings[0].condition, "director_deadman");

  const empty = evaluate(
    snapshot({
      director: { enabled: true, name: "maestro", queueDepth: 0, lastActivityAtMs: ago(45) },
    }),
  );
  assert.deepEqual(empty.findings, [], "an idle director with nothing to do is not a fault");
});

test("escalation bands double", () => {
  assert.equal(escalationTier(30 * MINUTE, 30), 0);
  assert.equal(escalationTier(59 * MINUTE, 30), 0);
  assert.equal(escalationTier(60 * MINUTE, 30), 1);
  assert.equal(escalationTier(119 * MINUTE, 30), 1);
  assert.equal(escalationTier(120 * MINUTE, 30), 2);
  assert.equal(escalationTier(240 * MINUTE, 30), 3);
  assert.equal(escalationTier(10_000 * MINUTE, 30), 3, "the ladder tops out");
});

test("the worst and oldest is reported first", () => {
  const { findings } = evaluate(
    snapshot({
      openPulls: [
        pull550(),
        pull({
          number: 12,
          headSha: "b".repeat(40),
          reviews: [{ reviewer: "vega", state: "APPROVED", commitSha: "b".repeat(40), submittedAtMs: ago(50) }],
        }),
      ],
    }),
  );
  assert.equal(findings.length, 2);
  assert.ok(findings[0].tier >= findings[1].tier);
});
