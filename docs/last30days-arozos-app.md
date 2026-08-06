# last30days ArozOS app

Joshu desktop UI for the [last30days](https://github.com/mvanhorn/last30days-skill) research engine.

**Owner / operator UI walkthrough:** [`last30days-user-guide.md`](last30days-user-guide.md)

## Policy (hard)

- **ScrapeCreators** for YouTube + TikTok / Instagram / Threads / Pinterest / LinkedIn (via `INCLUDE_SOURCES`).
- **Web** = **Exa** when fleet `EXA_API_KEY` is present (`--web-backend=exa`); else keyless DuckDuckGo. Firecrawl/Brave/Serper stay scrubbed.
- **No yt-dlp** — runner strips PATH entries that contain a `yt-dlp` binary so the engine uses SC YouTube.
- **No browser cookies** — always `--no-browser-cookies`; `FROM_BROWSER` / `AUTH_TOKEN` / `CT0` are scrubbed and rejected in Settings.
- **No XAI / Xquik** — scrubbed. The current engine’s X backends are xai/bird/xurl/xquik only, so **X stays off** in this app until an SC X path exists upstream.

Free keyless sources still run: Reddit public, HN, Polymarket, GitHub (`gh`), StockTwits (ticker topics), Digg/arXiv/Techmeme when their CLIs are on PATH.

## Layout

| Path | Role |
|------|------|
| `apps/last30days/` | Vite/React GUI (`@joshu/design-system`) |
| `arozos/subservice/last30days/` | Manifest + static subservice |
| `src/last30days/` | Joshu REST + SSE runner |
| `integrations/last30days-skill/` | Vendored engine (gitignored snapshot) |
| `integrations/last30days-skill.pin` | Pinned commit SHA |
| `scripts/sync-last30days-skill.sh` | Fetch/refresh engine at pin |

## Sync engine

```bash
bash scripts/sync-last30days-skill.sh
```

Requires network once. Applies Joshu patches automatically:

- `scripts/patch-last30days-sc-relay.py` — fleet CP ScrapeCreators proxy (when `JOSHU_SCRAPECREATORS_MODE=relay`)
- `scripts/patch-last30days-clustering.py` — softer clustering for social/opinion queries + engagement-sorted agent JSON

Re-apply after manual skill sync:

```bash
bash scripts/apply-last30days-sc-relay-patch.sh
bash scripts/apply-last30days-clustering-patch.sh
```

Needs **Python ≥ 3.12** on PATH. Fleet image **0.1.39+** ships `/opt/joshu/.local/python312/bin/python3.12` (uv) and sets `LAST30DAYS_PYTHON` in the container env.

## Config

Written to `~/.config/last30days/.env` (mode `0600`) by the first-use setup dialog and the gear → Settings dialog:

- **ScrapeCreators** key and `INCLUDE_SOURCES` (app-specific; per box via that file — **or fleet CP relay**, no key on box)
- Optional **Perplexity** key (separate opt-in source — not a drop-in for engine `grounding`; stays in this file)

**LLM / reasoning (planner + rerank):** uses the **per-box OpenRouter key** — same resolution as Hermes (`/etc/joshu/instance.env` on fleet, Welcome → Connect AI, or `.joshu/box-secrets/local-env.json`). When OpenRouter is present the engine sets `LAST30DAYS_REASONING_PROVIDER=openrouter` and routes through OpenRouter. Joshu pins planner/rerank to `google/gemini-3.1-flash-lite` (the engine’s default OpenRouter slug `…-preview` returns HTTP 404). The runner does **not** inherit host-shell `GEMINI_API_KEY` / `OPENAI_API_KEY`; without OpenRouter, planner/rerank fall back to deterministic/local scoring.

Recommended `INCLUDE_SOURCES`:

```text
tiktok,instagram,youtube_comments,tiktok_comments,instagram_comments
```

## Local run

```bash
# packages + server
npm run build
npm run test:last30days-runner

# UI alone (Joshu on :8788)
npm run build:last30days   # → dist/last30days-app/
npm run dev:last30days     # :3013, proxies /joshu → :8788

# Or full desktop
npm run dev:arozos
```

Validate manifest:

```bash
node packages/app-sdk/dist/cli.js validate arozos/subservice/last30days/joshu.app.json
```

Smoke:

```bash
bash scripts/last30days-app-smoke.sh
```

Smoke uses `--mock` unless `LAST30DAYS_SMOKE_LIVE=1` and `SCRAPECREATORS_API_KEY` is set in `~/.config/last30days/.env`.

## API (prefix `/joshu/api/last30days`)

Status/config/setup/sources, research/drill/verify-freshness, runs + SSE events, doctor/preflight/diagnose, watchlist/store/briefings companions. Discover/queue/library REST endpoints remain on the API for CLI/agents but are no longer exposed in the GUI.

## Hermes vs desktop app

Upstream [last30days SKILL.md](https://github.com/mvanhorn/last30days-skill) assumes a **two-layer** flow when run inside an agent (Hermes, Claude Code, …):

| Layer | Who | Web |
|-------|-----|-----|
| Engine subprocess | `last30days.py` | Social + structured sources |
| Host agent | Model **WebSearch** tool | General web (Step 0.55 pre-research + Step 2 supplements) |

Setting `LAST30DAYS_NATIVE_SEARCH=1` tells the engine to **skip** keyless `grounding` because the host model will search the web separately.

**Joshu desktop app:** subprocess only — no host WebSearch in the loop. The runner **clears** `LAST30DAYS_NATIVE_SEARCH` and passes `--web-backend=exa` when `EXA_API_KEY` is on the box, else `--web-backend=keyless`. Native search must stay off here; otherwise the engine would skip web with nothing to replace it.

**Fleet Hermes chat today:** the `last30days` skill is **not** in `integrations/hermes/skills-enabled.yaml`, so `/last30days` is not a product skill path on boxes. Hermes web browsing is the **`browser` toolset** (Camofox), not upstream’s WebSearch + last30days workflow. Enabling the skill later would be a separate decision (skill allowlist + agent contract).

## Web / grounding

Engine **`grounding`** = general web. Joshu prefers **Exa** when CP has provisioned `EXA_API_KEY` (per-box mint via `EXA_SERVICE_KEY`, or shared `DEFAULT_EXA_API_KEY` fallback). Without Exa, keyless DuckDuckGo → Startpage → optional SearXNG. Runner still strips Brave/Serper/Parallel/Firecrawl env keys.

On some networks (including many dev IPs), **keyless** providers return bot-challenge HTML → **`grounding: failed`** or thin web in Results. Exa avoids that path. Social sources (Reddit, HN, SC lanes) can still work either way.

**Not wired in Joshu yet:** `LAST30DAYS_SEARXNG_URL` (Settings UI + fleet env). **Not the same as Perplexity:** adding Perplexity to `INCLUDE_SOURCES` enables a separate source; it does not replace Exa/`grounding`.

GUI research always uses **`emit=json`** / `jsonProfile=agent` for structured Results; `--emit=md` is for Extra argv / Hermes export only.

## Fleet rollout (e.g. patrick)

Ships in `npm run build:deploy` → sandbox image includes `dist/last30days-app/` and `arozos/subservice/last30days/`. Desktop shortcut: `scripts/lib/arozos-desktop-shortcuts.sh`.

**Per-box (not CP-provisioned):** owner pastes **ScrapeCreators** into the app Settings → `~/.config/last30days/.env` — **unless fleet relay is on** (default for new boxes).

**Fleet ScrapeCreators relay (default):** when CP has `DEFAULT_SCRAPECREATORS_API_KEY`, provision ships `JOSHU_SCRAPECREATORS_MODE=relay` + `JOSHU_SCRAPECREATORS_RELAY_URL` — **no** `SCRAPECREATORS_API_KEY` on the box. The vendored engine’s `http.py` forwards `api.scrapecreators.com` calls to `POST /api/instances/scrapecreators/proxy` (instance-agent Bearer). Enable on existing boxes: `pnpm enable:scrapecreators-relay patrick` in control-plane. Patch engine after skill sync: `bash scripts/apply-last30days-sc-relay-patch.sh`.

**Clustering / Results ordering:** Joshu patches `cluster.py` (lower similarity threshold for opinion/comparison) and `schema.py` (export clusters sorted by engagement). The GUI also sorts cluster cards by engagement and sorts members by relevance. See `scripts/patch-last30days-clustering.py`.

**Same as Hermes (CP-provisioned):** **OpenRouter** from `/etc/joshu/instance.env` (`joshu-box-{slug}`) — planner/rerank; no host-shell Gemini/OpenAI inheritance. **Exa** from the same file (`EXA_API_KEY`) — web grounding; Hermes pins `web.backend: exa` and enables bundled plugin **`web-exa`** ([web search docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)).

**Typical hotpatch bundle** (after `npm run build:deploy` locally or image pull):

- `dist/last30days/` (server routes + runner)
- Surgical **`server.js`** patch — add `registerLast30DaysRoutes` import + call (do **not** rsync a dev-built `server.js` over the whole host `dist/`)
- `dist/last30days-app/` → `arozos/subservice/last30days/app/` (built UI assets)
- `integrations/last30days-skill/` snapshot on the box (bind-mounted in `deploy/docker-compose.yml`; baked into image after `sync-last30days-skill.sh` at `vps:predeploy`)
- **`LAST30DAYS_PYTHON`** — engine requires **Python ≥ 3.12**. Image **0.1.39+** installs via `uv python install 3.12` at `/opt/joshu/.local/python312/bin/python3.12` (container `ENV`). Older boxes: set the same path in `/etc/joshu/instance.env` after manual uv install.
- Recreate `joshu-stack`; hard-refresh ArozOS desktop

**Smoke on box:**

```bash
bash scripts/last30days-app-smoke.sh
# optional live: LAST30DAYS_SMOKE_LIVE=1 with SCRAPECREATORS_API_KEY in ~/.config/last30days/.env
curl -fsS https://<host>/joshu/api/last30days/status
```

**Verify reasoning:** Settings JSON → `reasoning.provider` should be `openrouter` on fleet boxes with provisioned keys. Doctor → preflight should show OpenRouter present, native search absent, `--web-backend=exa` when `EXA_API_KEY` is set (else `keyless`). Status `policy.web` mirrors that.

See also: [hotpatch-running-box.md](vps-sandbox/hotpatch-running-box.md) (general B3/A lanes).

## Related

- Upstream skill: https://github.com/mvanhorn/last30days-skill
- App SDK: [`app-sdk.md`](app-sdk.md)
- Design tokens: [`design/README.md`](design/README.md)
