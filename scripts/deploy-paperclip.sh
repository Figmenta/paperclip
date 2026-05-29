#!/usr/bin/env bash
# Paperclip atomic deploy — FIG-763 F1.
# Only sanctioned way to change running prod code on VPS-3 DBAGENTS.
#
# Fork-tracking policy (Federico 2026-05-29): align ONLY to upstream STABLE tags
# (vYYYY.MMDD.0). Never to upstream/master, never to canary tags. Local fork
# patches rebase onto each new stable base; conflicts surface in F2 staging
# before prod ever sees them.
#
# No-root operation (Federico 2026-05-29T19:21Z): NO sudo, no NOPASSWD asks,
# no privilege escalation in the deploy path. Restart is unprivileged:
# kill -TERM the systemd MainPID (process is User=ivan, so ivan owns it) and
# rely on the unit's Restart=always to respawn within RestartSec. systemd's
# KillMode=control-group cleans up the whole cgroup (tsx + embedded postgres)
# before respawn, so no datadir-lock race.
#
# Usage:
#   ./deploy-paperclip.sh --tag vYYYY.MMDD.0 [--dry-run]
#   ./deploy-paperclip.sh --ref <sha-or-branch> --allow-non-tag [--dry-run]

set -euo pipefail

# ---- config ----------------------------------------------------------------
REPO_DIR="/home/ivan/dev/paperclip"
STATE_DIR="/home/ivan/.paperclip-deploy-state"
BACKUP_DIR="/home/ivan/.paperclip/instances/default/data/backups"
LOG_FILE="${STATE_DIR}/deploy.log"
DATABASE_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"
HEALTH_URL="http://127.0.0.1:3100/api/health"
HEALTH_TIMEOUT_SECONDS=60
RESPAWN_TIMEOUT_SECONDS=30
SYSTEMD_UNIT="paperclip"
TARGET_REF=""
TARGET_TAG=""
ALLOW_NON_TAG=0
DRY_RUN=0
SKIP_STAGE_CONFIRM=0
CURRENT_HEAD=""
PRE_DUMP=""

# Stable-tag pattern: vYYYY.MMDD.N. Rejects -canary, -beta, -rc, any suffix.
STABLE_TAG_PATTERN='^v[0-9]{4}\.[0-9]{1,3}\.[0-9]+$'

# ---- args ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TARGET_TAG="$2"; shift 2 ;;
    --ref) TARGET_REF="$2"; shift 2 ;;
    --allow-non-tag) ALLOW_NON_TAG=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-stage-confirm) SKIP_STAGE_CONFIRM=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
exec > >(tee -a "$LOG_FILE") 2>&1

# ---- helpers (defined before use) ------------------------------------------
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: $*"
  else
    echo "RUN: $*"
    eval "$@"
  fi
}

die() { echo "FATAL: $*" >&2; exit 1; }

# unprivileged restart: SIGTERM MainPID, poll for new PID up to RESPAWN_TIMEOUT.
restart_paperclip_noroot() {
  local old_pid
  old_pid="$(systemctl show "$SYSTEMD_UNIT" -p MainPID --value || echo 0)"
  if [[ "$old_pid" -le 1 ]]; then
    die "no live MainPID for ${SYSTEMD_UNIT} (got '${old_pid}') — unit not active"
  fi
  if ! kill -0 "$old_pid" 2>/dev/null; then
    die "ivan cannot signal MainPID ${old_pid} (process not owned by ivan?)"
  fi
  echo "unprivileged restart: SIGTERM MainPID=${old_pid} (systemd Restart=always will respawn)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: kill -TERM ${old_pid}"
    return 0
  fi
  kill -TERM "$old_pid" || die "kill -TERM ${old_pid} failed"
  local deadline=$(( $(date +%s) + RESPAWN_TIMEOUT_SECONDS ))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 1
    local new_pid
    new_pid="$(systemctl show "$SYSTEMD_UNIT" -p MainPID --value || echo 0)"
    if [[ "$new_pid" -gt 1 && "$new_pid" != "$old_pid" ]]; then
      # Confirm new pid is actually running.
      if kill -0 "$new_pid" 2>/dev/null; then
        echo "respawned: ${old_pid} -> ${new_pid}"
        return 0
      fi
    fi
  done
  die "paperclip did not respawn within ${RESPAWN_TIMEOUT_SECONDS}s after SIGTERM ${old_pid}"
}

