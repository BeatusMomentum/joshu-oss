#!/usr/bin/env bash
# Overlay Joshu's HITL vnc-watcher (reattach x11vnc after Firefox idle shutdown).
# Target defaults to Camofox's plugin path inside the sandbox image.
set -euo pipefail

WATCHER="${1:-/app/plugins/vnc/vnc-watcher.sh}"
SRC="$(cd "$(dirname "$0")" && pwd)/camofox-vnc-watcher.sh"

if [[ ! -f "$SRC" ]]; then
  echo "[patch-camofox-vnc-watcher] missing $SRC" >&2
  exit 1
fi
if [[ ! -f "$WATCHER" ]]; then
  echo "[patch-camofox-vnc-watcher] skip: no $WATCHER" >&2
  exit 0
fi
if grep -q 'HITL_VNC_REATTACH' "$WATCHER" 2>/dev/null; then
  echo "[patch-camofox-vnc-watcher] already patched ($WATCHER)"
  exit 0
fi

cp "$SRC" "$WATCHER"
chmod +x "$WATCHER"
echo "[patch-camofox-vnc-watcher] installed HITL_VNC_REATTACH watcher → $WATCHER"
