#!/usr/bin/env bash
# Hotpatch Realtime Goal Broker onto a running Joshu box.
# Surgical dist overlay (no rsync --delete). Does not git pull.
#
# Usage:
#   bash scripts/hotpatch-realtime-goals.sh patrick
#   bash scripts/hotpatch-realtime-goals.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARG="${1:?usage: hotpatch-realtime-goals.sh <slug|user@host>}"
if [[ "${ARG}" == *@* ]]; then
  TARGET="${ARG}"
  SLUG="$(echo "${ARG}" | sed -E 's/^[^@]+@([^.]+)\..*/\1/')"
else
  SLUG="${ARG}"
  TARGET="root@${SLUG}.box.joshu.me"
fi

echo "[realtime-goals-hotpatch] building dist + jChat + voice-realtime…"
(cd "${ROOT}" && npx tsc -p tsconfig.json)
(cd "${ROOT}" && npm run build:hermes-chat)
(cd "${ROOT}/packages/voice-realtime" && npm run build)

for f in \
  dist/server.js \
  dist/hermesKanbanBridge.js \
  dist/hermesApi.js \
  dist/twilioSmsGateway.js \
  dist/twilioSmsConfig.js \
  dist/twilioPhoneGateway.js \
  dist/agUiApi.js \
  dist/httpLocalhost.js \
  dist/voiceWebApi.js \
  dist/realtimeGoals/broker.js; do
  if [[ ! -f "${ROOT}/${f}" ]]; then
    echo "[realtime-goals-hotpatch] missing ${f} after build" >&2
    exit 1
  fi
done

echo "[realtime-goals-hotpatch] uploading to ${TARGET}…"
ssh -n -o BatchMode=yes -o ConnectTimeout=15 "${TARGET}" 'true'

rsync -az "${ROOT}/dist/realtimeGoals/" "${TARGET}:/opt/joshu/dist/realtimeGoals/"
rsync -az \
  "${ROOT}/dist/server.js" \
  "${ROOT}/dist/hermesKanbanBridge.js" \
  "${ROOT}/dist/hermesApi.js" \
  "${ROOT}/dist/twilioSmsGateway.js" \
  "${ROOT}/dist/twilioSmsConfig.js" \
  "${ROOT}/dist/twilioPhoneGateway.js" \
  "${ROOT}/dist/agUiApi.js" \
  "${ROOT}/dist/httpLocalhost.js" \
  "${ROOT}/dist/voiceWebApi.js" \
  "${TARGET}:/opt/joshu/dist/"
rsync -az \
  "${ROOT}/scripts/hermes-kanban-bridge.py" \
  "${ROOT}/scripts/patch-hermes-ea-kanban-no-autodecompose.py" \
  "${ROOT}/scripts/apply-hermes-ea-kanban-no-autodecompose.sh" \
  "${TARGET}:/opt/joshu/scripts/"
rsync -az "${ROOT}/.hermes/plugins/joshu-realtime-goals/" \
  "${TARGET}:/opt/joshu/.hermes/plugins/joshu-realtime-goals/"
rsync -az "${ROOT}/integrations/hermes/skills-enabled.yaml" \
  "${TARGET}:/opt/joshu/integrations/hermes/skills-enabled.yaml"
rsync -az "${ROOT}/integrations/hermes/skills/realtime/" \
  "${TARGET}:/opt/joshu/integrations/hermes/skills/realtime/"
rsync -az "${ROOT}/factory/manifest.yaml" \
  "${TARGET}:/opt/joshu/factory/manifest.yaml"
rsync -az "${ROOT}/dist/hermes-chat/" "${TARGET}:/tmp/hermes-chat-realtime-goals/"
rsync -az "${ROOT}/packages/voice-realtime/dist/" "${TARGET}:/tmp/vr-dist-realtime-goals/"

echo "[realtime-goals-hotpatch] applying on box…"
ssh -o BatchMode=yes "${TARGET}" bash -s <<'REMOTE'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env

echo "[realtime-goals-hotpatch] recreate joshu-stack…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack

CID=""
for i in $(seq 1 45); do
  CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
  if [[ -n "${CID}" ]] && docker exec "${CID}" true 2>/dev/null; then
    break
  fi
  sleep 2
done
[[ -n "${CID}" ]] || { echo "joshu-stack container not found"; exit 1; }

# Project plugin (not compose bind-mounted yet) — Hermes reads $HERMES_HOME/plugins
docker exec "${CID}" mkdir -p /opt/joshu/.hermes/plugins/joshu-realtime-goals /root/.hermes/plugins
docker cp /opt/joshu/.hermes/plugins/joshu-realtime-goals/. \
  "${CID}:/opt/joshu/.hermes/plugins/joshu-realtime-goals/"
docker exec "${CID}" rm -rf /root/.hermes/plugins/joshu-realtime-goals
docker cp /opt/joshu/.hermes/plugins/joshu-realtime-goals/. \
  "${CID}:/root/.hermes/plugins/joshu-realtime-goals/"

