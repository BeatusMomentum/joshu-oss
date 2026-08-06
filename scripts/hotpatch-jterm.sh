#!/usr/bin/env bash
# Hotpatch jTerm onto a running Joshu box.
# Usage:
#   bash scripts/hotpatch-jterm.sh root@box.example.com
#   bash scripts/hotpatch-jterm.sh root@203.0.113.10
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[jterm-hotpatch] building UI…"
(cd "${ROOT_DIR}" && npm run build:jterm)
mkdir -p "${ROOT_DIR}/arozos/subservice/jterm/app"
rsync -a --delete "${ROOT_DIR}/dist/jterm/" "${ROOT_DIR}/arozos/subservice/jterm/app/"
chmod +x "${ROOT_DIR}/arozos/subservice/jterm/start.sh" "${ROOT_DIR}/arozos/subservice/jterm/server.py"

REMOTE_TMP="/tmp/joshu-jterm-hotpatch-$$"
echo "[jterm-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}'"
rsync -az --delete \
  "${ROOT_DIR}/arozos/subservice/jterm/" \
  "${TARGET}:${REMOTE_TMP}/jterm/"
# Icon (theme apply copies arozos/icons → web/img/joshu on boot; also drop in place)
rsync -az "${ROOT_DIR}/arozos/icons/terminal.png" "${TARGET}:${REMOTE_TMP}/terminal.png"
# Shortcut helper + lib (for install_jterm_shortcuts)
rsync -az "${ROOT_DIR}/scripts/lib/arozos-desktop-shortcuts.sh" "${TARGET}:${REMOTE_TMP}/arozos-desktop-shortcuts.sh"

echo "[jterm-hotpatch] recreate joshu-stack, then install (post-boot)…"
ssh "${TARGET}" bash -s <<EOF
set -euo pipefail
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack

# Install AFTER recreate. Pre-recreate installs are racy: boot may seed jTerm
# from the image template and leave stale Vite hashed assets + old index.html.
echo "[jterm-hotpatch] waiting for joshu-stack…"
CID=""
for i in \$(seq 1 60); do
  CID="\$(cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
  if [[ -n "\${CID}" ]] && docker exec "\${CID}" true 2>/dev/null; then
    break
  fi
  sleep 2
done
if [[ -z "\${CID}" ]]; then
  echo "joshu-stack container not found after recreate" >&2
  exit 1
fi

echo "[jterm-hotpatch] installing into ArozOS volume + template…"
# Clear app/ first — docker cp merges and leaves stale hashed Vite assets.
docker exec "\${CID}" mkdir -p /var/lib/arozos/subservice/jterm /opt/arozos-template/subservice/jterm
docker exec "\${CID}" rm -rf /var/lib/arozos/subservice/jterm/app /opt/arozos-template/subservice/jterm/app
docker cp "${REMOTE_TMP}/jterm/." "\${CID}:/var/lib/arozos/subservice/jterm/"
docker cp "${REMOTE_TMP}/jterm/." "\${CID}:/opt/arozos-template/subservice/jterm/"
docker exec "\${CID}" chmod +x /var/lib/arozos/subservice/jterm/start.sh /var/lib/arozos/subservice/jterm/server.py
docker exec "\${CID}" chmod +x /opt/arozos-template/subservice/jterm/start.sh /opt/arozos-template/subservice/jterm/server.py
# Desktop icon
docker exec "\${CID}" mkdir -p /var/lib/arozos/web/img/joshu /opt/arozos-template/web/img/joshu
docker cp "${REMOTE_TMP}/terminal.png" "\${CID}:/var/lib/arozos/web/img/joshu/terminal.png"
docker cp "${REMOTE_TMP}/terminal.png" "\${CID}:/opt/arozos-template/web/img/joshu/terminal.png"
# Install shortcut via shared helper
docker cp "${REMOTE_TMP}/arozos-desktop-shortcuts.sh" "\${CID}:/tmp/arozos-desktop-shortcuts.sh"
docker exec -e AROZ_DATA=/var/lib/arozos "\${CID}" bash -lc '
  source /tmp/arozos-desktop-shortcuts.sh
  install_jterm_shortcuts
'
# Bounce jTerm PTY only (ArozOS will respawn the subservice). Avoid pkill -x arozos.
docker exec "\${CID}" bash -lc 'pkill -f "/var/lib/arozos/subservice/jterm/server.py" 2>/dev/null || true' || true
rm -rf "${REMOTE_TMP}"
echo "[jterm-hotpatch] done — hard-refresh the desktop (Cmd+Shift+R) and open a new jTerm window"
EOF
