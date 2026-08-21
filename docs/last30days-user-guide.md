# last30days — user guide

Research what people are saying about any topic in the last week or month. Open the **last30days** app from the Joshu desktop (icon uses the Memory/hindsight artwork).

Left nav: **Research** and **Watching**. Status and the **gear** (⚙) for **Settings** sit at the bottom of the left nav. On first launch (before setup is saved), a setup dialog appears automatically.

The status pill shows engine readiness (**Ready** / **Running…** / **Engine missing**). ScrapeCreators and X (via Xquik) status live under the gear → **Settings**.

## What it searches

| Working in this app | How |
|---------------------|-----|
| Reddit, Hacker News, Polymarket, GitHub | Free / built-in |
| YouTube, TikTok, Instagram (+ comments) | ScrapeCreators key **or fleet CP relay** |
| Threads, Pinterest, LinkedIn | ScrapeCreators + extra sources (**or fleet relay**) |
| X / Twitter | Xquik key **or fleet CP relay** |
| General web | Exa when fleet `EXA_API_KEY` is set; else keyless DuckDuckGo |

**Not available here:** browser-cookie login, yt-dlp, XAI. Fleet boxes never store a ScrapeCreators or Xquik vendor key — they call the control plane proxy instead.

---

## First-time setup

On first use a dialog asks you to:

1. **ScrapeCreators** — paste your API key **or** use fleet relay (no key field; social sources via CP proxy).
2. Choose a tier:
   - **Save recommended** — TikTok, Instagram, YouTube comments, and related comment lanes
   - **All social** — recommended plus Threads, Pinterest, LinkedIn
   - **Save custom** — uses whatever you typed in **Extra sources**

**Skip for now** dismisses the dialog until you reopen it from Settings → **First-time setup…**, or until you save via the gear.

Change keys and sources anytime with the gear → **Settings**.

---

## Research (a one-shot report)

A **report** answers “what are people saying about this in this window?” It is not compared to a historical average.

1. Enter a **Topic** (person, company, product, “A vs B”, event, etc.). The box builds a search plan automatically (you do not write query JSON).
2. Choose **Last 7 days** or **Last 30 days**.
3. Click **Research** (or press Enter).
4. Read the brief. Cluster cards sort by **relevance**, then **native units per source** (Reddit upvotes, YouTube views, HN points) — not a mixed “eng” total.

**Watch this topic** on a finished brief adds it to **Watching** and uses this run as snapshot #1 (`Building baseline` until three watch runs exist). One-shot reports do **not** enter the trending average unless you watch them.

**More options** (collapsed): Simple / Thorough / Deep, **writing style** (shapes the saved `joshu://research/last30days/…` markdown: section order, how many clusters, source emphasis — not the Results cards), offline test, hiring/competitors, source override. Progress log is hidden unless you open it while a run is live.

History of recent reports sits on the right of Research.

---

## Watching (trending vs average)

A **watch** is an explicit subscription. Watches re-run on a **Daily** or **Weekly** cadence with a **7-day** window (comparable week-to-week, not the engine’s old 90-day quick lookback).

Daily topics run at **08:00** local box time via Hermes cron (`last30days: watchlist daily` in **Schedules**). Weekly topics run **Mondays at 08:00** (`last30days: watchlist weekly`). Those jobs are **no-agent scripts** — they refresh Watching snapshots; they do not email or Telegram you.

After **three** completed watch runs, the status pill can be:

- **Trending** — mentions or comparable engagement ≥2× the recent average (with a small absolute floor so 1→3 mentions is not a trend)
- **Steady** — in line with the average
- **Quiet** — about half or less of the average
- **Building baseline** — fewer than three runs yet

Click a row for a **watch report** (change detection, not another full brief):

1. Vs-average pill
2. What’s new (URLs that appeared this window)
3. What fell off
4. Volume by source vs last run (native units)
5. Collapsed **This window** clusters if you want to read

Steady with nothing new → a one-line “Nothing new this window.”

**Check now** re-runs one topic (or **Check all now**). Add a topic on this screen, or use **Watch this topic** from a report.

You can also watch, list, and re-check topics from **jChat** (app closed): ask to watch a topic, what’s on Watching, or whether something is trending. That uses Hermes tools, not the desktop window.

---

## Settings (gear ⚙)

- **ScrapeCreators** — paste a key, or on fleet boxes the field is hidden (social sources use CP proxy)
- **Xquik** — paste a key for X search on self-host; fleet boxes hide the field (X via CP proxy)
- **Extra sources**, **Save research history**
- **Check connections** — health check when a source looks thin
- **Power user** — memory folder, store/briefing commands (not needed for everyday use)

---

## Tips

1. Prefer **Last 7 days** + Simple for everyday checks; Thorough when you need fuller coverage.
2. Start with **Save recommended** on first use unless you know you want Threads/Pinterest/LinkedIn.
3. Use **Offline test** under More options to exercise the UI without spending API credits.
4. If Results show **grounding failed** or very thin general web, Reddit/HN/SC lanes may still be fine — keyless web is flaky on some networks; fleet boxes should show Exa via `EXA_API_KEY`. Ops: [`last30days-arozos-app.md` — Web / grounding](last30days-arozos-app.md#web--grounding).
5. If the app window was empty after a desktop restart, confirm Joshu is up and hard-refresh the desktop; the module should log `Subservice Registered: last30days` on boot.

Developer / ops details: [`last30days-arozos-app.md`](last30days-arozos-app.md).
