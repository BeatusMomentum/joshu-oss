#!/usr/bin/env bash
# Keep Hermes auto_decompose off EA scheduling/mail boards (single-worker cards).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-ea-kanban-no-autodecompose.py"

if [[ ! -f "${HERMES_DIR}/gateway/kanban_watchers.py" ]]; then
  echo "[hermes-ea-kanban-no-autodecompose] skip: Hermes gateway not found under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-ea-kanban-no-autodecompose] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-ea-kanban-no-autodecompose] applying via patch-hermes-ea-kanban-no-autodecompose.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
