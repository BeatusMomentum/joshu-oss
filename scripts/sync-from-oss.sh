#!/usr/bin/env bash
# Pull canonical AGPL tree from joshu-oss into this fleet superset repo.
#
# joshu-oss was split from fleet via prepare-oss-snapshot.sh (fresh git history), so
# `git merge oss/main` fails with "refusing to merge unrelated histories". We rsync
# from oss/main instead (inverse of prepare-oss-snapshot, preserving fleet-only paths).
#
# Usage:
#   bash scripts/sync-from-oss.sh          # apply OSS tree updates
#   bash scripts/sync-from-oss.sh --check  # exit 1 if fleet files differ from oss/main
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

OSS_REMOTE="${JOSHU_OSS_REMOTE:-oss}"
OSS_BRANCH="${JOSHU_OSS_BRANCH:-main}"
OSS_REF="${OSS_REMOTE}/${OSS_BRANCH}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

if ! git remote get-url "${OSS_REMOTE}" >/dev/null 2>&1; then
  echo "[sync-from-oss] adding remote ${OSS_REMOTE} → https://github.com/db-aeon/joshu-oss.git"
  git remote add "${OSS_REMOTE}" "https://github.com/db-aeon/joshu-oss.git"
fi

echo "[sync-from-oss] fetching ${OSS_REF}"
git fetch "${OSS_REMOTE}" "${OSS_BRANCH}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/joshu-oss-sync.XXXXXX")"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

echo "[sync-from-oss] extracting ${OSS_REF} to ${TMP_DIR}"
git archive "${OSS_REF}" | tar -x -C "${TMP_DIR}"

# Mirror prepare-oss-snapshot.sh exclusions (fleet-only paths stay in this repo).
RSYNC_EXCLUDES=(
  --exclude .git
  --exclude node_modules
  --exclude .next
  --exclude dist
  --exclude .local
  --exclude apps/control-plane
  --exclude .env
  --exclude .env.local
  --exclude '**/.env'
  --exclude '**/.env.local'
  --exclude '**/.env.*.local'
  --exclude aeon-page-to-speech-config.json
  --exclude proprietary
  --exclude vendor
  --exclude .cursor
  --exclude arozos/web-overlays
  # Docs are one-way fleet → OSS (prepare-oss-snapshot + oss-doc-sanitize). Pulling
  # OSS docs back would overwrite fleet canon with stripped/sanitized copies.
  --exclude docs
  # Curated OSS export sources — fleet keeps its own README / CONTRIBUTING trees.
  --exclude README.md
  --exclude README.oss.md
  --exclude CONTRIBUTING.md
  --exclude CONTRIBUTING.oss.md
  # OSS export pipeline — fleet canon (doc layout differs from joshu-oss).
  --exclude scripts/prepare-oss-snapshot.sh
  --exclude scripts/oss-doc-sanitize.sh
  --exclude scripts/publish-oss-release.sh
  --exclude scripts/check-oss-boundaries.sh
  --exclude .github/workflows/joshu-oss-image.yml
  --exclude .github/workflows/oss-boundaries.yml
  # Fleet-only scripts (stripped from OSS snapshot).
  --exclude scripts/sync-from-oss.sh
  --exclude scripts/diff-factory-skill-with-learning.sh
  --exclude scripts/hotfix-box-to-0.1.26.sh
  --exclude scripts/sync-hermes-to-vps.sh
  --exclude scripts/sync-hindsight-to-vps.sh
  --exclude scripts/sync-camofox-proxy-to-vps.sh
  --exclude scripts/repair-vps-admin-update.sh
  --exclude scripts/repair-instance-env-drift.sh
  --exclude scripts/refresh-vps-ghcr-login.sh
  --exclude scripts/lib/ensure-hermes-learning-git.sh
  --exclude src/hermesLearningGitCron.ts
  --exclude .github/workflows/fleet-sync-check.yml
  --exclude .github/workflows/joshu-sandbox-image.yml
  --exclude deploy/RELEASE.json
  --exclude deploy/.env.vps.example
  # Docker build staging is a generated artifact (marker committed; rest gitignored).
  --exclude .docker-staging
  # Rendered at container start from instance.env — never a tracked source file.
  --exclude deploy/Caddyfile
)

RSYNC_FLAGS=(-a --itemize-changes)

# Fleet supersets: files present in both repos where the fleet copy adds
# fleet-only code. rsync cannot merge those, so every sync reverts them — this
# has already cost the owner-email routes twice. Excluding them is not right
# either, because genuine OSS changes to these files do need to land here.
#
# So we restore the fleet copy after rsync (identified by a marker string only
# the fleet copy contains) and escalate only when OSS itself changed the file
# since the last sync, which is the case that needs a human merge.
FLEET_SUPERSET_MARKERS=(
  "src/server.ts:registerInstanceOwnerEmailRoutes"
  "packages/instance-agent/src/index.ts:applySendOwnerEmail"
  "scripts/stage-docker-design-pack.sh:requires joshu-design"
  "scripts/vps-build-image.sh:JOSHU_REQUIRE_DESIGN_PACK"
)

