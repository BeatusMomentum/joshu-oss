#!/usr/bin/env bash
# Copy the last30days engine from the box image onto the host clone.
# Use on boxes still running the old compose bind-mount of an empty gitignored dir.
#
# Usage:
#   bash scripts/repair-last30days-engine.sh                  # this host (/opt/joshu)
#   bash scripts/repair-last30days-engine.sh root@box          # remote via ssh
#   bash scripts/repair-last30days-engine.sh root@a root@b     # several
set -euo pipefail

ENGINE_REL="integrations/last30days-skill/skills/last30days/scripts/last30days.py"

repair_local() {
  local install="${JOSHU_INSTALL_DIR:-/opt/joshu}"
  local dest="${install}/integrations/last30days-skill"
  local env_file="${JOSHU_INSTANCE_ENV:-/etc/joshu/instance.env}"
  local image="${JOSHU_IMAGE_REF:-}"
  if [[ -z "${image}" && -f "${env_file}" ]]; then
    # shellcheck disable=SC1090
    image="$(grep -E '^JOSHU_IMAGE_REF=' "${env_file}" | tail -1 | cut -d= -f2- | tr -d '"')"
  fi
  [[ -n "${image}" ]] || { echo "set JOSHU_IMAGE_REF or ${env_file}" >&2; return 1; }
  if [[ -f "${install}/${ENGINE_REL}" ]]; then
    echo "[repair-last30days-engine] already present ${install}/${ENGINE_REL}"
    return 0
  fi
  echo "[repair-last30days-engine] copying from ${image} -> ${dest}"
  local cid
  cid="$(docker create "${image}")"
  mkdir -p "${dest}"
  docker cp "${cid}:/opt/joshu/integrations/last30days-skill/." "${dest}/"
  docker rm -f "${cid}" >/dev/null
  test -f "${install}/${ENGINE_REL}"
  echo "[repair-last30days-engine] ok ${install}/${ENGINE_REL}"
}

if [[ $# -eq 0 ]]; then
  repair_local
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for host in "$@"; do
  echo "========== ${host} =========="
  ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "${host}" "bash -s" < "${ROOT_DIR}/scripts/repair-last30days-engine.sh" \
    || echo "[repair-last30days-engine] FAILED ${host}" >&2
done
