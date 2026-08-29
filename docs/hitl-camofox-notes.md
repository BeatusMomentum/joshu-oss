# HITL Camofox Notes

Fleet topology: [`vps-sandbox/runtime-topology.md`](vps-sandbox/runtime-topology.md).

Working notes for the jWeb (human-in-the-loop) browser stack: Joshu, Hermes,
Camofox, noVNC, and ArozOS subservices.

## Current shape

- **`npm run dev:arozos`** mirrors production topology locally: Camofox, optional
  Hindsight, source-built ArozOS, Joshu on loopback at `/joshu`, ArozOS public on
  `127.0.0.1:8787`.
- **`arozos/subservice/joshu/`** — jWeb module; `start.sh` runs
  `scripts/aroz-subproxy.mjs` to reverse-proxy `/joshu/*` to Joshu on `8788`.
- **`scripts/patch-camofox-single-tab.mjs`** — applied at Docker image build and
  on local Camofox container create. Also re-applied at VPS boot when markers are
  missing (`deploy/scripts/vps-start.sh` → `repair_camfox_server_js`).
- Pins in [`deploy/RELEASE.json`](../deploy/RELEASE.json):
  - **`hermesRef`** — Hermes Agent git SHA
  - **`camofoxBase`** — `ghcr.io/jo-inc/camofox-browser@sha256:…` (digest; not `:latest`)
- Sync Dockerfile defaults: `npm run vps:sync-hermes-pin`, `npm run vps:sync-camofox-pin`
  (both run in `vps:predeploy` / `vps:build-image`).

### Bumping Camofox

1. `docker pull ghcr.io/jo-inc/camofox-browser:latest` and test the patch:
   `node scripts/patch-camofox-single-tab.mjs` against `/app/server.js` in the container.
2. Set `camofoxBase` in `deploy/RELEASE.json` to the image digest
   (`docker inspect --format='{{index .RepoDigests 0}}' …`).
3. `npm run vps:sync-camofox-pin` then rebuild (`npm run vps:build-image`).
4. Local dev: `docker rm -f camofox-hitl && bash scripts/ensure-camofox-container.sh`
   (reads `camofoxBase`; override with `CAMOFOX_BASE` for experiments).

Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

## VNC clipboard (paste / copy)

**x11vnc does not reliably exchange clipboard with the Mac/host.** Braces and
JSON get mangled on keystroke paste; Cmd+C inside Camofox does not reach the
host clipboard.

Joshu bypasses VNC entirely. One visible buffer + two buttons:

| Action | UI | Joshu API | Camofox |
|--------|----|-----------|---------|
| Paste into focused field | **Paste into field**, or **Cmd+V** on the page | `POST /joshu/api/camofox/insert-text` | HITL `POST /tabs/:id/insert-text` (DOM insert at caret) |
| Copy selection / focused field | **Copy from browser**, or **Cmd+C** on the page | `POST /joshu/api/camofox/copy-selection` | `evaluate` + HITL `POST /tabs/:id/selection` |
| Wheel / arrow / Page keys | host bridge in jWeb | `POST /joshu/api/camofox/scroll` | Playwright `/scroll` or `/press` (VNC wheel often drops) |

Cmd+V on the VNC pane uses the browser **paste event** (`clipboardData`) so it
does not need clipboard-read permission inside the ArozOS iframe. The textarea
is a fallback when the Mac clipboard API is blocked: paste into the box, then
**Paste into field**.

Wiring: `public/vnc-clipboard.js` (`pasteViaApi` / `copyViaApi`) ← `public/app.js` /
`public/camofox-viewer.html`. Do **not** send VNC `clipboardPasteFrom` / Ctrl+V
keysyms — that path mangles `{`/`}` and is no longer used.

The Camofox **insert-text** and **selection** routes are not upstream — they are
injected by `scripts/patch-camofox-single-tab.mjs` (`HITL_INSERT_TEXT_ROUTE`,
`HITL_SELECTION_ROUTE`). `vps-start` re-applies the patch when either marker is
missing. Without insert-text, Joshu falls back to `/evaluate`.

Live-box UI hotpatch: `public/` is image-baked — after recreate, `docker cp` the clipboard HTML/JS into `/opt/joshu/public/` or the next image bake. Lane table: [`vps-sandbox/hotpatch-running-box.md`](vps-sandbox/hotpatch-running-box.md).

## Tab reaper / blank-page resets

Upstream Camofox closes tabs idle for `TAB_INACTIVITY_MS` (default **5 minutes**),
using `toolCalls` as the activity signal. **VNC clicks do not increment
`toolCalls`**, so jWeb sessions look idle and get reaped even while a human is
using the browser.

HITL patch behavior:

- `TAB_INACTIVITY_MS` from env; **default `0` disables the reaper**
- `GET /tabs` touches `lastAccess` / reaper counters (**HITL keepalive** — Joshu
  status polls this path)
