#!/usr/bin/env bash
# Hotpatch last30days multimodal stack onto a running Joshu box.
# Lane B3 dist overlay + ArozOS subservice volume (patrick / test boxes).
# Usage: bash scripts/hotpatch-last30days-multimodal.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-root@patrick.box.joshu.me}"

echo "[last30days-hotpatch] building packages + server + UI…"
(cd "${ROOT_DIR}" && npm run build -w @joshu/app-sdk && npm run build -w @joshu/app-agent && npm run build && npm run build:last30days && npm run build:hermes-chat)

mkdir -p "${ROOT_DIR}/arozos/subservice/last30days/app"
rsync -a --delete "${ROOT_DIR}/dist/last30days-app/" "${ROOT_DIR}/arozos/subservice/last30days/app/"

echo "[last30days-hotpatch] rsync dist overlay to ${TARGET}:/opt/joshu/dist/ …"
rsync -avz \
  "${ROOT_DIR}/dist/server.js" \
  "${ROOT_DIR}/dist/hermesChatSessionPush.js" \
  "${ROOT_DIR}/dist/appRegistry.js" \
  "${ROOT_DIR}/dist/appInvokeApi.js" \
  "${ROOT_DIR}/dist/appInvokeRegistry.js" \
  "${ROOT_DIR}/dist/appOwnerDelivery.js" \
  "${ROOT_DIR}/dist/appCronSync.js" \
  "${TARGET}:/opt/joshu/dist/"
rsync -avz "${ROOT_DIR}/dist/last30days/" "${TARGET}:/opt/joshu/dist/last30days/"

echo "[last30days-hotpatch] rsync jChat UI…"
rsync -avz "${ROOT_DIR}/dist/hermes-chat/" "${TARGET}:/opt/joshu/dist/hermes-chat/"

# Host git tree wins loadAppManifests() — keep joshu.app.json in sync or invoke
# stays on the old action list even after the ArozOS volume is patched.
echo "[last30days-hotpatch] rsync host manifest + plugin…"
ssh "${TARGET}" "mkdir -p /opt/joshu/arozos/subservice/last30days/skills /opt/joshu/.hermes/plugins/joshu-last30days"
rsync -az "${ROOT_DIR}/arozos/subservice/last30days/joshu.app.json" \
  "${TARGET}:/opt/joshu/arozos/subservice/last30days/joshu.app.json"
rsync -az "${ROOT_DIR}/arozos/subservice/last30days/skills/" \
  "${TARGET}:/opt/joshu/arozos/subservice/last30days/skills/"
rsync -az "${ROOT_DIR}/.hermes/plugins/joshu-last30days/" \
  "${TARGET}:/opt/joshu/.hermes/plugins/joshu-last30days/"

REMOTE_TMP="/tmp/joshu-last30days-subservice-$$"
echo "[last30days-hotpatch] upload subservice bundle…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/hermes-chat' '${REMOTE_TMP}/hermes-plugin'"
rsync -az "${ROOT_DIR}/arozos/subservice/last30days/" "${TARGET}:${REMOTE_TMP}/"
rsync -az "${ROOT_DIR}/dist/hermes-chat/" "${TARGET}:${REMOTE_TMP}/hermes-chat/"
rsync -az "${ROOT_DIR}/.hermes/plugins/joshu-last30days/" "${TARGET}:${REMOTE_TMP}/hermes-plugin/"

echo "[last30days-hotpatch] restart joshu-stack + install subservice (no force-recreate)…"
ssh "${TARGET}" bash -s <<EOF
set -euo pipefail
cd /opt/joshu/deploy
# Restart the same container so Watching state on overlay FS is not wiped.
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env restart joshu-stack

CID=""
for i in \$(seq 1 60); do
  CID="\$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
  if [[ -n "\${CID}" ]] && docker exec "\${CID}" true 2>/dev/null; then
    break
  fi
  sleep 2
done
if [[ -z "\${CID}" ]]; then
  echo "joshu-stack container not found" >&2
  exit 1
fi

