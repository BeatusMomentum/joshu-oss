#!/usr/bin/env bash
#
# Render the passphrase-lock voice lines to audio in this box's Joshu voice.
#
# Locked phone calls are voiced by these clips instead of by the speech-to-speech
# model, which paraphrases fixed lines and has been seen telling callers they
# were "Unlocked" while the call was still locked. Safe to re-run: only clips
# whose text or voice changed are re-synthesized.
#
#   bash scripts/generate-voice-lock-prompts.sh [--force]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${ROOT}/packages/voice-realtime/dist/generateLockPromptClips.js"

if [[ "${JOSHU_VOICE_MODE:-realtime_s2s}" != "realtime_s2s" ]]; then
  echo "[generate-voice-lock-prompts] skip: JOSHU_VOICE_MODE is not realtime_s2s" >&2
  exit 0
fi

if [[ ! -f "${CLI}" ]]; then
  echo "[generate-voice-lock-prompts] ERROR: ${CLI} missing (build @joshu/voice-realtime first)" >&2
  exit 1
fi

exec node "${CLI}" "$@"
