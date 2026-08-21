#!/usr/bin/env bash
# Apply Joshu xquik relay shim to vendored last30days-skill/http.py.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "${ROOT_DIR}/scripts/patch-last30days-xquik-relay.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-watch-window.py"
