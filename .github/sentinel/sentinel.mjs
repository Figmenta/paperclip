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
 *   SENTINEL_PAPERCLIP_ISSUE_URL           POST target that opens a triage issue
 *   SENTINEL_PAPERCLIP_TOKEN               bearer for the above
 *   SENTINEL_DISCORD_WEBHOOK_URL           ops channel webhook
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

function thresholdsFromEnv() {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    // approvedNotMergedMinutes → SENTINEL_APPROVED_NOT_MERGED_MINUTES
    const envName = `SENTINEL_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
    const raw = env(envName);
    if (raw !== undefined && Number.isFinite(Number(raw))) thresholds[key] = Number(raw);
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
   */
  async getAll(path, pick = (body) => body, maxPages = 20) {
    let url = `${API}${path}`;
    const items = [];
    for (let page = 0; url && page < maxPages; page += 1) {
      const { body, link } = await this.getPage(url);
      items.push(...pick(body));
      url = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
    }
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

  try {
    if (workflow) {
      const runs = await gh.get(
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=100`,
      );
      return {
        enabled: true,
        source: `workflow:${workflow}`,
        successfulShas: (runs.workflow_runs ?? []).map((run) => run.head_sha),
      };
    }

    const deployments = await gh.get(
      `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
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

async function deliver(repo, alerts, dryRun) {
  const report = renderReport(repo, alerts);
  const delivered = [];

  const paperclipUrl = env("SENTINEL_PAPERCLIP_ISSUE_URL");
  const paperclipToken = env("SENTINEL_PAPERCLIP_TOKEN");
  const discordUrl = env("SENTINEL_DISCORD_WEBHOOK_URL");

  if (dryRun) {
    console.log("--- dry run, nothing delivered ---");
    console.log(report);
    return ["dry-run"];
  }

  if (paperclipUrl) {
    try {
      const response = await fetch(paperclipUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(paperclipToken ? { authorization: `Bearer ${paperclipToken}` } : {}),
        },
        body: JSON.stringify({
          title: `[sentinel] ${alerts.length} silent failure(s) on ${repo}`,
          description: report,
          priority: "high",
        }),
      });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      delivered.push("paperclip");
    } catch (error) {
      console.error(`::warning::paperclip sink failed: ${error.message}`);
    }
  } else {
    console.log("::notice::paperclip sink not configured (SENTINEL_PAPERCLIP_ISSUE_URL)");
  }

  if (discordUrl) {
    try {
      const response = await fetch(discordUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Discord hard-caps a message at 2000 characters.
          content: report.slice(0, 1900),
          // Server-side authority over mentions: a PR title carried in this
          // body must never be able to page the whole channel.
          allowed_mentions: { parse: [] },
        }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
      delivered.push("discord");
    } catch (error) {
      console.error(`::warning::discord sink failed: ${error.message}`);
    }
  } else {
    console.log("::notice::discord sink not configured (SENTINEL_DISCORD_WEBHOOK_URL)");
  }

  return delivered;
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
  const { snapshot, errors } = await collectSnapshot(new GitHub(token), repo, thresholds);
  const { findings, skipped } = evaluate(snapshot);
  const previous = await readState(statePath);
  const { alerts, resolved, nextState } = diffFindings(findings, previous, {
    nowMs: snapshot.nowMs,
    scanComplete: errors.length === 0,
  });

  console.log(
    `scanned ${repo}: ${snapshot.openPulls.length} open PR(s), ${findings.length} condition(s) standing, ${alerts.length} to announce, ${resolved.length} cleared`,
  );
  for (const entry of skipped) console.log(`::notice::skipped ${entry.condition}: ${entry.reason}`);
  for (const error of errors) console.error(`::warning::partial read: ${error}`);

  if (alerts.length > 0) {
    const delivered = await deliver(repo, alerts, dryRun);
    console.log(renderReport(repo, alerts));
    console.log(`delivered via: ${delivered.join(", ") || "nothing configured"}`);
    await summarize([`### Silence sentinel — ${alerts.length} announced`, "", ...alerts.map(renderAlert)]);

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

  if (!dryRun) await writeState(statePath, nextState);
}

main().catch((error) => {
  // A sentinel that dies quietly is the very bug it exists to catch, so a total
  // failure is loud: the workflow run goes red.
  console.error(`::error::silence sentinel failed: ${error.message}`);
  process.exitCode = 1;
});
