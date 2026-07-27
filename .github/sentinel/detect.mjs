/**
 * Silence sentinel — detection layer.
 *
 * The engine that runs this repository is event-driven: it reacts to what
 * *happens*. The failures that hurt are things that *do not* happen — a merge
 * that never starts, an approval that decays, a deploy that never runs, a check
 * that hangs. No webhook exists for silence, so nothing can listen for it.
 *
 * This module is the deterministic core that names those non-events. It is
 * deliberately pure: no network, no clock, no randomness, no model. Everything
 * it decides on arrives inside `snapshot`, which makes the entire decision
 * surface reproducible from a fixture. `sentinel.mjs` owns all I/O.
 */

const MINUTE_MS = 60_000;

/** Minutes of silence tolerated per condition before it is worth a word. */
export const DEFAULT_THRESHOLDS = {
  // Merges here are machine-driven and land within a couple of minutes of a
  // PASS. Three quarters of an hour of an approved-and-green PR sitting still
  // is not slowness, it is the merge never having started.
  approvedNotMergedMinutes: 45,
  // A head moves and the approval is left behind. The reviewer is gone, the
  // card is closed, nobody will be woken. Shortest threshold because nothing
  // else in the system will ever notice this one.
  staleApprovalMinutes: 30,
  // Merged code that is not being served is invisible failure, but deploys are
  // slower and lumpier than merges, so it gets an hour.
  mergedNotDeployedMinutes: 60,
  // Self-hosted runners saturate; a genuinely queued check can idle a while
  // before it is stuck rather than merely waiting.
  ciStuckMinutes: 60,
  directorIdleMinutes: 30,
};

/** How far back to consider a merged PR still deploy-relevant. */
export const MERGED_LOOKBACK_MINUTES = 24 * 60;

/**
 * Escalation ladder. A finding is re-announced only when it crosses into a
 * higher band, which is what "or worsening" means without a timer that drips.
 */
export const ESCALATION_MULTIPLIERS = [1, 2, 4, 8];

/** GitHub review states that actually bind. COMMENTED never changes standing. */
const BINDING_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Check-run states that mean "not finished". */
const UNFINISHED_CHECK_STATES = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

export function minutes(ms) {
  return Math.floor(ms / MINUTE_MS);
}

/**
 * Which escalation band an age falls into. Band 0 is "over threshold", each
 * further band is a doubling. Ages below the threshold have no band.
 */
export function escalationTier(ageMs, thresholdMinutes) {
  const ratio = ageMs / (thresholdMinutes * MINUTE_MS);
  let tier = 0;
  for (let index = 1; index < ESCALATION_MULTIPLIERS.length; index += 1) {
    if (ratio >= ESCALATION_MULTIPLIERS[index]) tier = index;
  }
  return tier;
}

/**
 * Collapse a review list into the standing decision, the way GitHub does it:
 * only the newest binding review per reviewer counts, and an approval is tied
 * to the exact commit it was given on.
 */
export function resolveApprovalState(reviews, headSha) {
  const latestByReviewer = new Map();
  for (const review of reviews ?? []) {
    if (!BINDING_REVIEW_STATES.has(review.state)) continue;
    const previous = latestByReviewer.get(review.reviewer);
    if (!previous || review.submittedAtMs > previous.submittedAtMs) {
      latestByReviewer.set(review.reviewer, review);
    }
  }

  const standing = [...latestByReviewer.values()];
  const approvals = standing.filter((review) => review.state === "APPROVED");
  const onHead = approvals.filter((review) => review.commitSha === headSha);
  const stale = approvals.filter((review) => review.commitSha !== headSha);

  return {
    changesRequested: standing.some((review) => review.state === "CHANGES_REQUESTED"),
    approvals,
    approvalsOnHead: onHead,
    staleApprovals: stale,
    earliestApprovalOnHeadMs: onHead.length
      ? Math.min(...onHead.map((review) => review.submittedAtMs))
      : null,
    latestStaleApprovalMs: stale.length
      ? Math.max(...stale.map((review) => review.submittedAtMs))
      : null,
  };
}

function finding({ condition, subject, url, fingerprint, ageMs, thresholdMinutes, detail }) {
  return {
    condition,
    subject,
    url,
    fingerprint,
    ageMinutes: minutes(ageMs),
    thresholdMinutes,
    tier: escalationTier(ageMs, thresholdMinutes),
    detail,
  };
}