# Runtime skill for deferred workers
docker exec "${CID}" mkdir -p /root/.hermes/skills/joshu/realtime/realtime-goal
docker cp /opt/joshu/integrations/hermes/skills/realtime/realtime-goal/SKILL.md \
  "${CID}:/root/.hermes/skills/joshu/realtime/realtime-goal/SKILL.md"

# jChat UI (surface-event polling)
docker exec "${CID}" mkdir -p /var/lib/arozos/subservice/hermes-chat/app /opt/arozos-template/subservice/hermes-chat/app
if [[ -d /tmp/hermes-chat-realtime-goals ]]; then
  docker cp /tmp/hermes-chat-realtime-goals/. "${CID}:/var/lib/arozos/subservice/hermes-chat/app/"
  docker cp /tmp/hermes-chat-realtime-goals/. "${CID}:/opt/arozos-template/subservice/hermes-chat/app/"
fi

# Scripts live in the image, not host bind-mount — overlay into the running container.
docker cp /opt/joshu/scripts/hermes-kanban-bridge.py "${CID}:/opt/joshu/scripts/hermes-kanban-bridge.py"
docker cp /opt/joshu/scripts/patch-hermes-ea-kanban-no-autodecompose.py \
  "${CID}:/opt/joshu/scripts/patch-hermes-ea-kanban-no-autodecompose.py"
docker cp /opt/joshu/scripts/apply-hermes-ea-kanban-no-autodecompose.sh \
  "${CID}:/opt/joshu/scripts/apply-hermes-ea-kanban-no-autodecompose.sh"

# Keep realtime-goals board out of Hermes auto_decompose
docker exec "${CID}" bash -lc 'HERMES_DIR=/opt/hermes-agent bash /opt/joshu/scripts/apply-hermes-ea-kanban-no-autodecompose.sh' || true

# Enable plugin + sync Hermes config (hermesApi adds toolset on nudge)
if docker exec "${CID}" test -x /opt/hermes-agent/venv/bin/hermes; then
  docker exec "${CID}" /opt/hermes-agent/venv/bin/hermes plugins enable joshu-realtime-goals 2>/dev/null || true
fi

# Voice-realtime broker admission + PSTN callback delivery
VCID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q voice-realtime | head -1 || true)"
if [[ -n "${VCID}" ]] && [[ -d /tmp/vr-dist-realtime-goals ]]; then
  docker cp /tmp/vr-dist-realtime-goals/. "${VCID}:/app/dist/"
  docker restart "${VCID}" >/dev/null
  echo "[realtime-goals-hotpatch] voice-realtime overlaid"
else
  echo "[realtime-goals-hotpatch] voice-realtime skip (no container or dist)"
fi
rm -rf /tmp/hermes-chat-realtime-goals /tmp/vr-dist-realtime-goals

# Restart gateway so plugin + skills reload
pid=$(docker exec "${CID}" python3 -c "import json,pathlib; p=pathlib.Path('/root/.hermes/gateway.pid');
print(json.loads(p.read_text()).get('pid','') if p.is_file() else '')" 2>/dev/null || true)
if [[ -n "${pid}" ]]; then
  docker exec "${CID}" kill "${pid}" 2>/dev/null || true
fi
sleep 2

ok=0
for i in $(seq 1 60); do
  code=$(curl -sS -o /tmp/rg-health.json -w "%{http_code}" http://127.0.0.1:8788/joshu/api/instance/health 2>/dev/null || echo 000)
  if [[ "${code}" == "200" ]]; then
    ok=1
    break
  fi
  sleep 5
done
[[ "${ok}" == 1 ]] || { echo "Joshu health never came up"; exit 1; }

curl -fsS --max-time 120 "http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1" >/dev/null || true

python3 - <<'PY'
import json
health = json.load(open("/tmp/rg-health.json"))
print("health", health.get("healthy"), "release", health.get("releaseVersion"))
PY

docker exec "${CID}" test -f /opt/joshu/dist/realtimeGoals/broker.js && echo "broker-dist-ok"
docker exec "${CID}" test -f /opt/joshu/.hermes/plugins/joshu-realtime-goals/tools.py && echo "plugin-ok"
docker exec "${CID}" test -f /root/.hermes/skills/joshu/realtime/realtime-goal/SKILL.md && echo "skill-ok"
docker exec "${CID}" grep -q 'realtime-goals' /opt/joshu/scripts/hermes-kanban-bridge.py && echo "kanban-bridge-ok"

if curl -fsS http://127.0.0.1:8792/health >/tmp/vr-health.json 2>/dev/null; then
  python3 - <<'PY'
import json
print("voice-realtime", json.load(open("/tmp/vr-health.json")))
PY
fi

echo "REALTIME_GOALS_HOTPATCH_OK"
REMOTE

echo "[realtime-goals-hotpatch] done — hard-refresh jChat desktop; SMS/voice ready on next owner message"
