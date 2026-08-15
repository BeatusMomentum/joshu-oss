#!/usr/bin/env bash
# Follow-up: apply EA no-autodecompose (compose on 0.1.40 boxes may not mount
# the patcher), re-copy jChat if needed, verify Caddy flush inside the container.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:?usage: hotpatch-fleet-post-0140-followup.sh <slug>}"
TARGET="root@${SLUG}.box.joshu.me"

rsync -az \
  "$ROOT/scripts/patch-hermes-ea-kanban-no-autodecompose.py" \
  "$ROOT/scripts/apply-hermes-ea-kanban-no-autodecompose.sh" \
  "$TARGET:/tmp/"
rsync -az "$ROOT/dist/hermes-chat/" "$TARGET:/tmp/hermes-chat-post0140/"
rsync -az "$ROOT/dist/httpSse.js" "$TARGET:/opt/joshu/dist/httpSse.js"

ssh -o BatchMode=yes "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/joshu/deploy
CID="$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
[[ -n "${CID}" ]] || { echo "no joshu-stack"; exit 1; }

docker cp /tmp/patch-hermes-ea-kanban-no-autodecompose.py "$CID":/tmp/patch-hermes-ea-kanban-no-autodecompose.py
docker exec "$CID" env HERMES_DIR=/opt/hermes-agent python3 /tmp/patch-hermes-ea-kanban-no-autodecompose.py

docker exec "$CID" mkdir -p /var/lib/arozos/subservice/hermes-chat/app /opt/arozos-template/subservice/hermes-chat/app
docker cp /tmp/hermes-chat-post0140/. "$CID":/var/lib/arozos/subservice/hermes-chat/app/
docker cp /tmp/hermes-chat-post0140/. "$CID":/opt/arozos-template/subservice/hermes-chat/app/

echo "--- verify ---"
docker exec "$CID" grep -n _joshu_ea_kanban_no_autodecompose /opt/hermes-agent/gateway/kanban_watchers.py /opt/hermes-agent/hermes_cli/kanban_db.py | head
docker exec "$CID" grep -n ea-owner-reply /opt/hermes-agent/gateway/kanban_watchers.py | head
grep -n SSE_HEARTBEAT_MS /opt/joshu/dist/httpSse.js | head
CC="$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q caddy | head -1)"
docker exec "$CC" grep -n flush_interval /etc/caddy/Caddyfile | head
if docker exec "$CID" grep -R -l "chat connection dropped" /var/lib/arozos/subservice/hermes-chat/app >/tmp/jchat-hit 2>/dev/null; then
  echo "jchat dropped-stream ok"
else
  echo "jchat dropped-stream MISSING"
fi
rm -rf /tmp/hermes-chat-post0140
echo FOLLOWUP_OK
REMOTE