superset_files() {
  local entry
  for entry in "${FLEET_SUPERSET_MARKERS[@]}"; do
    echo "${entry%%:*}"
  done
}

# Uncommitted fleet edits are not ours to throw away, so note them beforehand.
record_dirty_supersets() {
  local file
  DIRTY_BEFORE_SYNC=()
  while read -r file; do
    [[ -f "${ROOT_DIR}/${file}" ]] || continue
    git diff --quiet -- "${file}" || DIRTY_BEFORE_SYNC+=("${file}")
  done < <(superset_files)
}

restore_fleet_supersets() {
  local prev_sha="${1:-}"
  local entry file marker restored=() blocked=() needs_merge=()

  for entry in "${FLEET_SUPERSET_MARKERS[@]}"; do
    file="${entry%%:*}"
    marker="${entry#*:}"
    [[ -f "${ROOT_DIR}/${file}" ]] || continue
    grep -q "${marker}" "${ROOT_DIR}/${file}" && continue

    # Pre-existing local edits: refuse rather than discard the operator's work.
    if [[ " ${DIRTY_BEFORE_SYNC[*]-} " == *" ${file} "* ]]; then
      blocked+=("${file}")
      continue
    fi

    git checkout -- "${file}"
    restored+=("${file}")
    # Only a real OSS-side change needs reconciling; a plain revert does not.
    if [[ -n "${prev_sha}" ]] && ! git diff --quiet "${prev_sha}" "${OSS_REF}" -- "${file}" 2>/dev/null; then
      needs_merge+=("${file}")
    fi
  done

  if [[ ${#restored[@]} -gt 0 ]]; then
    echo "[sync-from-oss] kept fleet copy of $(IFS=', '; echo "${restored[*]}")"
  fi

  if [[ ${#blocked[@]} -gt 0 ]]; then
    echo "[sync-from-oss] FAIL: fleet-only code was overwritten in files you had edited:" >&2
    printf '  - %s\n' "${blocked[@]}" >&2
    echo "  Your pre-sync edits are gone from the working tree; recover from your editor or reflog." >&2
    return 1
  fi

  if [[ ${#needs_merge[@]} -gt 0 ]]; then
    echo "[sync-from-oss] ATTENTION: OSS also changed these fleet-superset files since the last sync:" >&2
    printf '  - %s\n' "${needs_merge[@]}" >&2
    echo "  The fleet copy was kept, so those OSS changes are NOT applied." >&2
    echo "  Review and port by hand: git diff ${prev_sha:0:12} ${OSS_REF} -- <file>" >&2
    return 1
  fi

  return 0
}

echo "[sync-from-oss] comparing tree with ${OSS_REF}"
CHANGES="$(rsync -n "${RSYNC_FLAGS[@]}" "${RSYNC_EXCLUDES[@]}" "${TMP_DIR}/" "${ROOT_DIR}/" 2>/dev/null || true)"

HAS_CHANGES=0
if echo "${CHANGES}" | grep -qE '^[<>c]'; then
  HAS_CHANGES=1
fi

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  if [[ "${HAS_CHANGES}" -eq 1 ]]; then
    echo "[sync-from-oss] FAIL: fleet differs from ${OSS_REF} (run without --check to apply)" >&2
    echo "${CHANGES}" | grep -E '^[<>c]' | head -40 >&2
    exit 1
  fi
  echo "[sync-from-oss] OK — fleet AGPL tree matches ${OSS_REF}"
  exit 0
fi

PREV_OSS_SHA=""
if [[ -f "${ROOT_DIR}/.oss-sync-ref" ]]; then
  PREV_OSS_SHA="$(tr -d '[:space:]' < "${ROOT_DIR}/.oss-sync-ref")"
fi

if [[ "${HAS_CHANGES}" -eq 1 ]]; then
  record_dirty_supersets
  rsync -a "${RSYNC_EXCLUDES[@]}" "${TMP_DIR}/" "${ROOT_DIR}/"
  OSS_SHA="$(git rev-parse "${OSS_REF}")"
  echo "${OSS_SHA}" > "${ROOT_DIR}/.oss-sync-ref"
  echo "[sync-from-oss] applied updates from ${OSS_REF} (${OSS_SHA:0:12})"
  echo "[sync-from-oss] review: git status && git diff"
  echo "[sync-from-oss] fleet-only paths preserved (proprietary/, vendor/, arozos/web-overlays/, Joshu-SOP/)"
  restore_fleet_supersets "${PREV_OSS_SHA}"
else
  echo "[sync-from-oss] fleet AGPL tree already matches ${OSS_REF}"
fi
