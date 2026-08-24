#!/usr/bin/env bash
# Start fal.ai metered MCP relay (Hermes → local :8797 → CP → mcp.fal.ai).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export JOSHU_METERED_MCP_PROVIDER_ID="${JOSHU_METERED_MCP_PROVIDER_ID:-fal}"
export JOSHU_METERED_MCP_PORT="${JOSHU_METERED_MCP_PORT:-8797}"
export JOSHU_METERED_MCP_HOST="${JOSHU_METERED_MCP_HOST:-127.0.0.1}"
export JOSHU_METERED_MCP_RELAY_URL="${JOSHU_METERED_MCP_RELAY_URL:-${JOSHU_FAL_RELAY_URL:-}}"

PID_FILE="${JOSHU_FAL_MCP_PID_FILE:-${HOME}/.joshu/fal-mcp-relay.pid}"
LOG_FILE="${JOSHU_FAL_MCP_LOG_FILE:-${HOME}/.joshu/fal-mcp-relay.log}"
HEALTH_URL="http://${JOSHU_METERED_MCP_HOST}:${JOSHU_METERED_MCP_PORT}/health"

mkdir -p "$(dirname "${PID_FILE}")" "$(dirname "${LOG_FILE}")"

health_ok() {
  curl -fsS "${HEALTH_URL}" >/dev/null 2>&1
}

stop_stale() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 0
  fi
  local old_pid
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
}

if [[ -z "${JOSHU_METERED_MCP_RELAY_URL}" ]]; then
  echo "[fal-mcp-relay] JOSHU_FAL_RELAY_URL not set — skipping start" >&2
  exit 0
fi

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null && health_ok; then
    echo "[fal-mcp-relay] already running pid=${old_pid}"
    exit 0
  fi
  echo "[fal-mcp-relay] stale or unhealthy pid=${old_pid:-none}; restarting" >&2
  stop_stale
fi

nohup node "${APP_DIR}/scripts/lib/metered-mcp-relay.mjs" >>"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
sleep 1
if health_ok; then
  echo "[fal-mcp-relay] started pid=$(cat "${PID_FILE}")"
else
  echo "[fal-mcp-relay] started but health check failed — see ${LOG_FILE}" >&2
fi
