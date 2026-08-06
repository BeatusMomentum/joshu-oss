# Box Update Hardening — TODO (revisit)

Context: 2026-07-07 Patrick `0.1.30` → `0.1.33` update was painful. Root cause was
config drift + fatal coupling of a backup step + a self-restart race. Items #1 and
#2 (the two biggest) are now DONE — see "Already fixed" below. See
`troubleshooting-and-lessons.md` for the incident detail.

## 1. Validated + non-fatal pre-update snapshot  (blocker we hit) — DONE 2026-07-07

- ~~Agent validates GCS auth in heartbeat and reports `host.snapshotAuthOk`.~~ Done.
- ~~`readyForUpdate` gates on snapshot creds when a bucket is configured.~~ Done.
- ~~Split `preUpdateSnapshot` failure modes.~~ Done. See "Already fixed" for detail.

## 2. Fix agent self-restart race  (~1 line) — DONE 2026-07-07

- ~~`prepareAgentThenRestart`: add `--no-deps` to the agent self-recreate.~~ Done.

## 3. Stop building the agent on the box

- Ship `instance-agent` as a pinned prebuilt GHCR image (like `caddy:2-alpine`),
  pulled by tag from the release manifest — not built from `/opt/joshu`.
- Deletes `buildHostInstanceAgent` (npm build fails on `patch-package` every time,
  falls back to a `docker cp` dance) and shrinks `prepareAgentThenRestart`.
- Agent version becomes a release artifact instead of a host build.

## Also noted (deeper, later)

- **4.** Bake host scripts into the image; drop bind-mounts for managed boxes
  (keep for local dev). We already proved the pattern with Caddy self-render.
- **5.** Tighten `assertSandboxBootstrapConfig`
  (`joshu-control-plane/joshu-control-plane/src/lib/sandboxBootstrapPreflight.ts:74-84`):
  require an ABSOLUTE SA path + confirm the file is in `secretFiles`. A bare relative
  name (`aeon-page-to-speech-config.json`) slipped through and gave Patrick a broken path.
- **6.** `box-doctor` reconcile script + agent self-heal-on-boot (render Caddyfile,
  sync dist from pinned image, validate snapshot/registry auth, re-apply theme, bring
  up stack with correct compose files/profile, print health summary).
- **7.** Control-plane backfill/reconcile `instance.env` for old boxes.
- **8.** Google SA key perms: any step that writes
  `/etc/joshu/secrets/google-reranker-service-account.json` MUST preserve the
  hindsight group ownership + perms that cloud-init sets
  (`cloudInit.ts:148-156`): `chown root:<hindsight-gid>` on the dir + file,
  `chmod 750` dir, `chmod 640` file. Hindsight runs as user `hindsight` (uid/gid
  1001) and the reranker reads that key directly; `root:root`/`700` gives a silent
  `PermissionError` startup crash (masked by `JOSHU_HINDSIGHT_OPTIONAL=true`).
  The 2026-07-07 snapshot-cred fix reset it to `root:root` and broke hindsight.
  Same key serves both GCS snapshots and the Discovery Engine reranker — keep it
  group-readable by `hindsight`, not just root.
