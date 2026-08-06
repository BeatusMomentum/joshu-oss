#!/usr/bin/env bash
# Apply Joshu ScrapeCreators relay shim to vendored last30days-skill/http.py.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "${ROOT_DIR}/scripts/patch-last30days-sc-relay.py"
