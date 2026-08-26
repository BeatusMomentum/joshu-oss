#!/usr/bin/env bash
# Hotpatch Patrick (or any box): SMS platform isolation + Kanban worker prompt gate.
#
# - Joshu: twilioSmsGateway.js + hermesApi.js (platform_toolsets.sms header)
# - Hermes: kanban guidance gate + X-Hermes-Platform-Toolsets on api_server
# - Recreates joshu-stack (ensureJoshuHermesConfig writes platform_toolsets.sms)
#
# Usage:
#   bash scripts/hotpatch-sms-platform-isolation.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[sms-platform-hotpatch] compiling joshu dist…"
(cd "${ROOT_DIR}" && npx tsc -p tsconfig.json)
for f in twilioSmsGateway hermesApi; do
  if [[ ! -f "${ROOT_DIR}/dist/${f}.js" ]]; then
    echo "[sms-platform-hotpatch] missing dist/${f}.js after tsc" >&2
    exit 1
  fi
done

REMOTE_TMP="/tmp/joshu-sms-platform-hotpatch-$$"
echo "[sms-platform-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/meteredProviders'"
rsync -az \
  "${ROOT_DIR}/dist/twilioSmsGateway.js" \
  "${ROOT_DIR}/dist/hermesApi.js" \
  "${ROOT_DIR}/scripts/patch-hermes-kanban-guidance-gate.py" \
  "${ROOT_DIR}/scripts/patch-hermes-api-server-platform-toolsets.py" \
  "${TARGET}:${REMOTE_TMP}/"
rsync -az "${ROOT_DIR}/dist/meteredProviders/" "${TARGET}:${REMOTE_TMP}/meteredProviders/"

echo "[sms-platform-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
install -m 0644 "${REMOTE_TMP}/twilioSmsGateway.js" /opt/joshu/dist/twilioSmsGateway.js
install -m 0644 "${REMOTE_TMP}/hermesApi.js" /opt/joshu/dist/hermesApi.js
mkdir -p /opt/joshu/dist/meteredProviders
install -m 0644 "${REMOTE_TMP}/meteredProviders/config.js" /opt/joshu/dist/meteredProviders/config.js

cd /opt/joshu/deploy
ENV_FILE=/etc/joshu/instance.env

echo "[sms-platform-hotpatch] restart joshu-stack (reload dist; avoid --force-recreate — wipes Hermes patches)…"
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" restart joshu-stack
sleep 20

CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
[[ -n "${CID}" ]] || { echo "[sms-platform-hotpatch] no joshu-stack container"; exit 1; }

echo "[sms-platform-hotpatch] apply Hermes patches inside running container…"
docker cp "${REMOTE_TMP}/patch-hermes-kanban-guidance-gate.py" "${CID}:/tmp/patch-hermes-kanban-guidance-gate.py"
docker cp "${REMOTE_TMP}/patch-hermes-api-server-platform-toolsets.py" "${CID}:/tmp/patch-hermes-api-server-platform-toolsets.py"
docker exec "${CID}" env HERMES_DIR=/opt/hermes-agent python3 /tmp/patch-hermes-kanban-guidance-gate.py
docker exec "${CID}" env HERMES_DIR=/opt/hermes-agent python3 /tmp/patch-hermes-api-server-platform-toolsets.py

echo "[sms-platform-hotpatch] restart Hermes gateway (reload patched Python)…"
docker exec "${CID}" bash -lc '
  HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
  # shellcheck source=/dev/null
  source /opt/joshu/scripts/lib/hermes-gateway.sh
  pid="$(read_hermes_gateway_pid)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    echo "[sms-platform-hotpatch] stopped Hermes gateway pid=${pid}"
  fi
  rm -f "${HERMES_HOME}/gateway.pid" "${HERMES_HOME}/gateway.lock" 2>/dev/null || true
  sleep 2
'

echo "[sms-platform-hotpatch] verify Hermes patches…"
docker exec "${CID}" grep -rn "joshu-kanban-guidance-worker-env-gate-v1" /opt/hermes-agent/run_agent.py /opt/hermes-agent/agent/agent_init.py /opt/hermes-agent/agent/system_prompt.py 2>/dev/null | head -3
docker exec "${CID}" grep -n "joshu-api-server-platform-toolsets-v1" /opt/hermes-agent/gateway/platforms/api_server.py | head -1

rm -rf "${REMOTE_TMP}"

echo "[sms-platform-hotpatch] done — send test SMS and check Langfuse (session sms:+…)"
EOF
