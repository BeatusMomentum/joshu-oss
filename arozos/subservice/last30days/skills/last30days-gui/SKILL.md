---
name: last30days-gui
description: last30days desktop UI — GUI-first agent rules when the app window is open.
version: 0.3.0
metadata:
  hermes:
    category: research
---

# last30days GUI skill

Use when the **last30days window is open** (embedded chat or voice).

## Platform boundary

| User intent | Do this | Do NOT |
|-------------|---------|--------|
| Run research on a topic | **`runResearch`** with `{ topic, days?, depth? }` — **blocks until done**, then returns stats + `joshu://…` report path | Reply "starting research" or summarize before the tool returns |
| Run research (Hermes path, app open) | `app_gui_action` **`runResearch`** — same blocking behavior | Headless invoke while app is open |
| Research from jChat / Telegram (app closed) | **`last30days_research`** tool (or invoke `research` with `hermesSessionKey`) | `app_gui_action` |
| Cancel in-flight run | **`cancelRun`** | — |
| Open prior run | **`openRun`** with `{ runId }` or read **`recentRuns`** from snapshot | — |
| Read saved report | Filesystem `read_file` on `joshu://research/last30days/…` or offer to open on desktop | — |
| Settings / watchlist nav | **`openSettings`**, **`openWatchlist`** | — |
| Health / sources thin | **`runDoctor`** or suggest Doctor tab | — |
| Watchlist / cron | `POST /joshu/api/apps/last30days/invoke` action **`watchlistRunAll`** | guiActions |

Joshu policy: ScrapeCreators for social/YouTube; no browser cookies, X/Twitter, yt-dlp, XAI/Xquik. Web via Exa when provisioned else keyless DuckDuckGo.

## Output files

Every completed run writes markdown under **`research/last30days/`** (gbrain-indexed):

- Path is relative to `${JOSHU_FILES_ROOT}` — e.g. `joshu://research/last30days/2026-08-07-cod-a1b2c3d4.md`
- YAML frontmatter: `type: research`, `source: last30days`, `topic`, `run_id`, stats
- Use for email drafts, voice summaries, or `read_file` in Hermes

## GUI snapshot fields

- **`activeView`**: research | watchlist | store | briefings | doctor
- **`topic`**: current topic field
- **`activeRunId`**, **`runStatus`**: live job if any
- **`resultPreview`**: short summary of Results panel
- **`recentRuns`**: last few run ids + statuses + **topic** + when
- **`engineReady`**: engine present on box

When **`runResearch`** returns, summarize key findings and mention the saved `joshu://…` report path.

## Headless invoke actions

| action | Purpose |
|--------|---------|
| `research` | `{ topic, days?, mock?, wait?: boolean, hermesSessionKey? }` — async by default; pass session key for chat callback |
| `doctor` | Health JSON |
| `watchlistRunAll` | Re-research all watchlist topics |
| `briefingGenerate` | Generate briefing from store |

Deep web outside loaded results: `skill_view('joshu-browser')` when needed.
