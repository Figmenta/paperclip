#!/usr/bin/env node
/**
 * Silence sentinel — I/O shell.
 *
 * Reads real state from the GitHub REST API, hands it to the pure detectors in
 * `detect.mjs`, and delivers only what is new or worsening. Deterministic end to
 * end: no model is consulted, because this is a controller, not an agent.
 *
 * Every recipient is read from the environment (repository secrets/variables).
 * Nothing addressable is written in this file.
 *
 * Configuration (all optional except the token, which Actions supplies):
 *   SENTINEL_GITHUB_TOKEN / GITHUB_TOKEN   read access to the scanned repo
 *   SENTINEL_REPO / GITHUB_REPOSITORY      owner/name to scan
 *   SENTINEL_STATE_FILE                    anti-noise ledger path
 *   SENTINEL_DRY_RUN                       "true" → report to stdout, deliver nothing
 *   SENTINEL_INGEST_URL                    the one egress: Orchestra's alert ingest
 *   SENTINEL_INGEST_KEY                    bearer for the above
 *   SENTINEL_DEPLOY_WORKFLOW               workflow file name that proves a deploy
 *   SENTINEL_DEPLOY_ENVIRONMENT            deployments-API environment, alternative to the above
 *   SENTINEL_DIRECTOR_STATUS_URL           director heartbeat probe (off until Maestro exists)
 *   SENTINEL_*_MINUTES                     threshold overrides, see detect.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { evaluate, diffFindings, resolveApprovalState, DEFAULT_THRESHOLDS } from "./detect.mjs";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const CONCURRENCY = 4;

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Below this, an override is a typo rather than an intent. */
const MIN_THRESHOLD_MINUTES = 1;

function thresholdsFromEnv() {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    // approvedNotMergedMinutes → SENTINEL_APPROVED_NOT_MERGED_MINUTES
    const envName = `SENTINEL_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
    const raw = env(envName);
    if (raw === undefined) continue;

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      console.error(`::warning::${envName}=${raw} is not a number; keeping ${thresholds[key]}m`);
      continue;
    }
    // A zero or negative threshold is not "alert sooner", it is a division by
    // zero: every finding fires and pins to the top escalation band, which is
    // the sentinel screaming and therefore the sentinel ignored. Refuse it and
    // say so, rather than obeying a value nobody can have meant.
    if (value < MIN_THRESHOLD_MINUTES) {
      console.error(
        `::warning::${envName}=${raw} is below the ${MIN_THRESHOLD_MINUTES}m minimum; ignored, keeping ${thresholds[key]}m`,
      );
      continue;
    }
    thresholds[key] = value;
  }
  return thresholds;
}

function ms(iso) {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

class GitHub {
  constructor(token) {
    this.token = token;
    // Every list read that hit its page cap, so a bounded read is legible as a
    // bounded read instead of passing for full coverage.
    this.truncations = [];
  }

  async getPage(url) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "silence-sentinel",
      },
    });
    if (!response.ok) {
      throw new Error(`GET ${url} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return { body: await response.json(), link: response.headers.get("link") };
  }

  async get(path) {
    return (await this.getPage(`${API}${path}`)).body;
  }

  /**
   * Walks `Link: rel="next"` to the end of a list.
   *
   * Reading one page is not good enough for reviews: that endpoint returns
   * oldest-first, so page 1 of a busy PR holds the *stalest* reviews and the
   * renewal that would clear a finding sits on page 2. Taking only the last
   * page is equally wrong — a reviewer whose newest verdict is early would
   * vanish. The whole list, or the answer is a guess.
   *
   * Costs nothing on a quiet repo: a second request happens only when GitHub
   * actually advertises one.
   *
   * The page cap is a runaway guard, not a coverage decision. Stopping at it
   * means the read is short and the answer may be wrong, so it is recorded and
   * reported: a truncation nobody is told about reads exactly like a complete
   * scan, which is the failure mode this whole workflow exists to catch.
   */
  async getAll(path, pick = (body) => body, maxPages = 20) {
    let url = `${API}${path}`;
    const items = [];
    for (let page = 0; url && page < maxPages; page += 1) {
      const { body, link } = await this.getPage(url);
      items.push(...pick(body));
      url = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
    }
    if (url) this.truncations.push(`${path} stopped at the ${maxPages}-page cap (${items.length} item(s) read, more available)`);
    return items;
  }
}

