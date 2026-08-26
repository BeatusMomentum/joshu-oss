#!/usr/bin/env bash
# X-Hermes-Platform-Toolsets header for api_server chat completions — see patch script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-api-server-platform-toolsets.py"

if [[ ! -f "${HERMES_DIR}/gateway/platforms/api_server.py" ]]; then
  echo "[hermes-api-server-platform-toolsets] skip: missing api_server.py"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-api-server-platform-toolsets] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-api-server-platform-toolsets] applying via patch-hermes-api-server-platform-toolsets.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
