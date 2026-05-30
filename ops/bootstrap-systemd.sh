#!/usr/bin/env bash
# Paperclip systemd bootstrap — FIG-763.
#
# RUN AS ROOT, ONCE PER HOST. This script installs the paperclip systemd unit
# from ops/paperclip.service, sets up the /etc/paperclip env directory, and
# migrates a (legacy) nohup-running process onto systemd without dropping the
# embedded postgres datadir lock badly.
#
# Idempotent: safe to re-run; detects existing install and skips already-done
# steps.
#
# Pre-checks done by the script:
#   - target user 'ivan' exists
#   - /home/ivan/dev/paperclip exists
#   - /home/ivan/start-paperclip-prod.sh exists and is executable
#   - /etc/paperclip/paperclip-prod.env exists with mode 600 (operator must
#     create with the actual secrets — see Prerequisites in RUNBOOK)
#
# After install:
#   - paperclip.service active + enabled
#   - kills any pre-existing nohup tsx process (if found) and lets systemd
#     respawn
#   - waits for /api/health to report ok before declaring success
#
# Federico ran an earlier version of this manually on 2026-05-19 (FIG-443).
# This script versions and makes the procedure repeatable, e.g. for AUTO/VPS-6
# secondary or for the v2026.529.0 alignment on a fresh host.

set -euo pipefail

UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paperclip.service"
UNIT_DST="/etc/systemd/system/paperclip.service"
ENV_DIR="/etc/paperclip"
ENV_FILE="${ENV_DIR}/paperclip-prod.env"
SVC_USER="ivan"
LAUNCHER="/home/ivan/start-paperclip-prod.sh"
REPO_DIR="/home/ivan/dev/paperclip"
HEALTH_URL="http://127.0.0.1:3100/api/health"
HEALTH_TIMEOUT_SECONDS=60

die() { echo "FATAL: $*" >&2; exit 1; }

# ---- 0. assertions ---------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "must run as root"
[[ -f "$UNIT_SRC" ]]    || die "unit source not found at ${UNIT_SRC}"
id -u "$SVC_USER" >/dev/null 2>&1 || die "user ${SVC_USER} does not exist"
[[ -d "$REPO_DIR" ]]    || die "repo not found at ${REPO_DIR}"
[[ -x "$LAUNCHER" ]]    || die "launcher not found / not executable: ${LAUNCHER}"

# ---- 1. /etc/paperclip env directory --------------------------------------
if [[ ! -d "$ENV_DIR" ]]; then
  install -d -m 700 -o root -g root "$ENV_DIR"
  echo "created ${ENV_DIR} (root:root 700)"
else
  echo "${ENV_DIR} already exists; leaving perms alone"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cat <<'EOF' >&2
${ENV_FILE} does not exist. Create it now with the production secrets BEFORE
re-running bootstrap. Suggested content (mode 600 root:root):

  PAPERCLIP_AGENT_JWT_SECRET=<64-char hex>
  BETTER_AUTH_SECRET=<64-char hex>

These were extracted from the previous launcher under FIG-443 (2026-05-19).
On VPS-3 the canonical file is already in place.
EOF
  die "${ENV_FILE} missing"
fi

env_mode="$(stat -c '%a' "$ENV_FILE")"
env_owner="$(stat -c '%U:%G' "$ENV_FILE")"
[[ "$env_mode" == "600" ]]      || die "${ENV_FILE} mode is ${env_mode}; must be 600"
[[ "$env_owner" == "root:root" ]] || die "${ENV_FILE} owner is ${env_owner}; must be root:root"
echo "${ENV_FILE} present, mode 600 root:root"

# ---- 2. install / refresh the unit file -----------------------------------
if [[ -f "$UNIT_DST" ]] && cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "${UNIT_DST} already matches ${UNIT_SRC}; skipping copy"
else
  install -m 644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
  echo "installed ${UNIT_DST} (root:root 644)"
  systemctl daemon-reload
  echo "systemctl daemon-reload done"
fi

# ---- 3. enable + start ----------------------------------------------------
systemctl enable paperclip
echo "paperclip enabled (start on boot)"

# Migrate legacy nohup process if present. Look for tsx src/index.ts that
# (a) has cwd under our REPO_DIR, AND (b) is OUTSIDE the systemd paperclip
# cgroup. Both conditions required:
#   - cwd filter (FIG-772 fix #2) excludes unrelated foreign `tsx src/index.ts`
#     processes on the host (e.g. an unrelated tsx app, another agent's
#     paperclip checkout). A legitimate legacy nohup-tsx Paperclip process
#     always has cwd under /home/ivan/dev/paperclip.
#   - cgroup filter excludes the unit's own process (already systemd-managed).
LEGACY_PIDS="$(pgrep -f 'tsx.*src/index.ts' | while read -r pid; do
  cwd="$(readlink /proc/$pid/cwd 2>/dev/null || true)"
  cg="$(cat /proc/$pid/cgroup 2>/dev/null || true)"
  if [[ "$cwd" == "$REPO_DIR"* ]] && [[ "$cg" != *"system.slice/paperclip.service"* ]]; then
    echo "$pid"
  fi
done)"

if [[ -n "$LEGACY_PIDS" ]]; then
  echo "detected legacy tsx process(es) outside systemd cgroup: ${LEGACY_PIDS}"
  for pid in $LEGACY_PIDS; do
    kill -TERM "$pid" || true
  done
  # Wait for the embedded postgres to release its datadir lock.
  sleep 10
  for pid in $LEGACY_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "WARN: legacy pid ${pid} still alive after 10s — SIGKILL"
      kill -KILL "$pid" || true
    fi
  done
  sleep 2
fi

if ! systemctl is-active --quiet paperclip; then
  systemctl start paperclip
  echo "started paperclip via systemd"
else
  echo "paperclip already active via systemd; not restarting"
fi

# ---- 4. health check ------------------------------------------------------
echo "waiting for /api/health (max ${HEALTH_TIMEOUT_SECONDS}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
while [[ $(date +%s) -lt $deadline ]]; do
  body="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
  if echo "$body" | grep -q '"status":"ok"'; then
    echo "health OK"
    echo "=== bootstrap complete ==="
    systemctl status paperclip --no-pager | head -20
    exit 0
  fi
  sleep 2
done

die "health check did not pass within ${HEALTH_TIMEOUT_SECONDS}s — inspect journalctl -u paperclip"
