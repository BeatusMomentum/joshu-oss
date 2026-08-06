#!/usr/bin/env bash
# Retry provider content_filter responses instead of surfacing moderation boilerplate.
#
# Hermes >= v0.20: patch agent/conversation_loop.py via patch-hermes-content-filter-v020.py
# Older pins: unified hermes-content-filter.patch against run_agent.py
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/Users/danbenyamin/Documents/dev/hermes-agent}"
CONVERSATION_LOOP="${HERMES_DIR}/agent/conversation_loop.py"
TARGET="${HERMES_DIR}/run_agent.py"
PATCH="${SCRIPT_DIR}/hermes-content-filter.patch"

if [[ -f "${CONVERSATION_LOOP}" ]]; then
  echo "[hermes-content-filter-patch] applying via patch-hermes-content-filter-v020.py (v0.20+)"
  HERMES_DIR="${HERMES_DIR}" python3 "${SCRIPT_DIR}/patch-hermes-content-filter-v020.py"
  exit $?
fi

if [[ ! -f "${TARGET}" ]]; then
  echo "[hermes-content-filter-patch] skip: ${TARGET} not found"
  exit 0
fi

if rg -q "_is_provider_content_filter_response" "${TARGET}" 2>/dev/null; then
  echo "[hermes-content-filter-patch] already applied"
  exit 0
fi

if [[ ! -f "${PATCH}" ]]; then
  echo "[hermes-content-filter-patch] error: missing ${PATCH}" >&2
  exit 1
fi

echo "[hermes-content-filter-patch] applying from ${PATCH}"
if (cd "${HERMES_DIR}" && patch --forward -p1 --batch < "${PATCH}" 2>/dev/null); then
  echo "[hermes-content-filter-patch] done — restart Hermes gateway to load changes"
  exit 0
fi

if rg -q "_is_provider_content_filter_response" "${TARGET}" 2>/dev/null; then
  echo "[hermes-content-filter-patch] already applied"
  exit 0
fi

echo "[hermes-content-filter-patch] error: patch failed and content-filter helpers missing" >&2
exit 1
