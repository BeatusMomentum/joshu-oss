# jWhiteboard user guide

jWhiteboard is a shared visual board for you and Joshu. You talk, point, and decide.
Joshu retrieves, drafts, and draws. Changes apply on the board immediately in a session —
a small text note appears under each sticky that was just updated.

Think of it as **conversation plus curation**, not an auto-diagram generator.

## The one idea to remember

| Kind | What it means | On the board |
|------|---------------|--------------|
| **note** | Evidence, comments, synthesis | Applied immediately |
| **open_question** | Unresolved questions | Applied immediately |
| **decision** | Something to move forward on | Applied immediately + `↳` note on canvas |

Joshu auto-classifies into those three kinds. There is no Accept chip in a whiteboard session.

---

## Quick start

1. Open ArozOS and launch **jWhiteboard**.
2. Click **New Board**, name it, and confirm.
3. Check the right sidebar: **Curatorial workspace** should say **ready**.
4. Click **Start Session**.
5. Ask Joshu to add or update stickies. Look for a small `↳ …` note under each target.
6. The board file **autosaves** via the CWM sidecar after scene changes.

If the status is not **ready**, you are on an ordinary whiteboard (drawing still works).
Use a board under `joshu's files` as a `.excalidraw` file — **New Board** does this for you.

---

## A typical session

### 1. Orient

Joshu can draft an opening brief and place source notes on the board.

### 2. Point and talk

Select stickies (or use Joshu Pointer) and say things like “both of these are done.”
Selection outranks earlier chat entities.

**Reliable pattern today:** select **one** sticky (or close a lasso around it), then speak.
If the status line says `confirm target` (pointer grazed multiple cards at low
confidence), say which one you mean before expecting a board write. A loose
stroke across two cards is easy for the curator to mis-resolve.

The small `↳ …` line attaches to the sticky the system actually updated (by
internal id), not necessarily the one you meant in chat.

### 3. Watch the board

After each change you should see a small plain text line under the target (`↳ …`) describing
the action. Joshu does **not** rewrite the original sticky wording for status updates.

### 4. Close out

The `.excalidraw` file autosaves through the CWM sidecar after edits and agent
applies. Session handoff markdown remains an optional API/consolidation path,
not a sidebar button.

---

## What Joshu will not do

- Accept or dismiss decisions for you (there is nothing to Accept — writes apply directly)
- Silently rewrite the board from chat memory when stickies are selected
- Patch raw Excalidraw JSON behind the GUI

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Status not ready | Use **New Board** under `joshu's files` |
| Wrong stickies updated | Select only the intended card, start a **new chat**, retry. If Pointer shows `confirm target`, confirm first. |
| `↳` under the wrong card | That note is tied to the card that was written — the curator chose the wrong target. Select again and retry (or New Board if the board is messy). |
| Duplicate text inside one sticky | Older boards; use **New Board** after a hard-refresh so new cards get the dedupe layout. |
| No visible change | Hard-refresh; look for `↳` text under the sticky |
| Agent says Accept chips / “queued, refresh” | Outdated or confused turn — session writes apply immediately. Refresh / restart `dev:arozos`, new chat. |

Developer pause-point (what works, known gaps, Hermes-bypass idea):
[`jwhiteboard-developer-guide.md` — Session prototype status](jwhiteboard-developer-guide.md#session-prototype-status-paused-2026-07-28).
