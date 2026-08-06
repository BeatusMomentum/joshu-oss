# Session notes — 2026-06-30: Fleet image 0.1.30 + patrick reprovision

Operator/engineering record for building **`ghcr.io/db-aeon/joshu-sandbox:0.1.30`**, reprovisioning **`patrick.box.joshu.me`**, and landing shared bootstrap fixes in OSS.

Related docs:

- [Troubleshooting and lessons](troubleshooting-and-lessons.md)
- [Hotpatching a running box](hotpatch-running-box.md)
- [Control plane local provisioning](control-plane.md) (see `joshu-control-plane/docs/control-plane-local-provisioning.md`)
- OSS PR: [joshu-oss#16](https://github.com/db-aeon/joshu-oss/pull/16) (email-signature bootstrap)

---

## Summary

| Area | Outcome |
| --- | --- |
| **Fleet image** | `ghcr.io/db-aeon/joshu-sandbox:0.1.30` + `joshu-voice-realtime:0.1.30` built locally and pushed to GHCR |
| **Patrick** | Force-destroyed old DO droplet, reprovisioned via `provision-patrick.ts`; upgraded in place to **0.1.30** |
| **Bootstrap fix** | `email-signature/dist` mount + `sync-dist-from-image.sh` — fixed first-boot Joshu crash |
| **Camofox** | `camoufox-browser:latest` now uses `let session` in tab-create path; patch must handle both `const` and `let` |
| **OSS** | Shared compose/sync fix in [PR #16](https://github.com/db-aeon/joshu-oss/pull/16); Camofox `beforeLimitVariants` already on OSS `main` |
| **CI** | GitHub Actions `joshu-sandbox-image` failed on runner disk; local build succeeded after Docker Desktop restart |

---

## 1. Fleet vs OSS images (do not mix)

| | Fleet / commercial | OSS self-host |
| --- | --- | --- |
| **Image** | `ghcr.io/db-aeon/joshu-sandbox:<tag>` | `ghcr.io/db-aeon/joshu-oss:<tag>` |
| **Built from** | Private `joshu/` (`proprietary/`, design pack, fleet Hermes patches) | `joshu-oss/` |
| **Control plane default** | `deploy/RELEASE.json` → `joshu-sandbox` | N/A (self-host / `joshu-oss-image` workflow) |

Patrick provisions clone **`db-aeon/joshu`** and pull **`joshu-sandbox`**, not `joshu-oss`.

**Canonical workflow for shared deploy scripts:** fix in **`joshu-oss`**, merge, then `bash scripts/sync-from-oss.sh` in fleet ([`docs/oss-fleet-sync.md`](../oss-fleet-sync.md)).

---

## 2. `@joshu/email-signature` first-boot crash

### Symptom

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/node_modules/@joshu/email-signature/dist/index.js'
```

Caddy **502** on `/joshu/`; `joshu-stack` restart loop.

### Root cause

`deploy/docker-compose.yml` bind-mounted the **entire** host path `packages/email-signature/` (git clone = `src/` only, **no `dist/`**). That overwrote the image-built package inside the container.

`box-state` already mounted only `packages/box-state/dist` — email-signature did not.

### Fix (image **0.1.30+**)

1. **`deploy/docker-compose.yml`** — mount `../packages/email-signature/dist` only (same as box-state).
2. **`scripts/sync-dist-from-image.sh`** — copy `email-signature/dist` from pulled image alongside `dist/` and `box-state/dist`.

Bootstrap and admin **Update release** (instance-agent `syncDistFromImage`) now populate host `dist/` before compose mounts it.

### Hotfix (existing box before image cut)

```bash
mkdir -p /opt/joshu/packages/email-signature/dist
docker run --rm ghcr.io/db-aeon/joshu-sandbox:TAG \
  tar -C /opt/joshu/packages/email-signature -cf - dist \
  | tar -C /opt/joshu/packages/email-signature -xf -
cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

---

## 3. Camofox base image drift (`let session`)

`ghcr.io/jo-inc/camofox-browser:latest` changed tab-create setup from:

```javascript
const session = await getSession(userId, { trace: !!trace });
```

to:

```javascript
let session = await getSession(userId, { trace: !!trace });
```

`scripts/patch-camofox-single-tab.mjs` failed at Docker build with:

```text
Could not find /tabs pre-limit cleanup insertion point in /app/server.js
```

**Fleet fix:** handle both `const` and `let` needles (commit on `joshu` `main`).

**OSS `main`** already uses a `beforeLimitVariants` array — prefer syncing OSS → fleet via `sync-from-oss.sh` over duplicating patch logic.

**Verify patch against current base before image build:**

```bash
docker run --rm -v "$PWD/scripts/patch-camofox-single-tab.mjs:/patch.mjs" \
  ghcr.io/jo-inc/camofox-browser:latest \
  sh -c 'cp /app/server.js /tmp/s.js && node /patch.mjs /tmp/s.js && echo OK'
```

---

## 4. Building and pushing fleet 0.1.30

### Local build (fleet)

```bash
cd joshu
export JOSHU_DESIGN_PACK=/path/to/joshu-design
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.30 JOSHU_IMAGE_PUSH=1 npm run vps:build-image
```

`vps-build-image.sh` runs `proprietary/scripts/stage-fleet-docker-patches.sh` (Hermes skill-evolution patch) before `docker buildx`.

Pin: `deploy/RELEASE.json` → sync control-plane `deploy/RELEASE.json` + `joshu-control-plane/data/release-pin.json`.

### Docker Desktop pitfalls (validated 2026-06-30)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `input/output error` on `meta.db` / buildkit during `docker buildx` | Disk **~100% full** (~500MB free) or corrupted Docker data | Free **10GB+**; quit + restart Docker Desktop |
| Build layers succeed, **export/push** fails | Same | Prune may fail if DB corrupt — restart Docker |
| `docker info` hangs after forced quit | Daemon not up | `open -a Docker`; wait for `docker info` |

### GitHub Actions `joshu-sandbox-image`

| Failure | Fix |
| --- | --- |
| `Cannot find module '@joshu/box-state'` during `npm run build:deploy` | Add `npm run build -w @joshu/box-state` **before** `tsc` in root `package.json` `build` script |
| `No space left on device` on runner during Docker export | Retry workflow; consider `docker system prune` step in workflow (future) |
| Tag `v0.1.30` → image `joshu-sandbox:v0.1.30` only | Workflow updated to push **both** `v0.1.30` and `0.1.30` tags |

Local build succeeded when CI did not (runner disk).

---

## 5. Reprovision + upgrade patrick

### Full reprovision (new droplet)

```bash
# Control plane API
POST /api/admin/instances/{id}/destroy  {"force": true}

# Local (loads joshu-control-plane/.env.local)
cd joshu-control-plane/apps/control-plane
npx tsx scripts/provision-patrick.ts
```

Uses `createAdminSandbox` → cloud-init → `ghcr.io/db-aeon/joshu-sandbox` from `deploy/RELEASE.json` / release pin.

### In-place upgrade (same droplet)

```bash
ssh root@patrick.box.joshu.me
# If host has manual compose edits, reset before pull:
git -C /opt/joshu checkout -- deploy/docker-compose.yml
git -C /opt/joshu pull origin main

source /etc/joshu/instance.env
export JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.30
export JOSHU_RELEASE_VERSION=0.1.30
sed -i "s|^JOSHU_IMAGE_REF=.*|JOSHU_IMAGE_REF=$JOSHU_IMAGE_REF|" /etc/joshu/instance.env
sed -i "s|^JOSHU_RELEASE_VERSION=.*|JOSHU_RELEASE_VERSION=$JOSHU_RELEASE_VERSION|" /etc/joshu/instance.env
sed -i "s|^JOSHU_VOICE_IMAGE_REF=.*|JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-voice-realtime:0.1.30|" /etc/joshu/instance.env

bash /opt/joshu/scripts/sync-dist-from-image.sh
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env pull
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate
```

**Voice:** `JOSHU_VOICE_IMAGE_REF` is separate from sandbox tag — bump both in `instance.env` when voice image moves.

### Health vs desktop

After upgrade, **`GET /joshu/api/instance/health`** may return **503** with `healthy: false` while **`/` returns 200** — commonly `camofox.ok: false` (warm-up) and/or `hindsight.ok: false` (missing SA path on host). Core apps (`joshu`, `hermes`, `gbrain`, `connectorsMcp`) can still be OK.

---

## 6. Operator checklist (additions)

1. **Free disk** before local `JOSHU_IMAGE_PUSH=1` builds (~10GB+ recommended on Mac).
2. **Test Camofox patch** against `camofox-browser:latest` when image build fails at `patch-camofox-single-tab.mjs`.
3. **Push `joshu` `main`** before provision (`JOSHU_REPO_REF`) — host bind-mounts `deploy/` from clone.
4. **Shared deploy fixes → OSS first**, then `sync-from-oss.sh` in fleet.
5. After reprovision, confirm **`email-signature/dist/index.js`** on host if health shows Joshu module errors.
6. Bump **`JOSHU_VOICE_IMAGE_REF`** when upgrading voice stack, not only `JOSHU_IMAGE_REF`.

---

## Commits / references

| Repo | Ref |
| --- | --- |
| `joshu` | `3d686ae` (bootstrap + Camofox), `e7af0a7` (CI box-state + workflow tags) |
| `joshu-oss` | [PR #16](https://github.com/db-aeon/joshu-oss/pull/16) — compose + sync-dist only |
| GHCR | `ghcr.io/db-aeon/joshu-sandbox:0.1.30`, `ghcr.io/db-aeon/joshu-voice-realtime:0.1.30` |