/** 1. Approved on the current head, green enough to go, and still open. */
export function detectApprovedNotMerged(pull, { nowMs, thresholds }) {
  if (pull.draft) return null;
  const state = resolveApprovalState(pull.reviews, pull.headSha);
  if (state.changesRequested) return null;
  if (state.earliestApprovalOnHeadMs === null) return null;

  const ageMs = nowMs - state.earliestApprovalOnHeadMs;
  const threshold = thresholds.approvedNotMergedMinutes;
  if (ageMs < threshold * MINUTE_MS) return null;

  return finding({
    condition: "approved_not_merged",
    subject: `#${pull.number} ${pull.title}`,
    url: pull.url,
    // The head sha is part of the identity: a new head is a new situation, not
    // a continuation of the old one.
    fingerprint: `approved_not_merged:${pull.repo}#${pull.number}:${pull.headSha}`,
    ageMs,
    thresholdMinutes: threshold,
    detail: `approved on head ${short(pull.headSha)} by ${state.approvalsOnHead
      .map((review) => review.reviewer)
      .join(", ")}, still open after ${minutes(ageMs)}m`,
  });
}

/**
 * 2. The one nothing else can see: the PR was approved, then the head moved,
 * and the approval was never renewed. The engine is right to refuse a verdict
 * bound to a superseded sha — but the card is closed, so no one gets woken and
 * the work sits finished, approved, and invisible.
 */
export function detectStaleApproval(pull, { nowMs, thresholds }) {
  if (pull.draft) return null;
  const state = resolveApprovalState(pull.reviews, pull.headSha);
  // A standing "changes requested" is an ordinary loop-back: somebody owes work
  // and the event for it already fired. Not silence.
  if (state.changesRequested) return null;
  if (state.staleApprovals.length === 0) return null;
  // Renewed on the current head — the approval is live, condition 1's business.
  if (state.approvalsOnHead.length > 0) return null;

  // Decay starts when the head moved past the approval.
  const decayStartedMs = pull.headCommittedAtMs ?? pull.updatedAtMs ?? state.latestStaleApprovalMs;
  const ageMs = nowMs - decayStartedMs;
  const threshold = thresholds.staleApprovalMinutes;
  if (ageMs < threshold * MINUTE_MS) return null;

  const orphaned = state.staleApprovals
    .map((review) => `${review.reviewer}@${short(review.commitSha)}`)
    .join(", ");

  return finding({
    condition: "stale_approval",
    subject: `#${pull.number} ${pull.title}`,
    url: pull.url,
    fingerprint: `stale_approval:${pull.repo}#${pull.number}:${pull.headSha}`,
    ageMs,
    thresholdMinutes: threshold,
    detail: `approved on superseded sha (${orphaned}) but head is ${short(
      pull.headSha,
    )}; approval never renewed, nobody is waiting on it`,
  });
}

/** 4. A check that started and never finished. */
export function detectCiStuck(pull, { nowMs, thresholds }) {
  const running = (pull.checkRuns ?? []).filter(
    (run) => UNFINISHED_CHECK_STATES.has(run.status) && Number.isFinite(run.startedAtMs),
  );
  if (running.length === 0) return null;

  const oldestStartMs = Math.min(...running.map((run) => run.startedAtMs));
  const ageMs = nowMs - oldestStartMs;
  const threshold = thresholds.ciStuckMinutes;
  if (ageMs < threshold * MINUTE_MS) return null;

  const names = running.map((run) => run.name).join(", ");
  return finding({
    condition: "ci_stuck",
    subject: `#${pull.number} ${pull.title}`,
    url: pull.url,
    fingerprint: `ci_stuck:${pull.repo}#${pull.number}:${pull.headSha}`,
    ageMs,
    thresholdMinutes: threshold,
    detail: `${running.length} check(s) unfinished for ${minutes(ageMs)}m on ${short(
      pull.headSha,
    )}: ${names}`,
  });
}

/** 3. Merged, and never served. */
export function detectMergedNotDeployed(merged, deploy, { nowMs, thresholds }) {
  const ageMs = nowMs - merged.mergedAtMs;
  const threshold = thresholds.mergedNotDeployedMinutes;
  if (ageMs < threshold * MINUTE_MS) return null;
  if (ageMs > MERGED_LOOKBACK_MINUTES * MINUTE_MS) return null;

  const shas = new Set(deploy.successfulShas ?? []);
  if (merged.mergeCommitSha && shas.has(merged.mergeCommitSha)) return null;

  return finding({
    condition: "merged_not_deployed",
    subject: `#${merged.number} ${merged.title}`,
    url: merged.url,
    fingerprint: `merged_not_deployed:${merged.repo}#${merged.number}:${merged.mergeCommitSha}`,
    ageMs,
    thresholdMinutes: threshold,
    detail: `merged ${minutes(ageMs)}m ago as ${short(
      merged.mergeCommitSha,
    )}, no successful deploy recorded for that sha (source: ${deploy.source})`,
  });
}

