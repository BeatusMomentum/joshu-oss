#!/usr/bin/env bash
# Hotpatch owner SMS fixes onto a running box:
#   1. hermes-chat-sessions-bridge.py — last_assistant for canonical post-tool replies
#   2. twilioSmsOwnerMutex + twilioSmsGateway — one Hermes turn per owner at a time
#
# Usage:
#   bash scripts/hotpatch-sms-canonical-reply-mutex.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[sms-canonical-mutex] compiling joshu dist…"
(cd "${ROOT_DIR}" && npx tsc -p tsconfig.json)
for f in twilioSmsGateway twilioSmsOwnerMutex smsHermesReply hermesChatSessionsBridge; do
  if [[ ! -f "${ROOT_DIR}/dist/${f}.js" ]]; then
    echo "[sms-canonical-mutex] missing dist/${f}.js after tsc" >&2
    exit 1
  fi
done
if [[ ! -f "${ROOT_DIR}/scripts/hermes-chat-sessions-bridge.py" ]]; then
  echo "[sms-canonical-mutex] missing scripts/hermes-chat-sessions-bridge.py" >&2
  exit 1
fi

REMOTE_TMP="/tmp/joshu-sms-canonical-mutex-$$"
echo "[sms-canonical-mutex] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}'"
rsync -az \
  "${ROOT_DIR}/dist/twilioSmsGateway.js" \
  "${ROOT_DIR}/dist/twilioSmsOwnerMutex.js" \
  "${ROOT_DIR}/dist/smsHermesReply.js" \
  "${ROOT_DIR}/dist/hermesChatSessionsBridge.js" \
  "${ROOT_DIR}/scripts/hermes-chat-sessions-bridge.py" \
  "${TARGET}:${REMOTE_TMP}/"

echo "[sms-canonical-mutex] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
install -m 0644 "${REMOTE_TMP}/twilioSmsGateway.js" /opt/joshu/dist/twilioSmsGateway.js
install -m 0644 "${REMOTE_TMP}/twilioSmsOwnerMutex.js" /opt/joshu/dist/twilioSmsOwnerMutex.js
install -m 0644 "${REMOTE_TMP}/smsHermesReply.js" /opt/joshu/dist/smsHermesReply.js
install -m 0644 "${REMOTE_TMP}/hermesChatSessionsBridge.js" /opt/joshu/dist/hermesChatSessionsBridge.js
# Host clone (git pull path) — image CMD does not bind-mount scripts/ into the container.
install -m 0755 "${REMOTE_TMP}/hermes-chat-sessions-bridge.py" /opt/joshu/scripts/hermes-chat-sessions-bridge.py

echo "[sms-canonical-mutex] restart joshu-stack (reload dist; avoid --force-recreate)…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" restart joshu-stack

CID=""
for _i in $(seq 1 36); do
  CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
  [[ -n "${CID}" ]] || { sleep 5; continue; }
  break
done
[[ -n "${CID}" ]] || { echo "[sms-canonical-mutex] no joshu-stack container"; exit 1; }

echo "[sms-canonical-mutex] overlay bridge into container (image-baked scripts/ is not host-mounted)…"
docker cp "${REMOTE_TMP}/hermes-chat-sessions-bridge.py" "${CID}:/opt/joshu/scripts/hermes-chat-sessions-bridge.py"

rm -rf "${REMOTE_TMP}"

echo "[sms-canonical-mutex] verify bridge last_assistant inside container…"
BRIDGE_OUT="$(docker exec "${CID}" bash -lc 'echo "{\"action\":\"last_assistant\",\"sessionId\":\"sms:smoke\"}" | python3 /opt/joshu/scripts/hermes-chat-sessions-bridge.py')"
echo "${BRIDGE_OUT}" | head -c 200
echo
if echo "${BRIDGE_OUT}" | grep -q 'unknown action'; then
  echo "[sms-canonical-mutex] bridge still missing last_assistant" >&2
  exit 1
fi

echo "[sms-canonical-mutex] done"
EOF
