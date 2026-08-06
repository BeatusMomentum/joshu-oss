# last30days — user guide

Research what people are saying about any topic in the last ~30 days. Open the **last30days** app from the Joshu desktop (icon uses the Memory/hindsight artwork).

Left nav: **Research**, **Watchlist**, **Store**, **Briefings**, **Doctor**. Status and the **gear** (⚙) for **Settings** sit at the bottom of the left nav. On first launch (before setup is saved), a setup dialog appears automatically.

The status pill shows engine readiness (**Ready** / **Running…** / **Engine missing**). ScrapeCreators status (direct key or fleet relay) lives under the gear → **Settings**.

## What it searches

| Working in this app | How |
|---------------------|-----|
| Reddit, Hacker News, Polymarket, GitHub | Free / built-in |
| YouTube, TikTok, Instagram (+ comments) | ScrapeCreators key **or fleet CP relay** |
| Threads, Pinterest, LinkedIn | ScrapeCreators + include list (**or fleet relay**) |
| General web | Exa when fleet `EXA_API_KEY` is set; else keyless DuckDuckGo |

**Not available here:** browser-cookie login, yt-dlp, X/Twitter (no cookies / XAI / Xquik in this app).

---

## First-time setup

On first use a dialog asks you to:

1. **ScrapeCreators** — paste your API key **or** use fleet relay (no key field; social sources via CP proxy).
2. Choose a tier:
   - **Save recommended** — TikTok, Instagram, YouTube comments, and related comment lanes
   - **Save everything tier** — recommended plus Threads, Pinterest, LinkedIn
   - **Save custom includes** — uses whatever you typed in **Custom INCLUDE_SOURCES**

**Skip for now** dismisses the dialog until you reopen it from Settings → **First-time setup…**, or until you save via the gear.

Change keys and includes anytime with the gear → **Settings**.

---

## Research

1. Enter a **Topic** (person, company, product, “A vs B”, etc.).
2. Adjust options as needed:
   - **Depth** — Quick / Default / Deep
   - **Days** — lookback window
   - **Register** — audience preset (`default`, `exec`, `dev`, `creator`, `eli5`)
   - **Emit** — GUI always requests **json (agent)** for structured Results; add `--emit=md` under Extra argv only for Hermes markdown export
   - Chips: `--mock` (offline test), **hiring signals**, **competitors**, **deep research**
   - Optional **`--search` override** and **Extra argv** for power users
3. Click **Run research** (or press Enter in the topic field).
4. Watch the **Live log** while it runs; use **Cancel** to stop.

Optional toggles: mock, hiring signals, competitors, deep research. **Advanced** holds `--search` override and extra argv.

Below the form:

- **Results** — cluster cards sorted by **engagement** (members by relevance); use **Raw JSON** for the export. Not the live-log tip block.
- **Drill** / **Verify freshness** — deepen a cluster or re-check the last report
- **Recent runs** — **Open** reloads a prior job’s stdout + log (safe after hard-refresh; fixed React hooks crash in 0.1.39 UI)

**X / YouTube:** X is off here (Joshu does not use cookies, XAI, or Xquik). YouTube uses your ScrapeCreators key when the planner actually queries it — Quick runs often skip it; use Default/Deep or set `--search` under Advanced. Ignore upstream tips that say `brew install yt-dlp` or log into x.com.

---

## Watchlist

A subscription list of topics you want re-researched on a schedule (backed by `watchlist.py` + the findings store).

Typical args (space-separated in the field):

| Args | Purpose |
|------|---------|
| `list` | Show watched topics and budget |
| `add My Topic` | Add a daily watch (or `add My Topic --weekly`) |
| `remove My Topic` | Drop a watch |
| `run My Topic` / `run-all` | Run research for one or all enabled topics |
| `delta My Topic` | Show what’s new since last run |

Optional webhook delivery can announce new findings when configured in the store settings.

---

## Store, Briefings

These wrap the companion CLI tools. Enter space-separated args and run:

| Screen | Typical args | Purpose |
|--------|----------------|---------|
| **Store** | `stats`, `search …`, `trending` | SQLite findings (enable store in Settings) |
| **Briefings** | `show`, `generate`, `generate --weekly` | Digests from the store |

---

## Doctor

Health checks and diagnostics:

- **json** / **cached** / **probe** / **postmortem** / **plain** — doctor modes
- **preflight** — permission/config summary before a run
- **diagnose** — full source diagnostic dump

Use this if a source looks thin or ScrapeCreators isn’t activating.

---

## Settings (gear ⚙)

Bottom of the left nav:
- **ScrapeCreators API key** — paste your key, or on fleet boxes with relay active the field is hidden (social sources use CP proxy)
- Edit **INCLUDE_SOURCES**, memory dir, register default
- Toggle **Persist findings to SQLite** (`LAST30DAYS_STORE`)
- **Save settings** / **Reload** / **Close**

The JSON dump at the bottom shows the masked public config (keys show as present + last4 only). **OpenRouter** for planner/rerank comes from the box Welcome / fleet provision path — not from your laptop dev shell. Check `reasoning.provider` in that JSON (`openrouter` vs `local`).

---

## Tips

1. Prefer **Quick** for everyday checks; use **Deep** when you need fuller coverage.
2. Start with **Save recommended** on first use unless you know you want Threads/Pinterest/LinkedIn.
3. Use **`--mock`** on Research to exercise the UI without spending API credits.
4. If Results show **grounding failed** or very thin general web, Reddit/HN/SC lanes may still be fine — keyless web is flaky on some networks; fleet boxes should show Exa via `EXA_API_KEY`. Ops: [`last30days-arozos-app.md` — Web / grounding](last30days-arozos-app.md#web--grounding).
5. If the app window was empty after a desktop restart, confirm Joshu is up and hard-refresh the desktop; the module should log `Subservice Registered: last30days` on boot.

Developer / ops details: [`last30days-arozos-app.md`](last30days-arozos-app.md).
