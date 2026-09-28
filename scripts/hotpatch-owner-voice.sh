#!/usr/bin/env bash
# Hotpatch the owner phone + delivery hardening onto a running Joshu box:
# owner outbox, call gate, inline jobs (voice think budget), CDP relay.
# Surgical dist overlay (no rsync --delete). Does not git pull.
#
# Usage:
#   bash scripts/hotpatch-owner-voice.sh patrick
#   bash scripts/hotpatch-owner-voice.sh root@<slug>.box.example.com
#
# Before running: the box must be idle (no live call, no Kanban worker) — the
# stack is recreated, which ends in-flight Hermes turns.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARG="${1:?usage: hotpatch-owner-voice.sh <slug|user@host>}"
if [[ "${ARG}" == *@* ]]; then
  TARGET="${ARG}"
  HOST="${ARG#*@}"
else
  TARGET="root@${ARG}.box.joshu.me"
  HOST="${ARG}.box.joshu.me"
fi

echo "[owner-voice-hotpatch] building Joshu dist, Telephone app, voice-realtime…"
(cd "${ROOT}" && npx tsc -p tsconfig.json)
(cd "${ROOT}" && npm run build:telephone >/dev/null)
(cd "${ROOT}/packages/voice-realtime" && npm run build >/dev/null)
for f in dist/server.js dist/voiceGate.js dist/cdpRelay.js dist/realtimeGoals/outbox.js \
  dist/realtimeGoals/inlineJobs.js packages/voice-realtime/dist/gate/routes.js; do
  [[ -f "${ROOT}/${f}" ]] || { echo "[owner-voice-hotpatch] missing ${f} after build" >&2; exit 1; }
done

echo "[owner-voice-hotpatch] uploading to ${TARGET}…"
ssh -n -o BatchMode=yes -o ConnectTimeout=15 "${TARGET}" 'true'
rsync -az "${ROOT}/dist/" "${TARGET}:/opt/joshu/dist/"
rsync -az "${ROOT}/scripts/patch-hermes-browser-cdp-guards.mjs" "${TARGET}:/opt/joshu/scripts/"
rsync -az "${ROOT}/.hermes/plugins/joshu-realtime-goals/" \
  "${TARGET}:/opt/joshu/.hermes/plugins/joshu-realtime-goals/"
rsync -az "${ROOT}/packages/voice-realtime/dist/" "${TARGET}:/tmp/vr-dist-owner-voice/"

echo "[owner-voice-hotpatch] applying on box…"
ssh -o BatchMode=yes "${TARGET}" bash -s <<'REMOTE'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
cd /opt/joshu/deploy

echo "[owner-voice-hotpatch] recreate joshu-stack…"
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack
CID=""
for i in $(seq 1 45); do
  CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
  if [[ -n "${CID}" ]] && docker exec "${CID}" true 2>/dev/null; then break; fi
  sleep 2
done
[[ -n "${CID}" ]] || { echo "joshu-stack container not found"; exit 1; }

# Project plugin (pre_llm_call context for Slack/Telegram) — Hermes reads $HERMES_HOME/plugins.
docker exec "${CID}" mkdir -p /opt/joshu/.hermes/plugins/joshu-realtime-goals /root/.hermes/plugins
docker cp /opt/joshu/.hermes/plugins/joshu-realtime-goals/. "${CID}:/opt/joshu/.hermes/plugins/joshu-realtime-goals/"
docker exec "${CID}" rm -rf /root/.hermes/plugins/joshu-realtime-goals
docker cp /opt/joshu/.hermes/plugins/joshu-realtime-goals/. "${CID}:/root/.hermes/plugins/joshu-realtime-goals/"

# Browser tool patch v2 (relay generation). Recreate resets /opt/hermes-agent.
docker cp /opt/joshu/scripts/patch-hermes-browser-cdp-guards.mjs "${CID}:/opt/joshu/scripts/patch-hermes-browser-cdp-guards.mjs"
docker exec "${CID}" node /opt/joshu/scripts/patch-hermes-browser-cdp-guards.mjs /opt/hermes-agent/tools/browser_tool.py
docker exec "${CID}" /opt/hermes-agent/venv/bin/python -m py_compile /opt/hermes-agent/tools/browser_tool.py
docker exec "${CID}" grep -q joshu_cloud_browser_ensure_v2 /opt/hermes-agent/tools/browser_tool.py && echo "browser-patch-v2-ok"
if docker exec "${CID}" test -x /opt/hermes-agent/venv/bin/hermes; then
  docker exec "${CID}" /opt/hermes-agent/venv/bin/hermes plugins enable joshu-realtime-goals 2>/dev/null || true
fi

# voice-realtime: call gate, opener, late answers.
VCID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q voice-realtime | head -1 || true)"
if [[ -n "${VCID}" ]] && [[ -d /tmp/vr-dist-owner-voice ]]; then
  docker cp /tmp/vr-dist-owner-voice/. "${VCID}:/app/dist/"
  docker restart "${VCID}" >/dev/null
  echo "[owner-voice-hotpatch] voice-realtime overlaid"
else
  echo "[owner-voice-hotpatch] voice-realtime container missing" >&2
  exit 1
fi
rm -rf /tmp/vr-dist-owner-voice

# Restart the Hermes gateway so the plugin and patched browser tool load.
pid=$(docker exec "${CID}" python3 -c "import json,pathlib; p=pathlib.Path('/root/.hermes/gateway.pid');
print(json.loads(p.read_text()).get('pid','') if p.is_file() else '')" 2>/dev/null || true)
[[ -n "${pid}" ]] && docker exec "${CID}" kill "${pid}" 2>/dev/null || true
sleep 2

ok=0
for i in $(seq 1 60); do
  code=$(curl -sS -o /tmp/ov-health.json -w "%{http_code}" http://127.0.0.1:8788/joshu/api/instance/health 2>/dev/null || echo 000)
  if [[ "${code}" == "200" ]]; then ok=1; break; fi
  sleep 5
done
[[ "${ok}" == 1 ]] || { echo "Joshu health never came up"; exit 1; }
curl -fsS --max-time 120 "http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1" >/dev/null || true
python3 -c 'import json; h=json.load(open("/tmp/ov-health.json")); print("health", h.get("healthy"), "release", h.get("releaseVersion"))'
docker exec "${CID}" test -f /opt/joshu/dist/voiceGate.js && echo "joshu-dist-ok"
REMOTE

# The gate answers only Twilio-signed requests: an unsigned POST must be refused (403), not 404.
code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "https://${HOST}/voice-rt/gate/start" || echo 000)
echo "[owner-voice-hotpatch] unsigned gate request → ${code} (expect 403)"
[[ "${code}" == "403" ]] || { echo "[owner-voice-hotpatch] call gate not reachable" >&2; exit 1; }
echo "[owner-voice-hotpatch] done"
