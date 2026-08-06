#!/usr/bin/env bash
# Apply Joshu Langfuse patches to Hermes (idempotent).
#
# Hermes >= v0.20: use scripts/patch-hermes-langfuse-openrouter.py (conversation_loop
# + refactored langfuse/openrouter surfaces).
# Older pins: fall back to unified .patch files when the v0.20 applicator skips.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
LANGFUSE_PLUGIN="${HERMES_DIR}/plugins/observability/langfuse/__init__.py"
CONVERSATION_LOOP="${HERMES_DIR}/agent/conversation_loop.py"

if [[ ! -f "${LANGFUSE_PLUGIN}" ]]; then
  echo "[hermes-langfuse-patch] skip: ${LANGFUSE_PLUGIN} not found"
  exit 0
fi

# Prefer Python applicator when the extracted conversation loop exists (v0.20+).
if [[ -f "${CONVERSATION_LOOP}" ]]; then
  echo "[hermes-langfuse-patch] applying via patch-hermes-langfuse-openrouter.py (v0.20+)"
  HERMES_DIR="${HERMES_DIR}" python3 "${SCRIPT_DIR}/patch-hermes-langfuse-openrouter.py"
  exit 0
fi

apply_patch() {
  local label="$1"
  local patch_file="$2"
  local already_marker="$3"

  if rg -q "${already_marker}" "${LANGFUSE_PLUGIN}" 2>/dev/null; then
    echo "[hermes-langfuse-patch] ${label} already applied"
    return 0
  fi

  if [[ ! -f "${patch_file}" ]]; then
    echo "[hermes-langfuse-patch] error: missing ${patch_file}" >&2
    return 1
  fi

  echo "[hermes-langfuse-patch] applying ${label} from ${patch_file}"
  (cd "${HERMES_DIR}" && patch --forward -p1 < "${patch_file}")
}

# Legacy path for pre-v0.20 checkouts.
apply_patch "per-box user_id" \
  "${SCRIPT_DIR}/hermes-langfuse-user-id.patch" \
  "langfuse_user_id = _env"

apply_patch "system-prompt tracing" \
  "${SCRIPT_DIR}/hermes-langfuse-system-prompt.patch" \
  "_messages_for_langfuse_input"

apply_patch "OpenRouter usage.include requests" \
  "${SCRIPT_DIR}/hermes-openrouter-usage-include.patch" \
  '"usage": {"include": True}'

apply_patch "OpenRouter cost in Langfuse" \
  "${SCRIPT_DIR}/hermes-langfuse-openrouter-cost.patch" \
  "_openrouter_cost_details"

echo "[hermes-langfuse-patch] done — restart Hermes gateway to load plugin changes"