/** 5. The director deadman. Wired, and off until there is something to ask. */
export function detectDirectorDeadman(director, { nowMs, thresholds }) {
  if (!director?.enabled) return null;
  if (!(director.queueDepth > 0)) return null;

  const ageMs = nowMs - director.lastActivityAtMs;
  const threshold = thresholds.directorIdleMinutes;
  if (ageMs < threshold * MINUTE_MS) return null;

  return finding({
    condition: "director_deadman",
    subject: director.name ?? "director",
    url: director.url ?? null,
    fingerprint: `director_deadman:${director.name ?? "director"}`,
    ageMs,
    thresholdMinutes: threshold,
    detail: `${director.queueDepth} item(s) waiting, no dispatcher activity for ${minutes(ageMs)}m`,
  });
}

/**
 * Run every detector over a snapshot of real state.
 * Returns findings plus an explicit list of what was *not* checked and why —
 * a sentinel that silently skips half its job is worse than no sentinel.
 */
export function evaluate(snapshot) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(snapshot.thresholds ?? {}) };
  const context = { nowMs: snapshot.nowMs, thresholds };
  const findings = [];
  const skipped = [];

  for (const pull of snapshot.openPulls ?? []) {
    for (const detector of [detectApprovedNotMerged, detectStaleApproval, detectCiStuck]) {
      const hit = detector(pull, context);
      if (hit) findings.push(hit);
    }
  }

  const deploy = snapshot.deploy ?? { enabled: false };
  if (deploy.enabled) {
    for (const merged of snapshot.mergedPulls ?? []) {
      const hit = detectMergedNotDeployed(merged, deploy, context);
      if (hit) findings.push(hit);
    }
  } else {
    skipped.push({
      condition: "merged_not_deployed",
      reason: "no deploy evidence source configured (SENTINEL_DEPLOY_WORKFLOW / SENTINEL_DEPLOY_ENVIRONMENT)",
    });
  }

  const director = snapshot.director ?? { enabled: false };
  if (director.enabled) {
    const hit = detectDirectorDeadman(director, context);
    if (hit) findings.push(hit);
  } else {
    skipped.push({
      condition: "director_deadman",
      reason: "no director endpoint configured (SENTINEL_DIRECTOR_STATUS_URL); hook wired, off until Maestro exists",
    });
  }

  findings.sort((a, b) => b.tier - a.tier || b.ageMinutes - a.ageMinutes);
  return { findings, skipped };
}

/**
 * Anti-noise gate. A sentinel that repeats itself gets ignored, and an ignored
 * sentinel is worse than none — so a finding earns a word exactly twice: when
 * it first appears, and each time it crosses into a worse band.
 *
 * `scanComplete: false` means part of the read failed. In that case unobserved
 * fingerprints are carried forward rather than forgotten, so a transient API
 * error cannot resurrect an old alert.
 */
export function diffFindings(findings, previousState, { nowMs, scanComplete = true } = {}) {
  const previous = previousState?.findings ?? {};
  const alerts = [];
  const nextFindings = {};

  for (const hit of findings) {
    const seen = previous[hit.fingerprint];
    const firstSeenMs = seen?.firstSeenMs ?? nowMs;
    nextFindings[hit.fingerprint] = { tier: hit.tier, firstSeenMs, condition: hit.condition };

    if (!seen) {
      alerts.push({ ...hit, reason: "new", firstSeenMs });
    } else if (hit.tier > seen.tier) {
      alerts.push({ ...hit, reason: "worsened", firstSeenMs, previousTier: seen.tier });
    }
  }

  if (!scanComplete) {
    for (const [fingerprint, entry] of Object.entries(previous)) {
      if (!nextFindings[fingerprint]) nextFindings[fingerprint] = entry;
    }
  }

  const resolved = Object.keys(previous).filter((fingerprint) => !nextFindings[fingerprint]);

  return {
    alerts,
    resolved,
    nextState: { version: 1, updatedAtMs: nowMs, findings: nextFindings },
  };
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 8) : String(sha);
}
