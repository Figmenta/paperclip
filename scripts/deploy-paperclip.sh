#!/usr/bin/env bash
# Paperclip atomic deploy — FIG-763 F1.
# Only sanctioned way to change running prod code on VPS-3 DBAGENTS.
#
# Usage:
#   ./deploy-paperclip.sh [--ref <git-ref>] [--dry-run] [--skip-stage-confirm]
#
# Default ref is origin/master. With --dry-run, prints the plan without touching prod.
# Requires: ivan has NOPASSWD on `systemctl restart paperclip` (configured by Federico).

set -euo pipefail

# ---- config ----------------------------------------------------------------
REPO_DIR="/home/ivan/dev/paperclip"
STATE_DIR="/home/ivan/.paperclip-deploy-state"
BACKUP_DIR="/home/ivan/.paperclip/instances/default/data/backups"
LOG_FILE="${STATE_DIR}/deploy.log"
DATABASE_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/postgres}"
HEALTH_URL="http://127.0.0.1:3100/api/health"
HEALTH_TIMEOUT_SECONDS=60
TARGET_REF="origin/master"
DRY_RUN=0
SKIP_STAGE_CONFIRM=0
CURRENT_HEAD=""
PRE_DUMP=""

# ---- args ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) TARGET_REF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-stage-confirm) SKIP_STAGE_CONFIRM=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== deploy-paperclip.sh start ${TS} target=${TARGET_REF} dry-run=${DRY_RUN} ==="

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

rollback() {
  echo "=== ROLLBACK: restoring ${CURRENT_HEAD:-UNKNOWN} ==="
  if [[ -n "${CURRENT_HEAD:-}" ]]; then
    git checkout "$CURRENT_HEAD" 2>&1 || true
  fi
  echo "code restored on disk. DB dump at ${PRE_DUMP:-N/A}."
  echo "If migrate ran before failure, restore DB manually:"
  echo "  gunzip -c '${PRE_DUMP:-N/A}' | psql '${DATABASE_URL}'"
  sudo -n systemctl restart paperclip 2>&1 || echo "manual restart required: sudo systemctl restart paperclip"
}

# ---- phase 1: pre-flight ---------------------------------------------------
cd "$REPO_DIR"
[[ -d .git ]] || die "not a git checkout: $REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree dirty — refuse to deploy. Inspect: git status"
fi

git fetch --quiet origin
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"
TARGET_SHA="$(git rev-parse "$TARGET_REF")"

echo "current: ${CURRENT_BRANCH} @ ${CURRENT_HEAD}"
echo "target:  ${TARGET_REF} @ ${TARGET_SHA}"

if [[ "$CURRENT_HEAD" == "$TARGET_SHA" ]]; then
  echo "already at target; nothing to deploy. running invariant probe only."
  run "DATABASE_URL='${DATABASE_URL}' tsx ${REPO_DIR}/server/scripts/probe-binding-invariant.ts" \
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
# Reuse the most recent in-process backup if <5 min old. Otherwise refuse —
# operator must POST /api/instance/database-backups (instance-admin auth) or wait
# for the next scheduled cycle. Refusal is intentional — no rollback baseline,
# no deploy.
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

# ---- phase 7: restart ------------------------------------------------------
run "sudo -n systemctl restart paperclip" \
  || die "systemctl restart failed (sudo NOPASSWD required for ivan → systemctl restart paperclip)"

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
if ! run "cd '${REPO_DIR}' && DATABASE_URL='${DATABASE_URL}' tsx server/scripts/reconcile-bindings.ts --apply --label 'deploy-${TS}'"; then
  echo "reconcile FAILED — rolling back"; rollback; exit 1
fi
if ! run "cd '${REPO_DIR}' && DATABASE_URL='${DATABASE_URL}' tsx server/scripts/probe-binding-invariant.ts"; then
  echo "binding invariant FAILED — rolling back"; rollback; exit 1
fi

# ---- phase 10: record new pinned ref ---------------------------------------
NEW_HEAD="$(git rev-parse HEAD)"
NEW_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"
run "echo '${NEW_HEAD}' > '${STATE_DIR}/current-pinned-ref.txt'"
run "echo '${NEW_BRANCH}' >> '${STATE_DIR}/current-pinned-ref.txt'"

echo "=== deploy OK: ${CURRENT_HEAD} -> ${NEW_HEAD} ref=${NEW_BRANCH} ==="
exit 0
