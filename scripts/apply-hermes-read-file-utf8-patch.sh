#!/usr/bin/env bash
# Fix Hermes read_file false-binary on UTF-8 head truncations + AppleDouble skip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
TARGET="${HERMES_DIR}/tools/file_operations.py"
PATCHER="${SCRIPT_DIR}/patch-hermes-read-file-utf8.py"

if [[ ! -f "${TARGET}" ]]; then
  echo "[hermes-read-file-utf8-patch] skip: ${TARGET} not found"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-read-file-utf8-patch] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-read-file-utf8-patch] applying via patch-hermes-read-file-utf8.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
