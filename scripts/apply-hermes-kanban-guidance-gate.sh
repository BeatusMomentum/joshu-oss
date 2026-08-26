#!/usr/bin/env bash
# Gate KANBAN_GUIDANCE on HERMES_KANBAN_TASK — see patch-hermes-kanban-guidance-gate.py
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-kanban-guidance-gate.py"

if [[ ! -f "${HERMES_DIR}/run_agent.py" && ! -f "${HERMES_DIR}/agent/agent_init.py" ]]; then
  echo "[hermes-kanban-guidance-gate] skip: no Hermes agent init files under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-kanban-guidance-gate] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-kanban-guidance-gate] applying via patch-hermes-kanban-guidance-gate.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
