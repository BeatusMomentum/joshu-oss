#!/usr/bin/env bash
# Hotpatch Telephone app onto a running Joshu box (UI + API + voice passphrase resolver).
# Does NOT replace host dist/server.js wholesale (that breaks older release dist trees).
#
# Usage:
#   bash scripts/hotpatch-telephone.sh root@box.example.com
#   bash scripts/hotpatch-telephone.sh root@your-box.example.com +15551234567
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
PHONE_E164="${2:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host [E.164 phone number]" >&2
  exit 1
fi

echo "[telephone-hotpatch] building UI + API + voice-realtime…"
(cd "${ROOT_DIR}" && npm run build:telephone)
(cd "${ROOT_DIR}" && npx tsc -p tsconfig.json) || true
if [[ ! -f "${ROOT_DIR}/dist/telephoneSettings/routes.js" ]]; then
  echo "[telephone-hotpatch] missing dist/telephoneSettings/routes.js after tsc" >&2
  exit 1
fi
(cd "${ROOT_DIR}/packages/voice-realtime" && npm run build)
mkdir -p "${ROOT_DIR}/arozos/subservice/telephone/app"
rsync -a --delete "${ROOT_DIR}/dist/telephone/" "${ROOT_DIR}/arozos/subservice/telephone/app/"
chmod +x "${ROOT_DIR}/arozos/subservice/telephone/start.sh"

REMOTE_TMP="/tmp/joshu-telephone-hotpatch-$$"
echo "[telephone-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}'"
rsync -az --delete \
  "${ROOT_DIR}/arozos/subservice/telephone/" \
  "${TARGET}:${REMOTE_TMP}/telephone/"
rsync -az "${ROOT_DIR}/arozos/icons/telephone.png" "${TARGET}:${REMOTE_TMP}/telephone.png"
rsync -az "${ROOT_DIR}/scripts/lib/arozos-desktop-shortcuts.sh" "${TARGET}:${REMOTE_TMP}/arozos-desktop-shortcuts.sh"
rsync -az \
  "${ROOT_DIR}/dist/telephoneSettings/" \
  "${TARGET}:${REMOTE_TMP}/telephoneSettings/"
rsync -az \
  "${ROOT_DIR}/packages/voice-realtime/dist/" \
  "${TARGET}:${REMOTE_TMP}/voice-dist/"

echo "[telephone-hotpatch] installing on box…"
ssh "${TARGET}" \
  "TELEPHONE_HOTPATCH_E164='${PHONE_E164}' REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
CID="$(cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
if [[ -z "${CID}" ]]; then
  echo "joshu-stack container not found" >&2
  exit 1
fi

if [[ -n "${TELEPHONE_HOTPATCH_E164:-}" ]] && ! grep -q '^TWILIO_PHONE_NUMBER=' "${ENV_FILE}" 2>/dev/null; then
  printf '\nTWILIO_PHONE_NUMBER=%s\n' "${TELEPHONE_HOTPATCH_E164}" >> "${ENV_FILE}"
  echo "[telephone-hotpatch] appended TWILIO_PHONE_NUMBER=${TELEPHONE_HOTPATCH_E164}"
fi

# Subservice + icon
docker exec "${CID}" mkdir -p /var/lib/arozos/subservice/telephone /opt/arozos-template/subservice/telephone
docker cp "${REMOTE_TMP}/telephone/." "${CID}:/var/lib/arozos/subservice/telephone/"
docker cp "${REMOTE_TMP}/telephone/." "${CID}:/opt/arozos-template/subservice/telephone/"
docker exec "${CID}" chmod +x /var/lib/arozos/subservice/telephone/start.sh /opt/arozos-template/subservice/telephone/start.sh
docker exec "${CID}" mkdir -p /var/lib/arozos/web/img/joshu /opt/arozos-template/web/img/joshu
docker cp "${REMOTE_TMP}/telephone.png" "${CID}:/var/lib/arozos/web/img/joshu/telephone.png"
docker cp "${REMOTE_TMP}/telephone.png" "${CID}:/opt/arozos-template/web/img/joshu/telephone.png"

# API modules only (do not replace whole dist/)
mkdir -p /opt/joshu/dist/telephoneSettings
rsync -a --delete "${REMOTE_TMP}/telephoneSettings/" /opt/joshu/dist/telephoneSettings/

SERVER=/opt/joshu/dist/server.js
if ! grep -q 'telephoneSettings/routes' "$SERVER"; then
  sed -i 's|import { registerSafetySettingsRoutes } from "./safetySettings/routes.js";|import { registerSafetySettingsRoutes } from "./safetySettings/routes.js";\nimport { registerTelephoneRoutes } from "./telephoneSettings/routes.js";|' "$SERVER"
  sed -i 's|registerSafetySettingsRoutes(router, { projectRoot: PROJECT_ROOT, hermesBinary: HERMES_BIN, runner });|registerSafetySettingsRoutes(router, { projectRoot: PROJECT_ROOT, hermesBinary: HERMES_BIN, runner });\n    registerTelephoneRoutes(router, { projectRoot: PROJECT_ROOT });|' "$SERVER"
  echo "[telephone-hotpatch] patched server.js routes"
else
  echo "[telephone-hotpatch] server.js already registers Telephone"
fi

# Shortcut
docker cp "${REMOTE_TMP}/arozos-desktop-shortcuts.sh" "${CID}:/tmp/arozos-desktop-shortcuts.sh"
docker exec -e AROZ_DATA=/var/lib/arozos "${CID}" bash -lc '
  source /tmp/arozos-desktop-shortcuts.sh
  install_telephone_shortcuts
'

echo "[telephone-hotpatch] recreate joshu-stack…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack

VCID="$(cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q voice-realtime | head -1)"
if [[ -n "${VCID}" ]]; then
  docker cp "${REMOTE_TMP}/voice-dist/." "${VCID}:/app/dist/"
  docker restart "${VCID}"
  echo "[telephone-hotpatch] patched + restarted voice-realtime"
fi

rm -rf "${REMOTE_TMP}"
echo "[telephone-hotpatch] done — hard-refresh the desktop and open Telephone"
EOF