async function collectSnapshot(gh, repo, thresholds) {
  const errors = [];
  const nowMs = Date.now();

  const rawOpen = await gh.getAll(`/repos/${repo}/pulls?state=open&per_page=100`);

  const openPulls = await mapLimit(rawOpen, CONCURRENCY, async (pull) => {
    const base = {
      repo,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      headSha: pull.head.sha,
      draft: Boolean(pull.draft),
      updatedAtMs: ms(pull.updated_at),
      reviews: [],
      checkRuns: [],
    };

    try {
      const reviews = await gh.getAll(`/repos/${repo}/pulls/${pull.number}/reviews?per_page=100`);
      base.reviews = reviews.map((review) => ({
        reviewer: review.user?.login ?? "unknown",
        state: review.state,
        commitSha: review.commit_id,
        submittedAtMs: ms(review.submitted_at) ?? 0,
      }));
    } catch (error) {
      errors.push(`reviews #${pull.number}: ${error.message}`);
    }

    try {
      const checkRuns = await gh.getAll(
        `/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`,
        (body) => body.check_runs ?? [],
      );
      base.checkRuns = checkRuns.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        startedAtMs: ms(run.started_at) ?? ms(run.created_at),
      }));
    } catch (error) {
      errors.push(`checks #${pull.number}: ${error.message}`);
    }

    // The head commit date is only needed to age a decayed approval, so it is
    // fetched only for the PRs that actually have one — one call, not N.
    const approval = resolveApprovalState(base.reviews, base.headSha);
    if (approval.staleApprovals.length > 0 && approval.approvalsOnHead.length === 0) {
      try {
        const commit = await gh.get(`/repos/${repo}/commits/${base.headSha}`);
        base.headCommittedAtMs = ms(commit.commit?.committer?.date ?? commit.commit?.author?.date);
      } catch (error) {
        errors.push(`head commit #${pull.number}: ${error.message}`);
      }
    }

    return base;
  });

  const deploy = await collectDeployEvidence(gh, repo, errors);

  let mergedPulls = [];
  if (deploy.enabled) {
    try {
      const closed = await gh.get(
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
      );  // newest-first and lookback-bounded, so one page is the whole question
      mergedPulls = closed
        .filter((pull) => pull.merged_at)
        .map((pull) => ({
          repo,
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          mergedAtMs: ms(pull.merged_at),
          mergeCommitSha: pull.merge_commit_sha,
        }));
    } catch (error) {
      errors.push(`merged pulls: ${error.message}`);
    }
  }

  const director = await collectDirector(errors);

  return {
    snapshot: { nowMs, repo, thresholds, openPulls, mergedPulls, deploy, director },
    errors,
  };
}