- Prefer a **timeout + warm-on-open** (default `BROWSER_IDLE_TIMEOUT_MS=300000`)
  over always-on Firefox; set `0` only if you need VNC to never go cold
  (CPU cost)

VPS start exports `TAB_INACTIVITY_MS="${TAB_INACTIVITY_MS:-0}"` and
`BROWSER_IDLE_TIMEOUT_MS="${BROWSER_IDLE_TIMEOUT_MS:-300000}"` (5 minutes).

### jWeb idle shutdown vs “crash”

**Intended lifecycle:** after ~5 minutes with no Camofox sessions, Firefox
idle-shutdowns (`browser idle shutdown`) to free CPU/RAM. Opening jWeb (or
`POST /joshu/api/camofox/fit-viewport`) creates a tab again and VNC reconnects.

**Bug (validated on patrick, 2026-08-21):** idle shutdown worked, but jWeb only
polled status and sat on “waiting for Camofox browser” — no warm path — so it
looked crashed for hours.

**Bug (validated on patrick, 2026-08-22):** warm-on-open relaunched Firefox, but
Camofox `vnc-watcher` only attaches x11vnc when the **Xvfb display number**
changes. Idle shutdown kills Xvfb; the next tab recreates **`:99`**, so the
watcher never starts x11vnc again. noVNC gets **1011** (`connection refused` on
`:5900`) — jWeb looks like it **instantly crashes**. Overlay:
`scripts/camofox-vnc-watcher.sh` via `scripts/patch-camofox-vnc-watcher.sh`
(image build + `vps-start`).

**Hardening (keep the timeout; make start/stop clean):**

| Knob | Default | Why |
|------|---------|-----|
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` (5m) | Shut Firefox down when unused |
| `CAMOFOX_START_URL` | `https://joshu.me/` | Default jWeb home on warm |
| jWeb UI | `fit-viewport` when browser down | Auto-warm + clear VNC backoff on open |
| Agent / EA | `POST /joshu/api/camofox/warm` | Same bootstrap as fit-viewport **without** viewport resize |

Set `BROWSER_IDLE_TIMEOUT_MS=0` only if you truly need always-on VNC (accepts the
CPU cost). Repair on a live box: update `/etc/joshu/instance.env`, recreate
`joshu-stack`, then open jWeb once to confirm warm.

### Cold-launch warm (Calendly-class SPAs)

**Problem:** After idle shutdown, the first `browser_navigate` / `open_url` straight
into a heavy SPA (Calendly booking, similar) often crashes or 500s the Camofox
session — cold Firefox + first paint of a large app is fragile.

**Fix (baked in `scripts/patch-camofox-single-tab.mjs`):** on a fresh Camoufox
launch (or within ~2m of `_lastBrowserRestartAt`), before navigating to a URL
that is **not** already `CAMOFOX_START_URL`, Camofox loads the start URL first
(`domcontentloaded`), then continues to the target. Logs:
`hitl cold launch warm before heavy nav`.

**Belt-and-suspenders for agents:** before the first navigate on a cold browser,
call `POST /joshu/api/camofox/warm` (alias of fit-viewport bootstrap without
resize). EA scheduling skill documents a **2-navigate retry budget** then email
fallback — do not loop Calendly submits.

## `CAMOFOX_START_URL` / `about:blank`

- VPS default is **`https://joshu.me/`**.
- Joshu `normalizeHttpUrl` accepts `about:blank`; bootstrap does **not** navigate
  an existing non-blank tab unless `navigateExisting` is set.
- Status polling must **not** call `ensureTab(START_URL)` on every tick (that
  used to reset users mid-session).
- Camofox patch `__hitlStartUrlFromEnv()` treats blank / empty as “no auto URL”
  (never coerces to a surprise site).
- Cold-launch warm (above) uses this URL as the light first paint before a
  different heavy target.

Per-box overrides (Slack apps URL, etc.) belong in `instance.env` — do not
hardcode customer sites in AGPL sources.

## VNC display routing and troubleshooting

Use the Camofox container logs and `CAMOFOX_URL` health check when the noVNC iframe is blank. See [`self-host.md`](self-host.md) for Camofox env vars.

### Ports and URLs (local `npm run dev:arozos`)

| URL | What it is |
|-----|------------|
| `http://127.0.0.1:8788/joshu/...` | Joshu Express **directly** (always works if Joshu is up) |
| `http://127.0.0.1:8787/...` | ArozOS public desktop only |
| `http://127.0.0.1:8787/joshu/...` | Joshu **only** when the **jWeb** subservice is registered and running |

If `8787/joshu/*` returns ArozOS **404**: check boot logs for
`[Subservice] Subservice Registered: Joshu Browser`; remove
`.local/arozos-data/subservice/joshu/.disabled` if present.

### Hermes scroll / simple actions “reload” the browser