rollback() {
  echo "=== ROLLBACK: restoring ${CURRENT_HEAD:-UNKNOWN} ==="
  if [[ -n "${CURRENT_HEAD:-}" ]]; then
    git checkout "$CURRENT_HEAD" 2>&1 || true
  fi
  echo "code restored on disk. DB dump at ${PRE_DUMP:-N/A}."
  echo "If migrate ran before failure, restore DB manually:"
  echo "  gunzip -c '${PRE_DUMP:-N/A}' | psql '${DATABASE_URL}'"
  restart_paperclip_noroot 2>&1 || echo "manual recovery required (see RUNBOOK rollback section)"
}

# ---- resolve target (tag vs ref) ------------------------------------------
cd "$REPO_DIR"
git fetch --quiet origin
git fetch --quiet upstream --tags 2>&1 || echo "WARN: upstream fetch failed (continuing with cached tags)"

if [[ -n "$TARGET_TAG" && -n "$TARGET_REF" ]]; then
  die "--tag and --ref are mutually exclusive"
fi

if [[ -n "$TARGET_TAG" ]]; then
  if ! [[ "$TARGET_TAG" =~ $STABLE_TAG_PATTERN ]]; then
    die "tag '${TARGET_TAG}' does not match stable pattern ${STABLE_TAG_PATTERN} — canary/beta/rc tags are not deployable per fork-tracking policy"
  fi
  if ! git rev-parse --verify "${TARGET_TAG}^{commit}" >/dev/null 2>&1; then
    die "tag '${TARGET_TAG}' not present in repo. Did you fetch upstream --tags?"
  fi
  TARGET_REF="$TARGET_TAG"
  echo "=== deploy-paperclip.sh start ${TS} tag=${TARGET_TAG} dry-run=${DRY_RUN} ==="
elif [[ -n "$TARGET_REF" ]]; then
  if [[ "$ALLOW_NON_TAG" -ne 1 ]]; then
    die "--ref requires --allow-non-tag (fork-tracking policy: only stable tags by default). Refusing ref '${TARGET_REF}'."
  fi
  echo "=== deploy-paperclip.sh start ${TS} ref=${TARGET_REF} TAG=NONE (operator-escape) dry-run=${DRY_RUN} ==="
