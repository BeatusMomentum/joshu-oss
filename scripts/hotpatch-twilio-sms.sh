#!/usr/bin/env bash
# Hotpatch Twilio SMS gateway onto a running Joshu box (minimal dist sync + stack recreate).
#
# Usage:
#   bash scripts/hotpatch-twilio-sms.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[sms-hotpatch] compiling joshu dist…"
(cd "${ROOT_DIR}" && npx tsc -p tsconfig.json)
for f in twilioSmsGateway server; do
  if [[ ! -f "${ROOT_DIR}/dist/${f}.js" ]]; then
    echo "[sms-hotpatch] missing dist/${f}.js after tsc" >&2
    exit 1
  fi
done

REMOTE_TMP="/tmp/joshu-sms-hotpatch-$$"
echo "[sms-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}'"
rsync -az \
  "${ROOT_DIR}/dist/twilioSmsGateway.js" \
  "${TARGET}:${REMOTE_TMP}/"

echo "[sms-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
install -m 0644 "${REMOTE_TMP}/twilioSmsGateway.js" /opt/joshu/dist/twilioSmsGateway.js

SERVER=/opt/joshu/dist/server.js
if ! grep -q 'twilioSmsGateway' "$SERVER"; then
  sed -i 's|import { createTwilioUpgradeHandler, registerTwilioVoiceRoutes } from "./twilioPhoneGateway.js";|import { createTwilioUpgradeHandler, registerTwilioVoiceRoutes } from "./twilioPhoneGateway.js";\nimport { registerTwilioSmsRoutes } from "./twilioSmsGateway.js";|' "$SERVER"
  sed -i 's|registerTwilioVoiceRoutes(router, runner, PUBLIC_BASE_PATH);|registerTwilioVoiceRoutes(router, runner, PUBLIC_BASE_PATH);\n    registerTwilioSmsRoutes(router, runner, PUBLIC_BASE_PATH);|' "$SERVER"
  echo "[sms-hotpatch] patched server.js routes"
else
  echo "[sms-hotpatch] server.js already registers SMS"
fi
rm -rf "${REMOTE_TMP}"

echo "[sms-hotpatch] recreate joshu-stack…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack
echo "[sms-hotpatch] done — run enable-twilio-box-sms-test.ts if env/webhook not wired yet"
EOF
