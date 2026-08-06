#!/usr/bin/env bash
# Hotpatch deterministic passphrase-lock prompts onto a running Joshu box.
#
# Ships the current voice-realtime dist into the voice container and renders the
# lock lines in that box's own Joshu voice, so a locked call is voiced by clips
# instead of by the model (which paraphrases, and has told callers "Unlocked."
# right after rejecting their passphrase).
#
# Nothing here survives the next image update, by design — 0.1.38+ ships the
# dist and mounts a joshu_voice_clips volume, and the service renders its own
# clips on start. Until then both live inside the running container, so a
# `docker compose up --force-recreate voice-realtime` undoes this.
#
# Usage:
#   bash scripts/hotpatch-voice-lock-prompts.sh root@box.example.com
#   bash scripts/hotpatch-voice-lock-prompts.sh root@box.example.com --force  # re-render clips
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
FORCE="${2:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host [--force]" >&2
  exit 1
fi

echo "[lock-prompts-hotpatch] building voice-realtime…"
(cd "${ROOT_DIR}/packages/voice-realtime" && npm run build >/dev/null)
for required in lockPrompts.js generateLockPromptClips.js generateLockPromptClipsCli.js; do
  if [[ ! -f "${ROOT_DIR}/packages/voice-realtime/dist/${required}" ]]; then
    echo "[lock-prompts-hotpatch] missing dist/${required} after build" >&2
    exit 1
  fi
done

REMOTE_TMP="/tmp/joshu-lock-prompts-hotpatch-$$"
echo "[lock-prompts-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}'"
rsync -az "${ROOT_DIR}/packages/voice-realtime/dist/" "${TARGET}:${REMOTE_TMP}/voice-dist/"

echo "[lock-prompts-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' GEN_FORCE='${FORCE}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env
cd /opt/joshu/deploy

VCID="$(docker compose -f docker-compose.yml --env-file "${ENV_FILE}" ps -q voice-realtime | head -1)"
if [[ -z "${VCID}" ]]; then
  echo "voice-realtime container not found" >&2
  exit 1
fi

docker cp "${REMOTE_TMP}/voice-dist/." "${VCID}:/app/dist/"
echo "[lock-prompts-hotpatch] dist copied into voice-realtime"

# Pre-0.1.38 containers have no joshu_voice_clips volume, so clips land on the
# container filesystem. VOICE_LOCK_PROMPT_DIR cannot be injected into a running
# container, so use the same path the code falls back to when the volume is absent.
docker exec "${VCID}" mkdir -p /var/lib/joshu-voice
if [[ "${GEN_FORCE}" == "--force" ]]; then
  docker exec "${VCID}" node /app/dist/generateLockPromptClipsCli.js --force
else
  docker exec "${VCID}" node /app/dist/generateLockPromptClipsCli.js
fi

docker restart "${VCID}" >/dev/null
echo "[lock-prompts-hotpatch] voice-realtime restarted"

# A partial clip set is ignored at runtime, so confirm the full set resolves.
docker exec "${VCID}" node -e '
import("/app/dist/lockPrompts.js").then((m) => {
  const missing = m.LOCK_PROMPT_KEYS.filter((k) => !m.getLockPromptClip(k));
  if (missing.length) {
    console.error("[lock-prompts-hotpatch] MISSING clips: " + missing.join(", "));
    process.exit(1);
  }
  console.log(
    "[lock-prompts-hotpatch] all " + m.LOCK_PROMPT_KEYS.length +
      " lock clips resolve from " + m.lockPromptDir(),
  );
});
'

rm -rf "${REMOTE_TMP}"
EOF

echo "[lock-prompts-hotpatch] done — next inbound call is voiced by clips while locked"
