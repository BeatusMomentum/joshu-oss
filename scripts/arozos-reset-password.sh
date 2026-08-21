#!/usr/bin/env bash
# Reset an ArozOS desktop login password from SSH (solo self-host recovery)
# or from the instance-agent (fleet email reset with a precomputed hash).
#
# Fleet boxes email a reset link via the control plane. Standalone/OSS boxes
# stay SSH-only. This script stops joshu-stack briefly, writes a new sha512
# passhash into system/ao.db, rotates the ArozOS session key, then starts the
# stack again. It never force-recreates containers.
#
# Usage (SSH / OSS):
#   bash scripts/arozos-reset-password.sh <username> '<new-password>'
#
# Usage (instance-agent / precomputed hash):
#   AO_PW_HASH=<128-hex> bash scripts/arozos-reset-password.sh <username>
#
# Optional env:
#   AO_DB           — path to ao.db (host SSH only; the agent has no /var/lib/docker)
#   AO_VOLUME       — Docker volume name (default: deploy_joshu_arozos or joshu_arozos)
#   AO_PW_HASH      — sha512 hex; when set, argv password is ignored
#   JOSHU_COMPOSE_DIR — default /opt/joshu/deploy
#   ENV_FILE        — default /etc/joshu/instance.env

set -euo pipefail

USERNAME="${1:?username required}"
NEW_PASSWORD="${2:-}"

if [[ -z "${AO_PW_HASH:-}" && -z "${NEW_PASSWORD}" ]]; then
  echo "[arozos-reset-password] password argv or AO_PW_HASH required" >&2
  exit 2
fi

JOSHU_COMPOSE_DIR="${JOSHU_COMPOSE_DIR:-/opt/joshu/deploy}"
ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SRC="${SCRIPT_DIR}/arozos-reset-password"
GOLANG_IMAGE="${GOLANG_IMAGE:-golang:1.23-alpine}"

# Named volume mount — works from instance-agent (docker socket) without the
# host volume path existing inside the agent container.
RESET_VOLUME=""
# Host directory containing ao.db (SSH on the VPS). Mounted at /dbdir.
RESET_HOST_DIR=""
RESET_DB_IN_CONTAINER=""

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

resolve_reset_target() {
  if [[ -n "${AO_DB:-}" && -f "${AO_DB}" ]]; then
    RESET_HOST_DIR="$(dirname "${AO_DB}")"
    RESET_DB_IN_CONTAINER="/dbdir/ao.db"
    return
  fi
  local vol
  if [[ -n "${AO_VOLUME:-}" ]]; then
    if ! volume_exists "${AO_VOLUME}"; then
      echo "[arozos-reset-password] AO_VOLUME=${AO_VOLUME} not found" >&2
      exit 1
    fi
    RESET_VOLUME="${AO_VOLUME}"
    RESET_DB_IN_CONTAINER="/aroz/system/ao.db"
    return
  fi
  for vol in deploy_joshu_arozos joshu_arozos; do
    if volume_exists "${vol}"; then
      RESET_VOLUME="${vol}"
      RESET_DB_IN_CONTAINER="/aroz/system/ao.db"
      return
    fi
  done
  local mount
  for vol in deploy_joshu_arozos joshu_arozos; do
    mount="$(docker volume inspect "${vol}" --format '{{ .Mountpoint }}' 2>/dev/null || true)"
    if [[ -n "${mount}" && -f "${mount}/system/ao.db" ]]; then
      RESET_HOST_DIR="${mount}/system"
      RESET_DB_IN_CONTAINER="/dbdir/ao.db"
      return
    fi
  done
  echo "[arozos-reset-password] ao.db not found; set AO_VOLUME=deploy_joshu_arozos or AO_DB=/path/to/system/ao.db" >&2
  exit 1
}

list_usernames() {
  if [[ -n "${RESET_VOLUME}" ]]; then
    docker run --rm -v "${RESET_VOLUME}:/aroz:ro" "${GOLANG_IMAGE}" \
      sh -c 'ls -1 /aroz/files/users 2>/dev/null | tr "\n" " "' || true
    return
  fi
  if [[ -n "${RESET_HOST_DIR}" ]]; then
    local users_root
    users_root="$(dirname "$(dirname "${RESET_HOST_DIR}")")/files/users"
    if [[ -d "${users_root}" ]]; then
      ls -1 "${users_root}" 2>/dev/null | tr '\n' ' ' || true
    fi
  fi
}

resolve_reset_target

if [[ ! -d "${RESET_SRC}" ]]; then
  echo "[arozos-reset-password] missing ${RESET_SRC}" >&2
  exit 1
fi

if [[ -n "${RESET_VOLUME}" ]]; then
  echo "[arozos-reset-password] volume=${RESET_VOLUME} db=${RESET_DB_IN_CONTAINER} user=${USERNAME}"
else
  echo "[arozos-reset-password] dbdir=${RESET_HOST_DIR} db=${RESET_DB_IN_CONTAINER} user=${USERNAME}"
fi

if [[ -d "${JOSHU_COMPOSE_DIR}" && -f "${ENV_FILE}" ]]; then
  (
    cd "${JOSHU_COMPOSE_DIR}"
    docker compose -f docker-compose.yml --env-file "${ENV_FILE}" stop joshu-stack
  )
  RESTART=1
else
  echo "[arozos-reset-password] WARN: compose dir/env not found; ensure ArozOS is stopped if update fails" >&2
  RESTART=0
fi

cleanup() {
  if [[ "${RESTART:-0}" == 1 ]]; then
    (
      cd "${JOSHU_COMPOSE_DIR}"
      docker compose -f docker-compose.yml --env-file "${ENV_FILE}" start joshu-stack
    ) || true
  fi
}
trap cleanup EXIT

DOCKER_DB_MOUNT=()
if [[ -n "${RESET_VOLUME}" ]]; then
  DOCKER_DB_MOUNT=(-v "${RESET_VOLUME}:/aroz:rw")
else
  DOCKER_DB_MOUNT=(-v "${RESET_HOST_DIR}:/dbdir:rw")
fi

# Pass secrets via env into the helper container — never on the host argv list
# when AO_PW_HASH is set (fleet). SSH still uses AO_PW.
if ! docker run --rm \
  -e AO_USER="${USERNAME}" \
  -e AO_PW="${NEW_PASSWORD}" \
  -e AO_PW_HASH="${AO_PW_HASH:-}" \
  -e AO_DB_IN="${RESET_DB_IN_CONTAINER}" \
  "${DOCKER_DB_MOUNT[@]}" \
  -v "${RESET_SRC}:/src:ro" \
  -w /src \
  "${GOLANG_IMAGE}" \
  sh -c 'if [ -n "$AO_PW_HASH" ]; then go run . -db "$AO_DB_IN" -user "$AO_USER" -hash "$AO_PW_HASH"; else go run . -db "$AO_DB_IN" -user "$AO_USER" -password "$AO_PW"; fi'; then
  echo "[arozos-reset-password] failed. Known users:$(list_usernames)" >&2
  exit 1
fi

DOMAIN="$(grep -E '^CUSTOMER_DOMAIN=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)"
if [[ -n "${DOMAIN}" ]]; then
  echo "[arozos-reset-password] done — log in at https://${DOMAIN}/"
else
  echo "[arozos-reset-password] done — log in with the new password"
fi
