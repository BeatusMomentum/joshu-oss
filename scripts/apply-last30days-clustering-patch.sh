#!/usr/bin/env bash
# Apply Joshu clustering/ordering patches to the vendored last30days-skill tree.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "${ROOT_DIR}/scripts/patch-last30days-clustering.py"
