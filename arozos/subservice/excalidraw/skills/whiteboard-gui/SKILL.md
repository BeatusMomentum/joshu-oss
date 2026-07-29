---
name: whiteboard-gui
description: Curatorial jWhiteboard orientation — notes, questions, and decisions apply immediately with small action notes on the canvas.
version: 0.3.0
metadata:
  hermes:
    category: whiteboard
---

# jWhiteboard GUI skill

Use this skill only when the jWhiteboard window is open and a Curatorial Whiteboard (CWM)
workspace is ready.

## Simplified vocabulary

Auto-classify every board item into exactly one kind:

- `note` — evidence, comments, synthesis that is not a question or commitment
- `open_question` — unresolved questions
- `decision` — something to move forward on (session list + board)

Everything applies immediately in a whiteboard session. There are no Accept chips and no
ghost previews. When an **existing** sticky is acted on, the canvas shows a small plain
Excalidraw text note under it (for example `↳ July 20 call happened`). Freshly created
cards do not get that stamp — the sticky itself is enough.

## Non-negotiable authority boundary

1. Read the injected **GUI snapshot first**. It is the bounded source of truth for the current
   viewport, selection, focus, opening brief, and visible scene preview.
2. Do not invent Accept/Dismiss flows. Session changes apply when you call `proposeTransaction`.
3. Preserve provenance. Source cards and synthesized notes must include a source ID or URI,
   a short excerpt when available, and an explicit AI-inference or conversation link.
4. Never send Excalidraw elements, scene JSON, element IDs for mutation, or arbitrary scene
   patches. Use semantic CWM actions only.

## Grounding and divergence

- **Current canvas selection beats chat history.** If `selectedItems` is non-empty, demonstratives
  such as "these", "those", "both of these", and "this" refer to `selectedItems[].text` (and their
  ids). Do **not** substitute other board items or prior conversation entities when selection is
  present. `selectionSource: "anchored"` still counts — the user selected those stickies, then
  clicked chat (which clears Excalidraw's live highlight). Treat anchored the same as live.
- Call `showFocus` for the selected/resolved CWM object IDs when making a consequential change so
  the user can see the intended targets.
- Treat `deicticContext` (Joshu Pointer) as the next-best ephemeral reference when selection is
  empty. Before any consequential **decision** based on it, call `showFocus` for the resolved IDs.
- If `deicticContext.groundingRequired` is `true` (confidence below 0.7), call `showFocus` for the
  candidate object IDs and ask one compact confirmation question. Do **not** call
  `proposeTransaction` with a decision until the user confirms the highlighted target.
- If neither selection nor pointer provides enough grounding, ask at most **two compact questions**
  in one turn.
- Do not invent agreement. Preserve tensions and unresolved questions as `open_question` notes.
- For facts or history not present on the bounded canvas, call `recallToBoard` with a specific
  query and a limit of at most 6. It applies bounded `note` cards with provenance. Tell the user
  the notes are on the board.

## Start Session / review

**Hard rule (AG-UI):** when `cwmReady` is true, review/orient/capture turns and any turn on an
empty board (`scenePreview: []`) **must** call `proposeTransaction`, `recallToBoard`, or
`stageOpening` before the turn ends. Chat-only inventories are a protocol failure — the platform
will retry once and then tell the user the board was not updated.

1. Inspect the current GUI snapshot (`scenePreview`, `selectedItems`).
2. If the user asks to review action items, what's open, or next steps: **put notes on the
   board in the same turn** via `proposeTransaction` (and/or `recallToBoard` / `stageOpening`).
   Do **not** answer with a chat-only bullet list while leaving the canvas unchanged.
3. If `scenePreview` is empty, the board is empty — create stickies; do not invent that prior
   session cards are still visible.
4. Prefer short grounded turns over long plans.

## Propose board changes

Use `app_gui_action` with `proposeTransaction`:

```json
{
  "appId": "excalidraw",
  "action": "proposeTransaction",
  "args": {
    "transaction": {
      "rationale": "Short why",
      "operations": [
        {
          "type": "UPSERT_OBJECT",
          "object": {
            "kind": "note",
            "title": "Short title",
            "body": "Full sticky-note text",
            "provenance": [
              { "kind": "CONVERSATION", "sourceId": "conversation", "excerpt": "grounding phrase" }
            ]
          }
        }
      ]
    }
  }
}
```

Create **one UPSERT_OBJECT per sticky**. Prefer `note` / `open_question`. Use `decision` when the
item should also appear in the session decisions list. Conversation-grounded items may use
`CONVERSATION` provenance as above.

When the user confirms status on existing stickies ("these are done"), call `proposeTransaction`
with one UPSERT per target. **Do not rewrite the sticky's original wording in `body` as if editing
the card** — keep the original sense in the sidecar if needed; the UI leaves the sticky text alone
and places a small `↳ …` action note under it from your `rationale`.

### After the tool returns

- If `app_gui_action` returns `ok: false`, tell the user the error and retry with a valid action.
- Say the board was updated and a small action note sits under each target.
- Never claim the user still needs to Accept or dismiss a chip.
- Never claim items are “on the board” unless this turn called `proposeTransaction` /
  `recallToBoard` / `stageOpening` successfully.

If a requested action exceeds these boundaries, explain the boundary briefly.
