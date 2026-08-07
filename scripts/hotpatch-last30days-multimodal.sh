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

REMOTE_TMP="/tmp/joshu-last30days-subservice-$$"
echo "[last30days-hotpatch] upload subservice bundle…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/hermes-chat' '${REMOTE_TMP}/hermes-plugin'"
rsync -az "${ROOT_DIR}/arozos/subservice/last30days/" "${TARGET}:${REMOTE_TMP}/"
rsync -az "${ROOT_DIR}/dist/hermes-chat/" "${TARGET}:${REMOTE_TMP}/hermes-chat/"
rsync -az "${ROOT_DIR}/.hermes/plugins/joshu-last30days/" "${TARGET}:${REMOTE_TMP}/hermes-plugin/"

echo "[last30days-hotpatch] recreate joshu-stack + install subservice…"
ssh "${TARGET}" bash -s <<EOF
set -euo pipefail
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack

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

docker exec "\${CID}" mkdir -p /var/lib/arozos/subservice/last30days /opt/arozos-template/subservice/last30days
docker exec "\${CID}" rm -rf /var/lib/arozos/subservice/last30days/app /opt/arozos-template/subservice/last30days/app
docker cp "${REMOTE_TMP}/." "\${CID}:/var/lib/arozos/subservice/last30days/"
docker cp "${REMOTE_TMP}/." "\${CID}:/opt/arozos-template/subservice/last30days/"
docker exec "\${CID}" chmod +x /var/lib/arozos/subservice/last30days/start.sh 2>/dev/null || true

docker exec "\${CID}" mkdir -p /root/.hermes/skills/apps/last30days
if [[ -d "${REMOTE_TMP}/skills" ]]; then
  docker cp "${REMOTE_TMP}/skills/." "\${CID}:/root/.hermes/skills/apps/last30days/"
fi

docker exec "\${CID}" mkdir -p /root/.hermes/plugins/joshu-last30days
docker cp "${REMOTE_TMP}/hermes-plugin/." "\${CID}:/root/.hermes/plugins/joshu-last30days/"

docker exec "\${CID}" mkdir -p /var/lib/arozos/subservice/hermes-chat/app /opt/arozos-template/subservice/hermes-chat/app
docker cp "${REMOTE_TMP}/hermes-chat/." "\${CID}:/var/lib/arozos/subservice/hermes-chat/app/"
docker cp "${REMOTE_TMP}/hermes-chat/." "\${CID}:/opt/arozos-template/subservice/hermes-chat/app/"

rm -rf "${REMOTE_TMP}"
echo "[last30days-hotpatch] done — hard-refresh desktop (Cmd+Shift+R)"
echo "Invoke smoke:"
echo "  curl -s -X POST http://127.0.0.1:8788/joshu/api/apps/last30days/invoke -H 'Content-Type: application/json' -d '{\"action\":\"research\",\"args\":{\"topic\":\"test\",\"mock\":true}}' | jq ."
EOF