else
  TARGET_TAG="$(git tag -l 'v*' | grep -E "${STABLE_TAG_PATTERN#^}" | grep -vE '^$' | sort -V | tail -1 || true)"
  [[ -n "$TARGET_TAG" ]] || die "no stable tag found in repo. Pass --tag explicitly."
  TARGET_REF="$TARGET_TAG"
  echo "=== deploy-paperclip.sh start ${TS} tag=${TARGET_TAG} (auto-detected latest stable) dry-run=${DRY_RUN} ==="
fi

# ---- phase 1: pre-flight ---------------------------------------------------
[[ -d .git ]] || die "not a git checkout: $REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree dirty — refuse to deploy. Inspect: git status"
fi

CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"
TARGET_SHA="$(git rev-parse "$TARGET_REF")"

echo "current: ${CURRENT_BRANCH} @ ${CURRENT_HEAD}"
echo "target:  ${TARGET_REF} @ ${TARGET_SHA}"

if [[ "$CURRENT_HEAD" == "$TARGET_SHA" ]]; then
  echo "already at target; running invariant probe only."
  run "DATABASE_URL='${DATABASE_URL}' /home/ivan/dev/paperclip/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs ${REPO_DIR}/server/scripts/probe-binding-invariant.ts" \
    || die "binding invariant probe FAILED on no-op deploy — bindings drifted from runtime config"
  echo "=== no-op deploy OK ==="
  exit 0
fi

# ---- phase 2: record current pinned ref (for rollback) ---------------------
PREV_REF_FILE="${STATE_DIR}/prev-pinned-ref.txt"
run "echo '${CURRENT_HEAD}' > '${PREV_REF_FILE}'"
run "echo '${CURRENT_BRANCH}' >> '${PREV_REF_FILE}'"
echo "previous ref recorded at ${PREV_REF_FILE}"

# ---- phase 3: pre-migrate dump --------------------------------------------
PRE_DUMP="${STATE_DIR}/pre-deploy-${TS}.sql.gz"
LATEST_BACKUP="$(ls -t ${BACKUP_DIR}/paperclip-*.sql.gz 2>/dev/null | head -1 || true)"
if [[ -n "$LATEST_BACKUP" ]]; then
  LATEST_AGE=$(( $(date +%s) - $(stat -c %Y "$LATEST_BACKUP") ))
  if [[ "$LATEST_AGE" -le 300 ]]; then
    run "cp '${LATEST_BACKUP}' '${PRE_DUMP}'"
    echo "pre-deploy dump: ${PRE_DUMP} (sourced from ${LATEST_BACKUP}, age ${LATEST_AGE}s)"
  else
    die "latest scheduled backup is ${LATEST_AGE}s old (>5min). Trigger manual via API and re-run."
  fi
else
  die "no scheduled backup found in ${BACKUP_DIR}. Cannot proceed without rollback baseline."
fi

# ---- phase 4: checkout target ----------------------------------------------
run "git checkout '${TARGET_REF}'"
run "git rev-parse HEAD"

# ---- phase 5: install (only if lockfile changed) ---------------------------
if git diff --quiet "${CURRENT_HEAD}" "${TARGET_SHA}" -- pnpm-lock.yaml; then
  echo "pnpm-lock.yaml unchanged — skipping install"
else
  run "pnpm install --frozen-lockfile"
fi

# ---- phase 6: migrate ------------------------------------------------------
if ! run "cd '${REPO_DIR}' && DATABASE_URL='${DATABASE_URL}' pnpm db:migrate"; then
  echo "migrate FAILED — rolling back"; rollback; exit 1
fi

# ---- phase 7: restart (UNPRIVILEGED) ---------------------------------------
if ! restart_paperclip_noroot; then
  echo "restart FAILED — rolling back"; rollback; exit 1
fi

# ---- phase 8: health check -------------------------------------------------
echo "waiting for /api/health (max ${HEALTH_TIMEOUT_SECONDS}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
healthy=0
while [[ $(date +%s) -lt $deadline ]]; do
  if [[ "$DRY_RUN" -eq 1 ]]; then healthy=1; break; fi
  body="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
  if echo "$body" | grep -q '"status":"ok"'; then healthy=1; break; fi
  sleep 2
done
if [[ "$healthy" -ne 1 ]]; then
  echo "health check failed — rolling back"; rollback; exit 1
fi
echo "health OK"

# ---- phase 9: F3 reconcile + invariant probe -------------------------------
TSX_BIN="/home/ivan/dev/paperclip/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs"
if ! run "cd '${REPO_DIR}' && DATABASE_URL='${DATABASE_URL}' '${TSX_BIN}' server/scripts/reconcile-bindings.ts --apply --label 'deploy-${TS}'"; then
  echo "reconcile FAILED — rolling back"; rollback; exit 1
fi
if ! run "cd '${REPO_DIR}' && DATABASE_URL='${DATABASE_URL}' '${TSX_BIN}' server/scripts/probe-binding-invariant.ts"; then
  echo "binding invariant FAILED — rolling back"; rollback; exit 1
fi

# ---- phase 10: record new pinned ref ---------------------------------------
NEW_HEAD="$(git rev-parse HEAD)"
NEW_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"
run "echo '${NEW_HEAD}' > '${STATE_DIR}/current-pinned-ref.txt'"
run "echo '${NEW_BRANCH}' >> '${STATE_DIR}/current-pinned-ref.txt'"
run "echo 'tag=${TARGET_TAG:-NONE}' >> '${STATE_DIR}/current-pinned-ref.txt'"

echo "=== deploy OK: ${CURRENT_HEAD} -> ${NEW_HEAD} tag=${TARGET_TAG:-NONE} ==="
exit 0