async function collectDeployEvidence(gh, repo, errors) {
  const workflow = env("SENTINEL_DEPLOY_WORKFLOW");
  const environment = env("SENTINEL_DEPLOY_ENVIRONMENT");
  if (!workflow && !environment) return { enabled: false, source: "none", successfulShas: [] };

  // Deploy evidence is a membership test: a merge sha either appears among the
  // successful deploys or it does not. Reading one page made a miss silent —
  // a busy repository pushes the sha off page 1 and the merge is reported as
  // never served. These walk the pages, and `getAll` reports the cap if the
  // history is deeper still. The cap is lower than the default: this only has
  // to reach back as far as MERGED_LOOKBACK_MINUTES, not to the beginning.
  const DEPLOY_MAX_PAGES = 5;

  try {
    if (workflow) {
      const runs = await gh.getAll(
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=100`,
        (body) => body.workflow_runs ?? [],
        DEPLOY_MAX_PAGES,
      );
      return {
        enabled: true,
        source: `workflow:${workflow}`,
        successfulShas: runs.map((run) => run.head_sha),
      };
    }

    const deployments = await gh.getAll(
      `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
      (body) => body,
      DEPLOY_MAX_PAGES,
    );
    const shas = [];
    for (const deployment of deployments) {
      const statuses = await gh.get(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=10`);
      if (statuses.some((status) => status.state === "success")) shas.push(deployment.sha);
    }
    return { enabled: true, source: `environment:${environment}`, successfulShas: shas };
  } catch (error) {
    errors.push(`deploy evidence: ${error.message}`);
    // Absent evidence must never be read as "never deployed" — that would make
    // the sentinel shout about an outage of its own making.
    return { enabled: false, source: "unavailable", successfulShas: [] };
  }
}

async function collectDirector(errors) {
  const url = env("SENTINEL_DIRECTOR_STATUS_URL");
  if (!url) return { enabled: false };

  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status}`);
    const body = await response.json();
    return {
      enabled: true,
      name: body.name ?? "director",
      url: body.url ?? null,
      queueDepth: Number(body.queueDepth ?? body.pending ?? 0),
      lastActivityAtMs: ms(body.lastActivityAt) ?? 0,
    };
  } catch (error) {
    errors.push(`director probe: ${error.message}`);
    return { enabled: false };
  }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { version: 1, findings: {} };
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * A pull request title is attacker-controlled on a public repository, and it
 * travels from here into a chat channel. Defang it at the boundary rather than
 * in the detectors, which must stay presentation-agnostic.
 */
function neutralize(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/@(everyone|here)/gi, "@​$1");
}

function renderAlert(alert) {
  const banner = alert.reason === "worsened" ? "WORSENING" : "NEW";
  return `- **[${banner}] ${alert.condition}** — ${neutralize(alert.subject)}\n  ${neutralize(alert.detail)}\n  ${alert.ageMinutes}m silent (threshold ${alert.thresholdMinutes}m, tier ${alert.tier})\n  ${alert.url ?? ""}`.trimEnd();
}

function renderReport(repo, alerts) {
  return [
    `Silence sentinel — ${alerts.length} condition(s) nobody would have been told about, on \`${repo}\`.`,
    "",
    ...alerts.map(renderAlert),
    "",
    "Each item is a state no event can announce: it was found by polling, not by listening.",
  ].join("\n");
}

/**
 * One egress, fanned out server-side.
 *
 * This runs on a GitHub-hosted runner, off our network, so it can only talk to
 * what is publicly reachable: the Paperclip API sits behind Cloudflare Access
 * and answers an off-host POST with a redirect to a login page no token can
 * satisfy, and a Discord webhook is anonymous by construction. Orchestra is
 * reachable and can address both from inside, so the public repository holds
 * exactly one credential and its whole power is "file a sentinel alert".
 *
 * The contract is frozen with the ingest side: 202 means accepted, and
 * anything else — including a redirect that resolves to a cheerful 200 on some
 * login page — is a delivery failure, which is why the check is on the exact
 * status rather than on `response.ok`.
 *
 * Accepted is not yet delivered. The ingest fans out to two independent legs
 * and neither is allowed to fail the other, so it answers 202 and names the
 * legs that actually landed in `delivered`. An empty list means the alert was
 * accepted and then reached nobody — which, taken as success, would advance
 * the ledger and leave the finding spoken exactly zero times: the sentinel
 * failing in the one way it exists to catch. So an empty list is a delivery
 * failure. A body without the field is left alone: that is the frozen contract
 * as written, and this must not break on an ingest that only promises 202.
 * Left alone, but not unremarked — see `caveats`.
 *
 * `caveats` collects the assumptions this delivery had to make, so the run
 * summary can carry them the way it carries truncated reads.
 */
async function deliver(repo, alerts, dryRun, caveats = []) {
  const report = renderReport(repo, alerts);

  if (dryRun) {
    console.log("--- dry run, nothing delivered ---");
    console.log(report);
    return ["dry-run"];
  }

  const ingestUrl = env("SENTINEL_INGEST_URL");
  const ingestKey = env("SENTINEL_INGEST_KEY");

  // An unset recipient turns the sink off and the run says so, rather than
  // failing as though something broke.
  if (!ingestUrl) {
    console.log("::notice::alert ingest not configured (SENTINEL_INGEST_URL); nothing delivered");
    return [];
  }
  if (!ingestKey) {
    console.log("::notice::alert ingest has no key (SENTINEL_INGEST_KEY); nothing delivered");
    return [];
  }

  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ingestKey}`,
      },
      body: JSON.stringify({
        title: `[sentinel] ${alerts.length} silent failure(s) on ${neutralize(repo)}`,
        description: report,
        priority: "high",
        repo,
      }),
    });
    if (response.status !== 202) {
      throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const body = await response.json().catch(() => null);
    const legs = Array.isArray(body?.delivered) ? body.delivered.map(String) : null;
    if (legs === null) {
      // Still a success: the frozen contract promises the status code and
      // nothing more. But this is the one path that quietly falls back to
      // "accepted means delivered", so it must not be the one path nobody is
      // told about — if the field ever disappears (a refactor, a proxy that
      // rewrites the body), the per-leg check switches off and the run would
      // otherwise read exactly like a healthy one.
      const caveat =
        "alert ingest returned 202 without a `delivered` field; treating as delivered, but the per-leg check is inactive";
      console.error(`::warning::${caveat}`);
      caveats.push(caveat);
      return ["orchestra"];
    }
    if (legs.length === 0) {
      throw new Error(`202 accepted but delivered to no leg: ${JSON.stringify(body).slice(0, 200)}`);
    }
    // A partial fan-out still reached somebody, so the finding is announced and
    // the ledger may advance — but the leg that failed is not allowed to pass
    // in silence either.
    for (const [name, leg] of Object.entries(body ?? {})) {
      if (name !== "delivered" && leg && typeof leg === "object" && leg.ok === false) {
        console.error(`::warning::alert ingest leg '${name}' failed: ${leg.reason ?? "no reason given"}`);
      }
    }
    return legs.map((leg) => `orchestra:${leg}`);
  } catch (error) {
    console.error(`::warning::alert ingest failed: ${error.message}`);
    return [];
  }
}

async function summarize(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  await writeFile(path, `${lines.join("\n")}\n`, { flag: "a" });
}

async function main() {
  const token = env("SENTINEL_GITHUB_TOKEN") ?? env("GITHUB_TOKEN");
  const repo = env("SENTINEL_REPO") ?? env("GITHUB_REPOSITORY");
  const dryRun = env("SENTINEL_DRY_RUN", "false") === "true";
  const statePath = env("SENTINEL_STATE_FILE", ".sentinel-state/state.json");

  if (!token) throw new Error("no token: set SENTINEL_GITHUB_TOKEN or GITHUB_TOKEN");
  if (!repo) throw new Error("no repo: set SENTINEL_REPO or GITHUB_REPOSITORY");

  const thresholds = thresholdsFromEnv();
  const gh = new GitHub(token);
  const { snapshot, errors } = await collectSnapshot(gh, repo, thresholds);
  const { findings, skipped } = evaluate(snapshot);
  const previous = await readState(statePath);
  const { alerts, resolved, nextState } = diffFindings(findings, previous, {
    // A truncated list is a partial read like any other: what was not read
    // cannot be treated as gone, so previously known fingerprints are carried
    // forward instead of being cleared by an absence we did not observe.
    nowMs: snapshot.nowMs,
    scanComplete: errors.length === 0 && gh.truncations.length === 0,
  });

  console.log(
    `scanned ${repo}: ${snapshot.openPulls.length} open PR(s), ${findings.length} condition(s) standing, ${alerts.length} to announce, ${resolved.length} cleared`,
  );
  for (const entry of skipped) console.log(`::notice::skipped ${entry.condition}: ${entry.reason}`);
  for (const error of errors) console.error(`::warning::partial read: ${error}`);
  for (const truncation of gh.truncations) console.error(`::warning::truncated read: ${truncation}`);

  // The run summary must carry the same caveat as the log, or a reader who
  // trusts it reads a bounded scan as a complete one.
  const summaryLines = gh.truncations.map((truncation) => `> **Truncated read** — ${truncation}`);

  // Assumptions the delivery had to make. Same reasoning as the truncations
  // above: a caveat only in the log is invisible to whoever reads the summary.
  const caveats = [];

  if (alerts.length > 0) {
    const delivered = await deliver(repo, alerts, dryRun, caveats);
    console.log(renderReport(repo, alerts));
    console.log(`delivered via: ${delivered.join(", ") || "nothing configured"}`);
    summaryLines.unshift(`### Silence sentinel — ${alerts.length} announced`, "", ...alerts.map(renderAlert), "");

    if (!dryRun && delivered.length === 0) {
      // Nobody was told, so nothing may be recorded as told. Writing these
      // fingerprints would mark the condition announced, the next scan would
      // see an equal band and stay quiet, and the alert would be spoken
      // exactly zero times — the sentinel failing the way it exists to catch.
      // Roll back only the fingerprints that just failed to reach anyone;
      // anything previously delivered keeps its band and stays silent.
      for (const alert of alerts) {
        const before = previous.findings?.[alert.fingerprint];
        if (before) nextState.findings[alert.fingerprint] = before;
        else delete nextState.findings[alert.fingerprint];
      }
      console.error(
        `::error::${alerts.length} alert(s) reached no sink; not recorded as announced, will be retried next scan`,
      );
      process.exitCode = 1;
    }
  } else {
    // The empty run is the common case and it says nothing anywhere.
    console.log("silence is clean: nothing new, nothing worsening");
  }

  for (const caveat of caveats) summaryLines.push(`> **Delivery caveat** — ${caveat}`);

  if (summaryLines.length > 0) await summarize(summaryLines);

  if (!dryRun) await writeState(statePath, nextState);
}

main().catch((error) => {
  // A sentinel that dies quietly is the very bug it exists to catch, so a total
  // failure is loud: the workflow run goes red.
  console.error(`::error::silence sentinel failed: ${error.message}`);
  process.exitCode = 1;
});
