---
name: last30days-gui
description: last30days GUI — research/Watching with the app window open.
version: 0.4.3
metadata:
  hermes:
    category: research
---

# last30days GUI skill

Use when the **last30days window is open** (embedded chat or voice). GUI-first: drive the open UI. Escalate to plugin tools only when the owner is in jChat / Telegram with the app closed.

## Platform boundary

| User intent | App window open | App closed (jChat / Telegram) |
|-------------|-----------------|-------------------------------|
| Run research | **`runResearch`** `{ topic, days?, depth? }` — **blocks until done** | **`last30days_research`** — async; Joshu replies in chat |
| Cancel in-flight run | **`cancelRun`** | — |
| Open prior run | **`openRun`** `{ runId }` or snapshot **`recentRuns`** | read `joshu://research/last30days/…` |
| Settings / doctor | **`openSettings`** / **`runDoctor`** | ask owner to open Settings (keys live there) |
| Switch to Watching | **`openWatching`** | **`last30days_watch_list`** |
| Watch a topic | **`watchThisTopic`** `{ topic? }` | **`last30days_watch_add`** then **`last30days_watch_run`** |
| Check watches now | **`openWatching`** (owner clicks Check now) | **`last30days_watch_run`** / **`last30days_watch_run_all`** |
| Watch report | Watching row in the UI | **`last30days_watch_report`** `{ topic }` |
| Stop watching | Watching screen | **`last30days_watch_remove`** `{ topic }` |

Do **not** reply “starting research” before **`runResearch`** returns. Do **not** use `app_gui_action` from jChat when the window is closed. Do **not** invent raw HTTP; plugin tools wrap invoke.

Joshu policy: ScrapeCreators for social/YouTube; X via xquik (fleet relay or self-host key). No browser cookies, yt-dlp, or XAI. Web via Exa when provisioned else keyless DuckDuckGo.

**Query planning is automatic** — pass only the topic to `runResearch` / invoke `research`. Joshu builds the engine QueryPlan server-side (named entity vs concept vs comparison). Do not mention QueryPlan to the owner.

A **report** is a one-shot Research run (no trending-vs-average). A **watch** is an explicit Watching add; trending needs ≥3 watch snapshots. Cron jobs `last30days: watchlist daily` (08:00) and `… weekly` (Mon 08:00) are Hermes **Schedules** no-agent scripts, not Linux crontab.

## Output files

Every completed run writes markdown under **`research/last30days/`** (gbrain-indexed):

- Path is relative to `${JOSHU_FILES_ROOT}` — e.g. `joshu://research/last30days/2026-08-07-cod-a1b2c3d4.md`
- YAML frontmatter: `type: research`, `source: last30days`, `topic`, `run_id`, stats
- Use for email drafts, voice summaries, or `read_file` in Hermes

## GUI snapshot fields

- **`activeView`**: research | watching
- **`topic`**: current topic field
- **`activeRunId`**, **`runStatus`**: live job if any
- **`resultPreview`**: short summary of Results panel
- **`recentRuns`**: last few run ids + statuses + **topic** + when
- **`engineReady`**: engine present on box

When **`runResearch`** returns, summarize key findings and mention the saved `joshu://…` report path.

## Headless invoke (plugin tools wrap these)

| action | Purpose |
|--------|---------|
| `research` | `{ topic, days?, mock?, wait?: boolean, hermesSessionKey? }` — async by default |
| `watchingList` | List topics + trending |
| `watchingAdd` | `{ topic, cadence? }` — no research |
| `watchingRemove` | `{ topic }` |
| `watchingReport` | `{ topic }` |
| `watchingRun` | `{ topic }` — async 7d recheck |
| `watchingRunAll` | `{ cadence? }` — async |
| `watchlistRunAll` | Blocking cron path |
| `doctor` | Health JSON |
| `briefingGenerate` | Generate briefing from store |

Deep web outside loaded results: `skill_view('joshu-browser')` when needed.
