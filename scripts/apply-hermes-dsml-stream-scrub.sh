#!/usr/bin/env bash
# Apply Joshu DSML stream scrub patch to the local Hermes checkout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHER="${SCRIPT_DIR}/patch-hermes-dsml-stream-scrub.py"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-dsml-scrub] missing patcher: ${PATCHER}" >&2
  exit 1
fi

if [[ ! -d "${HERMES_DIR}" ]]; then
  echo "[hermes-dsml-scrub] skip — HERMES_DIR not found: ${HERMES_DIR}" >&2
  exit 0
fi

echo "[hermes-dsml-scrub] applying via patch-hermes-dsml-stream-scrub.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
