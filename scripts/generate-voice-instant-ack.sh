#!/usr/bin/env bash
# Generate instant think-ack PCM for voice-realtime using the box S2S voice.
# Safe on VPS (Linux + ffmpeg in joshu-stack) and local dev.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f /etc/joshu/instance.env ]]; then
  # shellcheck disable=SC1091
  set -a
  source /etc/joshu/instance.env
  set +a
fi

if [[ -f "${ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${ROOT}/.env"
  set +a
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[generate-voice-instant-ack] ERROR: ffmpeg not found on PATH" >&2
  exit 1
fi

if [[ "${JOSHU_VOICE_MODE:-realtime_s2s}" != "realtime_s2s" ]]; then
  echo "[generate-voice-instant-ack] skip: JOSHU_VOICE_MODE is not realtime_s2s" >&2
  exit 0
fi

exec python3 "${ROOT}/scripts/generate-voice-instant-ack.py" "$@"
