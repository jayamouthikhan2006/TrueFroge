#!/usr/bin/env bash
# One-command bootstrap for ForgeCode:
#   1. starts the local TrueForge harness (npx @truefoundry/trueforge@latest,
#      SQLite, http://localhost:8790) in the background if it is not running,
#      with loopback allowed as an outbound host so it can reach the
#      extension's MCP server (and local model endpoints),
#   2. builds the extension (which also builds the provisioning CLI),
#   3. registers the primary + fallback model providers, the workspace MCP
#      server, the skill packs and the forge-coding-agent definition.
#
# Usage: scripts/setup-trueforge.sh [--restart] [--no-start] [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.logs"
PID_FILE="$LOG_DIR/trueforge.pid"
TRUEFORGE_URL="${TRUEFORGE_BASE_URL:-http://localhost:8790}"
RESTART=0
START=1
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --no-start) START=0 ;;
    --skip-build) BUILD=0 ;;
    -h|--help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "node (>= 20) is required" >&2; exit 1; }
command -v npx >/dev/null || { echo "npx is required" >&2; exit 1; }
mkdir -p "$LOG_DIR"

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "created .env from .env.example - fill in FORGE_PRIMARY_* / FORGE_FALLBACK_* and re-run"
fi

is_up() {
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$TRUEFORGE_URL/api/v1/capabilities" || true)" = "200" ]
}

stop_trueforge() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "stopping TrueForge (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # npx launches node as a child; on Windows (Git Bash) it is not in our
  # process group, so stop whatever still listens on the port.
  if is_up && command -v powershell.exe >/dev/null; then
    local port="${TRUEFORGE_URL##*:}"
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 20); do is_up || return 0; sleep 0.5; done
  echo "TrueForge is still listening on $TRUEFORGE_URL; stop it manually" >&2
  exit 1
}

if [ "$RESTART" = 1 ]; then
  stop_trueforge
fi

if is_up; then
  echo "TrueForge already running at $TRUEFORGE_URL"
elif [ "$START" = 1 ]; then
  echo "starting TrueForge (log: .logs/trueforge.log)"
  (
    cd "$ROOT"
    OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' \
      nohup npx -y @truefoundry/trueforge@latest >"$LOG_DIR/trueforge.log" 2>&1 &
    echo $! >"$PID_FILE"
  )
  for i in $(seq 1 180); do
    if is_up; then echo "TrueForge is up after ${i}s"; break; fi
    sleep 1
  done
  is_up || { echo "TrueForge did not come up; see .logs/trueforge.log" >&2; tail -20 "$LOG_DIR/trueforge.log" >&2; exit 1; }
else
  echo "TrueForge is not running at $TRUEFORGE_URL (and --no-start was given)" >&2
  exit 1
fi

# Gemini 3.x thought-signature gateway (scripts/gemini-gateway.mjs), started
# only when a provider in .env points at it.
GATEWAY_PORT="${FORGE_GEMINI_GATEWAY_PORT:-8792}"
if grep -Eq "^FORGE_(PRIMARY|FALLBACK)_BASE_URL=https?://(127\.0\.0\.1|localhost):$GATEWAY_PORT" "$ROOT/.env"; then
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/" || true)" != "000" ]; then
    echo "gemini-gateway already running on :$GATEWAY_PORT"
  else
    echo "starting gemini-gateway on :$GATEWAY_PORT (log: .logs/gemini-gateway.log)"
    nohup node "$ROOT/scripts/gemini-gateway.mjs" --port "$GATEWAY_PORT" >"$LOG_DIR/gemini-gateway.log" 2>&1 &
    echo $! >"$LOG_DIR/gemini-gateway.pid"
    for _ in $(seq 1 20); do
      [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/" || true)" != "000" ] && break
      sleep 0.5
    done
  fi
fi

if [ "$BUILD" = 1 ] || [ ! -f "$ROOT/extension/dist/provision.js" ]; then
  echo "building extension"
  (cd "$ROOT/extension" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run --silent build)
fi

TRUEFORGE_BASE_URL="$TRUEFORGE_URL" node "$ROOT/extension/dist/provision.js" --config "$ROOT/trueforge-config" --env "$ROOT/.env"

echo "TrueForge UI: $TRUEFORGE_URL   API docs: $TRUEFORGE_URL/api/v1/docs"
