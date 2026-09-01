#!/usr/bin/env bash
# Hydrate last30days engine if the overlay path is empty.
# Source from vps-start.sh so LAST30DAYS_ENGINE_ROOT survives into node.
#
# The engine snapshot is gitignored. A compose bind-mount of an empty host dir
# used to shadow the image copy (Research 400 / Caddy 502). Image builds bake a
# second copy at /opt/joshu/.image/last30days-skill that is never bind-mounted.
#
# 1. If integrations/.../last30days.py exists, done.
# 2. Else copy from the image fallback into integrations/ (fails if dest is :ro).
# 3. Else set LAST30DAYS_ENGINE_ROOT to the fallback so Node resolveEngineRoot
#    still finds the script.
#
# Never `exit` — this file is sourced from vps-start.

APP_DIR="${APP_DIR:-/opt/joshu}"
DEST_ROOT="${APP_DIR}/integrations/last30days-skill"
DEST_PY="${DEST_ROOT}/skills/last30days/scripts/last30days.py"
IMAGE_ROOT="${LAST30DAYS_IMAGE_ENGINE_ROOT:-${APP_DIR}/.image/last30days-skill}"
IMAGE_PY="${IMAGE_ROOT}/skills/last30days/scripts/last30days.py"

if [[ -f "${DEST_PY}" ]]; then
  echo "[ensure-last30days-engine] ok ${DEST_PY}"
elif [[ -f "${IMAGE_PY}" ]]; then
  mkdir -p "${DEST_ROOT}"
  if cp -a "${IMAGE_ROOT}/." "${DEST_ROOT}/" 2>/dev/null && [[ -f "${DEST_PY}" ]]; then
    echo "[ensure-last30days-engine] hydrated ${DEST_PY} from image fallback"
  else
    LAST30DAYS_ENGINE_ROOT="${IMAGE_ROOT}"
    export LAST30DAYS_ENGINE_ROOT
    echo "[ensure-last30days-engine] dest not writable; LAST30DAYS_ENGINE_ROOT=${IMAGE_ROOT}"
  fi
else
  echo "[ensure-last30days-engine] WARN: engine missing at ${DEST_PY} and no image fallback at ${IMAGE_PY}" >&2
fi
