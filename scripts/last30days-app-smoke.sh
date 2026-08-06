#!/usr/bin/env bash
# Smoke the Joshu last30days API (expects Joshu on :8788 after npm run build && npm start|/dev).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${LAST30DAYS_SMOKE_BASE:-http://127.0.0.1:8788/joshu/api/last30days}"

if [[ ! -f "${ROOT_DIR}/integrations/last30days-skill/skills/last30days/scripts/last30days.py" ]]; then
  echo "[smoke] syncing engine…"
  bash "${ROOT_DIR}/scripts/sync-last30days-skill.sh"
fi

echo "[smoke] GET status → ${BASE}/status"
curl -fsS "${BASE}/status" | head -c 800
echo

echo "[smoke] runner unit"
cd "${ROOT_DIR}" && npm run test:last30days-runner

LIVE_BODY='{"topic":"OpenAI","emit":"json","jsonProfile":"agent","quick":true,"mock":true}'
if [[ "${LAST30DAYS_SMOKE_LIVE:-}" =~ ^(1|true|yes)$ ]]; then
  LIVE_BODY='{"topic":"OpenAI","emit":"json","jsonProfile":"agent","quick":true,"mock":false}'
  echo "[smoke] LIVE research (no --mock)"
else
  echo "[smoke] mock research"
fi

RESP="$(curl -fsS -X POST "${BASE}/research" -H 'Content-Type: application/json' -d "${LIVE_BODY}")"
echo "${RESP}"
RUN_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])' <<<"${RESP}")"

echo "[smoke] waiting for run ${RUN_ID}"
for _ in $(seq 1 180); do
  DETAIL="$(curl -fsS "${BASE}/runs/${RUN_ID}")"
  STATUS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["run"]["status"])' <<<"${DETAIL}")"
  if [[ "${STATUS}" == "completed" || "${STATUS}" == "failed" || "${STATUS}" == "cancelled" ]]; then
    echo "[smoke] status=${STATUS}"
    python3 -c 'import json,sys; r=json.load(sys.stdin)["run"]; print("exit", r.get("exitCode"), "stdout_bytes", len(r.get("stdout") or ""))' <<<"${DETAIL}"
    if [[ "${STATUS}" != "completed" ]]; then
      echo "${DETAIL}" | head -c 2000
      exit 1
    fi
    # Assert argv hardening
    python3 -c "
import json,sys
run=json.load(sys.stdin)['run']
argv=' '.join(run.get('argv') or [])
assert '--no-browser-cookies' in argv, argv
assert 'web-backend=keyless' in argv or '--web-backend=keyless' in argv, argv
print('ok hardened argv')
" <<<"${DETAIL}"
    echo "[smoke] ok"
    exit 0
  fi
  sleep 1
done

echo "[smoke] timeout waiting for run" >&2
exit 1
