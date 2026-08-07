#!/usr/bin/env bash
# Ensure Python ≥3.12 for last30days engine (uv install on boxes missing image layer).
set -euo pipefail

TARGET="${LAST30DAYS_PYTHON:-/opt/joshu/.local/python312/bin/python3.12}"

if [[ -x "${TARGET}" ]]; then
  echo "[ensure-last30days-python] ok ${TARGET} ($("${TARGET}" --version 2>&1))"
  exit 0
fi

echo "[ensure-last30days-python] ${TARGET} missing — installing Python 3.12 via uv…" >&2
UV="${HOME}/.local/bin/uv"
if [[ ! -x "${UV}" ]]; then
  curl -fsSL https://astral.sh/uv/install.sh | sh
fi
"${UV}" python install 3.12
mkdir -p "$(dirname "${TARGET}")"
ln -sf "${HOME}/.local/share/uv/python/cpython-3.12-"*/bin/python3.12 "${TARGET}"
echo "[ensure-last30days-python] installed ${TARGET} ($("${TARGET}" --version 2>&1))"