- **9.** ArozOS nightly quota nil-panic (community.project-aeon.com 2026-07-22):
  Desktop went **502** for ~2 weeks while Joshu `:8788` health stayed green.
  Caddy `network_mode: host` was fine; upstream `127.0.0.1:8787` was dead.
  Crash log (`/var/lib/arozos/arozos-manual-restart.log`, 2026-07-07 after
  `DanB logged in`):
  `panic: nil pointer` in
  `quota.(*QuotaHandler).CalculateQuotaUsage(0x0)` ←
  `system_disk_quota_updateAllUserQuotaEstimation` ← nightly task.
  **Hotfix:** restart ArozOS inside `joshu-stack` (same flags as `vps-start.sh`):
  ```bash
  docker exec deploy-joshu-stack-1 bash -c '
    cd /var/lib/arozos && nohup /opt/arozos-template/arozos \
      -port=8787 -disable_ip_resolver=true -hostname=Joshu \
      -tmp=/var/lib/arozos -root=/var/lib/arozos/files \
      >/var/lib/arozos/arozos-manual-restart.log 2>&1 &
  '
  curl -fsS -o /dev/null -w 'arozos=%{http_code}\n' http://127.0.0.1:8787/
  ```
  **Permanent:** nil-guard (or init) `QuotaHandler` in
  `vendor/arozos` → `joshu/patches/arozos/joshu-core.patch`; ensure
  `components.arozos` fails hard enough that `healthy` is false when `:8787`
  is down (0.1.33 OSS health on community did not surface this); optional
  watchdog in `vps-start.sh` / box-doctor (#6) to respawn ArozOS.

## Already fixed 2026-07-07 (so it compounds)

- Caddy self-render (drift-proof edge).
- Theme auto-detect + vanilla fallback (drift-proof branding).
- Health separates `healthy` from `readyForUpdate`; reports arozos + edge.
- Patrick snapshot creds corrected (absolute SA path); durable because the current
  provision template already writes the absolute path.
- Patrick hindsight restored: SA key re-chowned `root:1001` / dir `750` / file `640`
  so the `hindsight` user can read it (was broken by the snapshot-cred fix). See #8.
- **#2 agent self-restart race fixed**: `prepareAgentThenRestart`
  (`packages/instance-agent/src/index.ts`) now recreates the agent with
  `up -d --no-deps --force-recreate instance-agent`. Without `--no-deps`, compose
  also recreated the `depends_on` `joshu-stack` using only the base compose file
  (dropping the fleet overlay mounts), and the agent exited into that half-recreated
  stack → both containers wedged in "Created". Mirrored in joshu-oss.
- **#1 validated + non-fatal pre-update snapshot**:
  - New shared `evaluateSnapshotCredStatus` in `@joshu/box-state`
    (`packages/box-state/src/snapshotCreds.ts`) + a self-contained mirror in the
    agent (`packages/instance-agent/src/snapshotCreds.ts`, isolated build → can't
    import box-state). Validates: bucket set? SA key path resolvable + readable +
    valid JSON with `client_email`/`private_key`?
  - `src/instanceHealth.ts` adds a `snapshot { ok, expected, reason }` component and
    gates `readyForUpdate` on it ONLY when a bucket is configured (so self-hosters
    without snapshots aren't blocked; Patrick's missing-key case now shows
    "not update-ready" BEFORE the click).
  - Agent heartbeat reports `host.snapshotAuthOk`; `preUpdateSnapshot` splits
    failure modes: no bucket → skip; bucket + broken creds → skip with LOUD warning
    (a missing BACKUP no longer aborts an otherwise-reversible update); creds valid
    but snap fails → abort. Mirrored across joshu-oss + fleet.
  - NOT yet done: control-plane admin UI surfacing `host.snapshotAuthOk` (box side
    is complete; UI is a separate joshu-control-plane change).
- Cross-version + non-empty `box restore` of Hindsight made robust
  (`packages/box-state/src/snapshot.ts`, `restoreHindsight`): (a) `sanitizeCrossVersionDump`
  comments out newer-server-only `SET` params (`transaction_timeout`) and ownership-gated
  lines (`COMMENT ON EXTENSION`) that abort under `ON_ERROR_STOP=1`; (b) resets the target
  `public` schema first (drop app-owned tables + matviews, KEEP extensions) so plain
  pg_dump `CREATE`s don't collide with the migration schema Hindsight builds on boot.
  Mirrored in joshu-oss; ships in 0.1.34. Verified end-to-end against Patrick's live DB
  (Mac PG17 dump → box PG15, exit 0). Root cause: dumps are plain (no `--clean`) and the
  target is never empty. NOTE: `--clean --if-exists` is NOT the fix — it would emit
  `DROP EXTENSION vector CASCADE`, which the non-superuser `hindsight` role can't recreate
  and which would drop vector-typed columns.