docker exec "\${CID}" mkdir -p /var/lib/arozos/subservice/last30days /opt/arozos-template/subservice/last30days /opt/joshu/arozos/subservice/last30days
docker exec "\${CID}" rm -rf /var/lib/arozos/subservice/last30days/app /opt/arozos-template/subservice/last30days/app
docker cp "${REMOTE_TMP}/." "\${CID}:/var/lib/arozos/subservice/last30days/"
docker cp "${REMOTE_TMP}/." "\${CID}:/opt/arozos-template/subservice/last30days/"
# loadAppManifests() + skill sync read THIS tree first (image layer, not the host clone).
docker cp "${REMOTE_TMP}/joshu.app.json" "\${CID}:/opt/joshu/arozos/subservice/last30days/joshu.app.json"
if [[ -d "${REMOTE_TMP}/skills" ]]; then
  docker exec "\${CID}" mkdir -p /opt/joshu/arozos/subservice/last30days/skills
  docker cp "${REMOTE_TMP}/skills/." "\${CID}:/opt/joshu/arozos/subservice/last30days/skills/"
fi
docker exec "\${CID}" chmod +x /var/lib/arozos/subservice/last30days/start.sh 2>/dev/null || true

docker exec "\${CID}" mkdir -p /root/.hermes/skills/apps/last30days /root/.hermes/skills/joshu/last30days-gui /root/.hermes/skills/joshu/last30days-chat
if [[ -d "${REMOTE_TMP}/skills" ]]; then
  docker cp "${REMOTE_TMP}/skills/." "\${CID}:/root/.hermes/skills/apps/last30days/"
fi
if [[ -d "${REMOTE_TMP}/skills/last30days-gui" ]]; then
  docker cp "${REMOTE_TMP}/skills/last30days-gui/." "\${CID}:/root/.hermes/skills/joshu/last30days-gui/"
fi
if [[ -d "${REMOTE_TMP}/skills/last30days-chat" ]]; then
  docker cp "${REMOTE_TMP}/skills/last30days-chat/." "\${CID}:/root/.hermes/skills/joshu/last30days-chat/"
fi

docker exec "\${CID}" mkdir -p /root/.hermes/plugins/joshu-last30days
docker cp "${REMOTE_TMP}/hermes-plugin/." "\${CID}:/root/.hermes/plugins/joshu-last30days/"

docker exec "\${CID}" mkdir -p /var/lib/arozos/subservice/hermes-chat/app /opt/arozos-template/subservice/hermes-chat/app
docker cp "${REMOTE_TMP}/hermes-chat/." "\${CID}:/var/lib/arozos/subservice/hermes-chat/app/"
docker cp "${REMOTE_TMP}/hermes-chat/." "\${CID}:/opt/arozos-template/subservice/hermes-chat/app/"

rm -rf "${REMOTE_TMP}"

echo "[last30days-hotpatch] waiting for Joshu API…"
for i in \$(seq 1 40); do
  if docker exec "\${CID}" curl -fsS http://127.0.0.1:8788/joshu/api/instance/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "[last30days-hotpatch] restart Hermes gateway so plugin tools reload…"
docker exec "\${CID}" curl -sS -X POST http://127.0.0.1:8788/joshu/api/safety-settings/restart-gateway || true
sleep 8

echo "[last30days-hotpatch] smoke invoke watchingList…"
docker exec "\${CID}" curl -sS -X POST http://127.0.0.1:8788/joshu/api/apps/last30days/invoke \
  -H 'Content-Type: application/json' \
  -d '{"action":"watchingList","args":{}}' || true
echo
docker exec "\${CID}" grep -n 'last30days_watch_add' /root/.hermes/plugins/joshu-last30days/tools.py | head -3
docker exec "\${CID}" grep -E '^version:' /root/.hermes/skills/joshu/last30days-chat/SKILL.md /root/.hermes/skills/joshu/last30days-gui/SKILL.md

echo "[last30days-hotpatch] done — hard-refresh desktop (Cmd+Shift+R); start a new jChat session"
echo "Invoke smoke:"
echo "  curl -s -X POST http://127.0.0.1:8788/joshu/api/apps/last30days/invoke -H 'Content-Type: application/json' -d '{\"action\":\"research\",\"args\":{\"topic\":\"test\",\"mock\":true}}' | jq ."
EOF
