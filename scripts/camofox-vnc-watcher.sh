#!/bin/sh
# HITL_VNC_REATTACH — Joshu overlay of Camofox plugins/vnc/vnc-watcher.sh
#
# Upstream only (re)attaches x11vnc when the Xvfb *display number* changes.
# Firefox idle-shutdown kills Xvfb; warm-on-open relaunches it on the same :99,
# so the watcher keeps CURRENT_DISPLAY=:99 and never starts x11vnc again.
# jWeb then WS-connects to websockify, which gets connection-refused on :5900
# (noVNC 1011) — looks like an instant crash.
#
# This overlay:
#   - forgets the display when Xvfb disappears
#   - reattaches when x11vnc died under the same display
#   - skips spawning a second websockify if :6080 is already up (live restart)
#
# Called by the VNC plugin via child_process.spawn. Not meant to run standalone.
#
# Env vars (set by the plugin):
#   VNC_PASSWORD    If set, x11vnc requires this password
#   VIEW_ONLY       "1" for view-only mode
#   VNC_PORT        VNC port (default: 5900)
#   NOVNC_PORT      noVNC websocket port (default: 6080)

set -e

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }

CURRENT_DISPLAY=""
X11VNC_PID=""

# Prepare password file if requested
PASSFILE=""
if [ -n "${VNC_PASSWORD:-}" ]; then
  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vnc/passwd >/dev/null 2>&1
  PASSFILE="/tmp/.vnc/passwd"
  log "x11vnc: password protected"
else
  log "x11vnc: NO password (bind $NOVNC_PORT to 127.0.0.1 on host + SSH tunnel)"
fi

# Start noVNC (websockify) -- proxies to x11vnc regardless of whether it's up yet
NOVNC_DIR="/usr/share/novnc"
if [ ! -d "$NOVNC_DIR" ]; then
  log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
  exit 1
fi
VNC_BIND="${VNC_BIND:-127.0.0.1}"
if pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null 2>&1; then
  log "websockify already on $VNC_BIND:$NOVNC_PORT — not starting a second copy"
else
  log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
  websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/var/log/novnc.log 2>&1 &
fi

log "VNC watcher started -- will attach x11vnc when Camoufox's Xvfb appears"

find_xvfb_display() {
  ps -eo args= 2>/dev/null | awk -v res="$VNC_RESOLUTION" '
    /\/Xvfb :[0-9]+/ && index($0, res) {
      for (i=1;i<=NF;i++) if ($i ~ /^:[0-9]+$/) { print $i; exit }
    }
  ' | head -1
}

x11vnc_alive() {
  [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null
}

adopt_existing_x11vnc() {
  display="$1"
  pid=$(pgrep -f "x11vnc.*-display ${display}" | head -1)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    X11VNC_PID="$pid"
    CURRENT_DISPLAY="$display"
    log "x11vnc already running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
    return 0
  fi
  return 1
}

attach_x11vnc() {
  display="$1"
  if adopt_existing_x11vnc "$display"; then
    return 0
  fi

  if [ -n "$X11VNC_PID" ]; then
    kill "$X11VNC_PID" 2>/dev/null || true
    sleep 0.5
  fi

  CURRENT_DISPLAY="$display"
  log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

  X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -rfbport $VNC_PORT -noxdamage -quiet -bg -o /var/log/x11vnc.log"
  [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
  if [ -n "$PASSFILE" ]; then
    X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
  else
    X11VNC_ARGS="$X11VNC_ARGS -nopw"
  fi

  # shellcheck disable=SC2086
  x11vnc $X11VNC_ARGS
  sleep 1
  X11VNC_PID=$(pgrep -f "x11vnc.*-display $CURRENT_DISPLAY" | head -1)
  log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
}

while true; do
  FOUND=$(find_xvfb_display)

  if [ -z "$FOUND" ]; then
    if [ -n "$CURRENT_DISPLAY" ]; then
      log "Xvfb gone (was $CURRENT_DISPLAY); will reattach when it returns"
      if [ -n "$X11VNC_PID" ]; then
        kill "$X11VNC_PID" 2>/dev/null || true
      fi
      X11VNC_PID=""
      CURRENT_DISPLAY=""
    fi
    sleep 2
    continue
  fi

  # Same display number after idle shutdown: Xvfb is new, x11vnc usually dead.
  if [ "$FOUND" = "$CURRENT_DISPLAY" ] && ! x11vnc_alive; then
    log "x11vnc missing on $FOUND; reattaching"
    CURRENT_DISPLAY=""
    X11VNC_PID=""
  fi

  if [ "$FOUND" != "$CURRENT_DISPLAY" ]; then
    attach_x11vnc "$FOUND"
  fi

  sleep 2
done
