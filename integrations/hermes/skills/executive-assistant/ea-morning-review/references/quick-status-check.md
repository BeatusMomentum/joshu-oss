# Quick Status Check (ad-hoc "what's on my plate?")

Run this when the owner asks "what do I need to do?", "check my action items", or any ad-hoc status query outside the morning review flow.

## Source queries (parallel, in this order)

| # | Source | Tool | What it gives |
|---|--------|------|---------------|
| 1 | Previous sessions | `session_search()` (no query) | Recent chat history — what was last worked on |
| 2 | Brain salience | `mcp_gbrain_get_recent_salience(days=7, limit=15)` | Recent activity bursts, mail threads, journal pages touched |
| 3 | Scheduling meetings | `mcp_joshu_connectors_scheduling_list_meeting_tasks()` | All open meeting tasks on the `ea-scheduling` board — booked, blocked, awaiting reply |
| 4 | Project todo files | `read_file(Projects/<slug>/todo.md)` for each active project | Per-project task tables with owner, due date, waiting on, blocker, status |

## Active projects to check

Scan `${JOSHU_FILES_ROOT}/Projects/` for any directory with a `todo.md`. Prefer projects whose `about.md` / `todo.md` show recent activity; always include `other` when present.

## Synthesis format

Group by owner in two buckets:

**FOR YOU (owner)** — items where owner=owner/human, status=open/pending, or waiting on owner review. Include due dates and blockers.

**FOR ME (agent)** — items where owner=agent, status=active/in_progress, or waiting on counterparty. Include what's being waited on.

Omit `done` and `info` rows unless the owner asks for them.

## Pitfalls

- `todo.md` files use a pipe-delimited markdown table, not YAML — parse visually
- Some projects may have `scheduling/` subdirectories with their own meeting notes
- The `other` project catches everything that doesn't fit elsewhere — always check it
- Scheduling tasks with multiple `ingress_handoff` entries mean the counterparty has replied multiple times — read the latest
