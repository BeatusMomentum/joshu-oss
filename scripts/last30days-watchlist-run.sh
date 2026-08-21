#!/usr/bin/env bash
# Hermes no-agent cron: re-run last30days Watching topics (7-day window).
# Joshu boot rewrites ~/.hermes/scripts/last30days-watchlist-run.sh from the
# last30days manifest (cadence=daily). This copy is the repo fallback.
set -euo pipefail
CADENCE="${1:-daily}"
ORIGIN="${JOSHU_BOX_ORIGIN:-http://127.0.0.1:8788}"
PREFIX="${PUBLIC_BASE_PATH:-/joshu}"
curl -fsS -X POST "${ORIGIN}${PREFIX}/api/apps/last30days/invoke" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<JSON
{"action":"watchlistRunAll","args":{"cadence":"${CADENCE}"}}
JSON
