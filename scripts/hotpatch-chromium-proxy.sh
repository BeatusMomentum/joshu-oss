#!/usr/bin/env bash
# Hotpatch Chromium supervisor local auth-inject proxy onto a running box.
#
# Fixes CDP navigations failing with net::ERR_INVALID_AUTH_CREDENTIALS when
# Decodo proxy credentials are set (Hermes/Joshu attach via raw CDP, not Playwright).
#
# Usage:
#   bash scripts/hotpatch-chromium-proxy.sh root@patrick.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-root@patrick.box.joshu.me}"

for f in supervisor.mjs localProxy.mjs entrypoint.sh package.json; do
  if [[ ! -f "${ROOT_DIR}/browser/chromium/${f}" ]]; then
    echo "[chromium-proxy-hotpatch] missing browser/chromium/${f}" >&2
    exit 1
  fi
done

REMOTE_TMP="/tmp/joshu-chromium-proxy-hotpatch-$$"
echo "[chromium-proxy-hotpatch] uploading to ${TARGET}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/browser'"
rsync -az \
  "${ROOT_DIR}/browser/chromium/supervisor.mjs" \
  "${ROOT_DIR}/browser/chromium/localProxy.mjs" \
  "${ROOT_DIR}/browser/chromium/entrypoint.sh" \
  "${ROOT_DIR}/browser/chromium/package.json" \
  "${TARGET}:${REMOTE_TMP}/browser/"
if [[ -f "${ROOT_DIR}/browser/chromium/package-lock.json" ]]; then
  rsync -az "${ROOT_DIR}/browser/chromium/package-lock.json" "${TARGET}:${REMOTE_TMP}/browser/"
fi

echo "[chromium-proxy-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
HOST=/opt/joshu
BUNDLE="${HOST}/hotfix/browser"

mkdir -p "${BUNDLE}"
install -m 0644 "${REMOTE_TMP}/browser/supervisor.mjs" "${BUNDLE}/supervisor.mjs"
install -m 0644 "${REMOTE_TMP}/browser/localProxy.mjs" "${BUNDLE}/localProxy.mjs"
install -m 0755 "${REMOTE_TMP}/browser/entrypoint.sh" "${BUNDLE}/entrypoint.sh"
install -m 0644 "${REMOTE_TMP}/browser/package.json" "${BUNDLE}/package.json"
if [[ -f "${REMOTE_TMP}/browser/package-lock.json" ]]; then
  install -m 0644 "${REMOTE_TMP}/browser/package-lock.json" "${BUNDLE}/package-lock.json"
fi

cd /opt/joshu/deploy
CID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q joshu-stack | head -1)"
[[ -n "${CID}" ]] || { echo "joshu-stack container not found" >&2; exit 1; }

echo "[chromium-proxy-hotpatch] copy into container /opt/browser…"
docker exec "${CID}" mkdir -p /opt/browser
docker cp "${BUNDLE}/supervisor.mjs" "${CID}:/opt/browser/supervisor.mjs"
docker cp "${BUNDLE}/localProxy.mjs" "${CID}:/opt/browser/localProxy.mjs"
docker cp "${BUNDLE}/entrypoint.sh" "${CID}:/opt/browser/entrypoint.sh"
docker cp "${BUNDLE}/package.json" "${CID}:/opt/browser/package.json"
if [[ -f "${BUNDLE}/package-lock.json" ]]; then
  docker cp "${BUNDLE}/package-lock.json" "${CID}:/opt/browser/package-lock.json"
fi
docker exec "${CID}" chmod +x /opt/browser/entrypoint.sh
docker exec "${CID}" bash -c 'cd /opt/browser && npm install --omit=dev --no-audit --no-fund' || true

echo "[chromium-proxy-hotpatch] stop manual proxy workaround + old supervisor…"
docker exec "${CID}" sh -c '
  for p in $(pgrep -x python3 2>/dev/null || true); do
    cmd=$(tr "\0" " " < "/proc/${p}/cmdline" 2>/dev/null || echo "")
    case "$cmd" in *decodo_inject.py*) kill -9 "$p" 2>/dev/null || true ;; esac
  done
  for p in $(pgrep -x node 2>/dev/null || true); do
    cmd=$(tr "\0" " " < "/proc/${p}/cmdline" 2>/dev/null || echo "")
    case "$cmd" in *"/opt/browser/supervisor.mjs"*) kill -9 "$p" 2>/dev/null || true ;; esac
  done
  for p in $(pgrep -x bash 2>/dev/null || true); do
    cmd=$(tr "\0" " " < "/proc/${p}/cmdline" 2>/dev/null || echo "")
    case "$cmd" in *"/opt/browser/entrypoint.sh"*) kill -9 "$p" 2>/dev/null || true ;; esac
  done
  pkill -9 -x chromium 2>/dev/null || true
  # Leave one websockify; hotpatch used to spawn extras when VNC was already up.
  WS_KEEP=""
  for p in $(pgrep -f "websockify.*6080" 2>/dev/null || true); do
    if [ -z "${WS_KEEP}" ]; then
      WS_KEEP="${p}"
    else
      kill -9 "${p}" 2>/dev/null || true
    fi
  done
  sleep 2
'

echo "[chromium-proxy-hotpatch] restart Chromium supervisor…"
docker exec -d "${CID}" bash -c 'DISPLAY=:99 exec /opt/browser/entrypoint.sh'

echo "[chromium-proxy-hotpatch] waiting for browser health…"
for i in $(seq 1 45); do
  if docker exec "${CID}" curl -fsS http://127.0.0.1:9377/health 2>/dev/null | grep -q '"ok":true'; then
    break
  fi
  sleep 2
done

echo "[chromium-proxy-hotpatch] health:"
docker exec "${CID}" curl -fsS http://127.0.0.1:9377/health | python3 -m json.tool

echo "[chromium-proxy-hotpatch] verify local auth proxy in supervisor…"
docker exec "${CID}" grep -q 'createAuthInjectProxy' /opt/browser/supervisor.mjs
docker exec "${CID}" grep -q 'localProxyPort' /opt/browser/supervisor.mjs

HEALTH="$(docker exec "${CID}" curl -fsS http://127.0.0.1:9377/health)"
echo "${HEALTH}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("localProxyPort"), "localProxyPort missing — PROXY_USERNAME may be unset"; print("localProxyPort", d["localProxyPort"])'

echo "[chromium-proxy-hotpatch] CDP smoke via local proxy…"
docker exec "${CID}" curl -fsS http://127.0.0.1:9222/json/version | python3 -c 'import json,sys; d=json.load(sys.stdin); print("browser", d.get("Browser", d.get("browser")))'

rm -rf "${REMOTE_TMP}"
echo "[chromium-proxy-hotpatch] done"
EOF
