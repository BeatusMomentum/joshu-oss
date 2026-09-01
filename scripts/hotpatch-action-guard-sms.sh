#!/usr/bin/env bash
# Hotpatch SMS-only action guard onto a running Joshu box (dist overlay + Safety UI).
#
# Usage:
#   bash scripts/hotpatch-action-guard-sms.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[action-guard-sms-hotpatch] compiling joshu dist…"
(cd "${ROOT_DIR}" && npm run build >/dev/null)
for f in twilioSmsSend twilioSmsGateway appOwnerDelivery hermesMessagingEnv server; do
  if [[ ! -f "${ROOT_DIR}/dist/${f}.js" ]]; then
    echo "[action-guard-sms-hotpatch] missing dist/${f}.js after build" >&2
    exit 1
  fi
done
for f in actionGuard/gate actionGuard/smsIngress ownerChannel/notify safetySettings/store; do
  if [[ ! -f "${ROOT_DIR}/dist/${f}.js" ]]; then
    echo "[action-guard-sms-hotpatch] missing dist/${f}.js after build" >&2
    exit 1
  fi
done

echo "[action-guard-sms-hotpatch] building Safety Settings UI…"
(cd "${ROOT_DIR}" && npm run build:safety-settings >/dev/null)
mkdir -p "${ROOT_DIR}/arozos/subservice/safety-settings/app"
rsync -a --delete "${ROOT_DIR}/dist/safety-settings/" "${ROOT_DIR}/arozos/subservice/safety-settings/app/"

REMOTE_TMP="/tmp/joshu-action-guard-sms-hotpatch-$$"
echo "[action-guard-sms-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/dist/actionGuard' '${REMOTE_TMP}/dist/ownerChannel' '${REMOTE_TMP}/dist/safetySettings' '${REMOTE_TMP}/safety-settings'"
rsync -az \
  "${ROOT_DIR}/dist/twilioSmsSend.js" \
  "${ROOT_DIR}/dist/twilioSmsGateway.js" \
  "${ROOT_DIR}/dist/appOwnerDelivery.js" \
  "${ROOT_DIR}/dist/hermesMessagingEnv.js" \
  "${TARGET}:${REMOTE_TMP}/dist/"
rsync -az "${ROOT_DIR}/dist/actionGuard/" "${TARGET}:${REMOTE_TMP}/dist/actionGuard/"
rsync -az "${ROOT_DIR}/dist/ownerChannel/" "${TARGET}:${REMOTE_TMP}/dist/ownerChannel/"
rsync -az "${ROOT_DIR}/dist/safetySettings/" "${TARGET}:${REMOTE_TMP}/dist/safetySettings/"
rsync -az --delete \
  "${ROOT_DIR}/arozos/subservice/safety-settings/" \
  "${TARGET}:${REMOTE_TMP}/safety-settings/"

echo "[action-guard-sms-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
DIST=/opt/joshu/dist

install -m 0644 "${REMOTE_TMP}/dist/twilioSmsSend.js" "${DIST}/twilioSmsSend.js"
install -m 0644 "${REMOTE_TMP}/dist/twilioSmsGateway.js" "${DIST}/twilioSmsGateway.js"
install -m 0644 "${REMOTE_TMP}/dist/appOwnerDelivery.js" "${DIST}/appOwnerDelivery.js"
install -m 0644 "${REMOTE_TMP}/dist/hermesMessagingEnv.js" "${DIST}/hermesMessagingEnv.js"

rsync -a "${REMOTE_TMP}/dist/actionGuard/" "${DIST}/actionGuard/"
rsync -a "${REMOTE_TMP}/dist/ownerChannel/" "${DIST}/ownerChannel/"
rsync -a "${REMOTE_TMP}/dist/safetySettings/" "${DIST}/safetySettings/"

# Remove legacy Telegram/Slack approval modules (no longer imported).
rm -f \
  "${DIST}/actionGuard/polling.js" \
  "${DIST}/ownerChannel/slackReplyPoll.js" \
  "${DIST}/ownerChannel/ingress/telegram.js" \
  "${DIST}/ownerChannel/ingress/slack.js" \
  "${DIST}/ownerChannel/ingress/slackDecide.js" 2>/dev/null || true
rmdir "${DIST}/ownerChannel/ingress" 2>/dev/null || true

rm -rf "${REMOTE_TMP}/dist"

echo "[action-guard-sms-hotpatch] recreate joshu-stack…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack

CID=""
for i in $(seq 1 60); do
  CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
  if [[ -n "${CID}" ]] && docker exec "${CID}" true 2>/dev/null; then
    break
  fi
  sleep 2
done
[[ -n "${CID}" ]] || { echo "joshu-stack container not found after recreate" >&2; exit 1; }

echo "[action-guard-sms-hotpatch] installing Safety Settings subservice…"
docker exec "${CID}" mkdir -p /var/lib/arozos/subservice/safety-settings /opt/arozos-template/subservice/safety-settings
docker exec "${CID}" rm -rf /var/lib/arozos/subservice/safety-settings/app /opt/arozos-template/subservice/safety-settings/app
docker cp "${REMOTE_TMP}/safety-settings/." "${CID}:/var/lib/arozos/subservice/safety-settings/"
docker cp "${REMOTE_TMP}/safety-settings/." "${CID}:/opt/arozos-template/subservice/safety-settings/"
docker exec "${CID}" chmod +x /var/lib/arozos/subservice/safety-settings/start.sh
docker exec "${CID}" chmod +x /opt/arozos-template/subservice/safety-settings/start.sh

rm -rf "${REMOTE_TMP}"

echo "[action-guard-sms-hotpatch] waiting for Joshu API…"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8788/joshu/api/action-guard/status >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

echo "[action-guard-sms-hotpatch] smoke: action-guard status…"
curl -fsS http://127.0.0.1:8788/joshu/api/action-guard/status | python3 -m json.tool | head -30
echo "[action-guard-sms-hotpatch] done — hard-refresh Safety app; test approval via SMS Y/N"
EOF