**Cause:** wrong Camofox identity (`user_id` / session mismatch) or over-aggressive
single-tab patch closing all tabs.

**Fix:** Joshu `ensureJoshuHermesConfig()` writes `browser.camofox.user_id`,
`session_key`, `adopt_existing_tab: true`. Recreate Camofox after patch changes.
Restart Hermes gateway after config changes.

### Environment and scripts

| Variable / script | Role |
|-------------------|------|
| `VNC_RESOLUTION`, `CAMOFOX_VIEWPORT_WIDTH`, `CAMOFOX_VIEWPORT_HEIGHT` | Xvfb + viewport (apply at **container create**) |
| `ENABLE_VNC` + Camofox `plugins.vnc.enabled` | noVNC on `:6080` — Camofox **1.6+** requires both (see troubleshooting) |
| `CAMOFOX_START_URL` | Default tab URL when none exists (`https://joshu.me/`) |
| `TAB_INACTIVITY_MS` | Camofox tab reaper; **`0` for jWeb HITL** (default on VPS) |
| `BROWSER_IDLE_TIMEOUT_MS` | Firefox idle shutdown; default **`300000`** — jWeb warm-on-open relaunches |
| `PROXY_*` / `PROXY_COUNTRY` | Residential egress for Camofox (Decodo). Self-host: set in `.env` / `instance.env`. Fleet: `DEFAULT_PROXY_*` at provision (`pnpm enable:camofox-proxy` for existing boxes) |
| `scripts/patch-camofox-single-tab.mjs` | Single tab, viewport, insert-text + selection, reaper/keepalive, **cold-launch warm** |
| `scripts/camofox-vnc-watcher.sh` | Reattach x11vnc after idle shutdown (same `:99`) |
| `scripts/ensure-camofox-container.sh` | Create/start container + wait for `/health` |
| `POST /joshu/api/camofox/fit-viewport` | Bootstrap tab → Camofox viewport route |
| `POST /joshu/api/camofox/warm` | Same bootstrap as fit-viewport **without** viewport resize (agent / EA) |
| `POST /joshu/api/camofox/insert-text` | Playwright paste into focused control (HITL insert-text / evaluate) |
| `POST /joshu/api/camofox/copy-selection` | Read selection or focused field |
| `POST /joshu/api/camofox/scroll` | Wheel / Arrow / Page keys via Playwright (`public/vnc-scroll.js`; rate-limited) |
| `public/app.js` `layoutLetterboxedScreen` | Keep jWeb VNC pane at **4:3** (1024×768) inside the float window |

**Requires:** Joshu `dist/server.js` from `npm run build:deploy` before
`vps:build-image`, plus patched Camofox `/app/server.js`.

### Soft-restart caution

Joshu listens on `:8788`; Docker healthchecks that endpoint. Killing only
`node dist/server.js` without a fast relaunch can fail health → **stack recreate**,
which drops in-container Camofox patches until `vps-start` / image rebuild
re-applies them. Prefer image bake + `repair_camfox_server_js` over ad-hoc
hotpatches.

**Do not** start a second `node dist/server.js` while `vps-start.sh` is still
booting — you get `EADDRINUSE :8788`, health fails, and the stack restart-loops
(validated on patrick 2026-08-21). Wait for `healthy` or recreate once and let
`vps-start` own the listen.

**`public/` is image-baked** (not bind-mounted). Overlaying host `/opt/joshu/public/`
is not enough — `docker cp` into the running container (or bake the next image).
Recreate wipes those copies unless you re-apply.

Wheel bridge (`vnc-scroll.js`) must stay **rate-limited** (coalesce + ≥180ms
between Camofox scroll calls). An unbounded queue flooded Camofox, stalled
health probes, and bounced the stack.

**jWeb Camofox restart must not leave Hermes down (validated patrick, 2026-08-22):**
`restartCamofox()` POSTs `/joshu/api/camofox/restart` then `/joshu/api/hermes/reset`.
Reset used to SIGTERM the gateway and return. Instance health only **probes**
`:8642` (no 180s `ensureApiServer` on that route), so jChat/Slack/cron/phone
stayed dead. `HermesRunner.reset()` now stops then starts when auto-start is on;
a 30s watchdog also respawns a dead gateway.

### Debug overlay (`?debugVnc=1`)

- `screen` aspect ≈ **1.333** (4:3)
- `innerWidth` ≈ **1024**
- `fb: 1024×768`

If the pane looks stretched/wide, confirm `layoutVncScreen()` still delegates to `layoutLetterboxedScreen` and that `/app/server.js` contains `window: [__hitlVp.width, __hitlVp.height]` (Camofox 1.6 `executable_path` needle must match the patch script).

### ArozOS float window

[`arozos/subservice/joshu/moduleInfo.json`](../arozos/subservice/joshu/moduleInfo.json)
`InitFWSize: [1024, 768]` should match `VNC_RESOLUTION`.
