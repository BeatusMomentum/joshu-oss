---
name: last30days-chat
description: last30days research + Watching from jChat (app closed).
version: 0.3.0
metadata:
  hermes:
    category: research
---

# last30days (jChat / headless)

Use when the owner asks about **community research**, **Watching**, or **what people are saying** about a topic — even if the last30days desktop app is closed.

Call the **plugin tools** below. Do not invent HTTP to `/joshu/api/last30days/*` and do not tell the owner to open the app unless a GUI-only step is required (Settings keys).

## Tools (joshu-last30days plugin)

| Intent | Tool |
|--------|------|
| One-shot research brief | **`last30days_research`** `{ topic, days?, depth? }` — async; Joshu replies in this chat when done. Does **not** add a watch. |
| List watches / trending pills | **`last30days_watch_list`** |
| Start watching a topic | **`last30days_watch_add`** `{ topic, cadence?: "daily" \| "weekly" }` then **`last30days_watch_run`** `{ topic }` to seed snapshot #1 |
| Stop watching | **`last30days_watch_remove`** `{ topic }` |
| Check one topic now | **`last30days_watch_run`** `{ topic }` — async, 7-day window |
| Check all watches now | **`last30days_watch_run_all`** `{ cadence?: "daily" \| "weekly" }` |
| Watch report (vs average) | **`last30days_watch_report`** `{ topic }` |

## Query planning (automatic — do not expose to the owner)

Joshu builds the engine **QueryPlan** server-side when you call research or watch tools. **Pass only `topic` (plus optional `days` / `depth`)** — never invent `--plan`, subreddits, or source overrides yourself.

Planning is tuned by topic shape:

- **Named entity** (Google DeepMind, SpaceXAI) — quoted-entity subqueries, full source set.
- **Concept / industry phrase** (PE operating partners + AI in portcos) — 3–5 keyword fan-out, no TikTok/Instagram, Reddit scoped when relevant.
- **Comparison** (`X vs Y`) — per-entity plus head-to-head subqueries.

Watching persists the plan at add time; cron replays the same plan each recheck.

If results are thin for a broad concept, suggest a **named** watch (firm, report, person) or domain discovery — do not ask the owner about QueryPlan internals.

## Watching vs Research

- **Research** = one-shot report (`last30days_research`). Does **not** update the trending baseline.
- **Watch** = `last30days_watch_add` (subscription). Rechecks use a **7-day** window.
- **Trending / Steady / Quiet** needs **≥3 completed watch runs** (`Building baseline` until then). First add shows `was 0/0` until snapshot #1 lands.
- Scheduled rechecks: Hermes **Schedules** jobs **`last30days: watchlist daily`** (08:00 local) and **`last30days: watchlist weekly`** (Mon 08:00). Those are no-agent scripts — they do not chat or email unless the owner asks you to summarize after a run.

If the owner says “watch SpaceXAI” (or similar): add daily (unless they specify weekly), then run once so Watching is not an empty row.

## Policy (Joshu boxes)

ScrapeCreators + X via **Joshu relay** on fleet (no keys on box). Web via Exa when provisioned. No browser cookies, yt-dlp, or XAI.

## Saved reports

Completed research writes markdown under **`research/last30days/`** — read via `joshu://research/last30days/…` for email summaries.
