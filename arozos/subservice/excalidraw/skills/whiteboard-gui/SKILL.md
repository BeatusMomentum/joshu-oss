---
name: whiteboard-gui
description: Curatorial jWhiteboard orientation and proposal workflows with human authority.
version: 0.1.0
metadata:
  hermes:
    category: whiteboard
---

# jWhiteboard GUI skill

Use this skill only when the jWhiteboard window is open and a Curatorial Whiteboard (CWM)
workspace is ready.

## Non-negotiable authority boundary

1. Read the injected **GUI snapshot first**. It is the bounded source of truth for the current
   viewport, selection, focus, opening brief, pending proposal, and visible scene preview.
2. Every AI-authored object, relation, region, opening brief, or interpretation starts
   **PROPOSED** and goes to the human review tray.
3. Preserve provenance. Source cards and synthesized claims must include a source ID or URI,
   a short excerpt when available, and an explicit AI-inference link for synthesis.
4. Never accept, confirm, reject, commit, decide, endorse, archive, delete, or overwrite on the
   user's behalf. Those controls are intentionally absent from agent actions.
5. Never send Excalidraw elements, scene JSON, element IDs for mutation, or arbitrary scene
   patches. Use semantic CWM actions only.

## Grounding and divergence

- Treat `deicticContext` as the user's latest ephemeral pointer reference. Before any
  consequential semantic proposal based on it, call `showFocus` for the resolved CWM object IDs
  so the user can see what you intend to affect.
- If `deicticContext.groundingRequired` is `true` (confidence below 0.7), call `showFocus` for the
  candidate object IDs and ask one compact confirmation question. Do **not** call
  `proposeTransaction` or `stageOpening` until the user confirms the highlighted target.
- If the snapshot does not provide enough grounding, ask at most **two compact questions** in
  one turn. Prefer a forced choice plus one scope question.
- Do not invent agreement. Preserve tensions, contradictions, minority views, uncertainty, and
  unresolved questions as separate proposed items.
- During divergence, offer multiple starts or hypotheses. Do not collapse them into one answer
  or turn them into commitments.
- For facts or history not present on the bounded canvas, call `recallToBoard` with a specific
  query and a limit of at most 6. It reads File Brain and Hindsight in parallel and stages only
  bounded `EVIDENCE` / `Source` / `PROPOSED` cards with provenance. It does not write memory or
  accept the cards. Tell the user to review the visible proposal.

## Start Session

1. Inspect the current GUI snapshot.
2. If necessary, call `recallToBoard` for a small diverse source packet; do not perform broad
   recall or copy the same results into `stageOpening`.
3. Call `app_gui_action` with `appId="excalidraw"`, `action="stageOpening"`, and:
   - what changed;
   - tensions or divergent interpretations;
   - open questions;
   - two or three possible starts;
   - source cards with provenance.
4. Tell the user that the result is staged for review, not accepted.

## GUI actions

- `recallToBoard(query, limit?)` — retrieve up to 6 diverse File Brain/Hindsight source cards and
  stage them for review. This action is read-only outside the CWM proposal it creates.
- `stageOpening(brief, sources?)` — stage an opening brief and source cards as one proposal.
- `proposeTransaction(transaction)` — stage validated semantic upserts. No remove, commitment,
  confirmation, or scene binding operations.
- `showFocus(focus)` — ephemerally show existing semantic objects/regions.
- `focusRegion(regionId)` — move the viewport to an existing region.
- `openBoard(path)` — open an eligible relative `.excalidraw` path through jWhiteboard.

### Required `proposeTransaction` shape

Never invent actions like `refreshBoard`, `add_note`, or raw Excalidraw element writes.
Do **not** use the Hermes `excalidraw` diagram skill, `write_file`, `patch`, or terminal edits to
mutate the open board. Disk edits do **not** update the live canvas the user is looking at, and
incomplete scene JSON can crash jWhiteboard on reload. If `app_gui_action` fails, report the error
— never fall back to editing the `.excalidraw` file.
Call exactly:

```json
{
  "appId": "excalidraw",
  "action": "proposeTransaction",
  "args": {
    "transaction": {
      "rationale": "Capture open follow-ups from this conversation",
      "operations": [
        {
          "type": "UPSERT_OBJECT",
          "object": {
            "kind": "Question",
            "layer": "SENSEMAKING",
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

Create **one UPSERT_OBJECT per sticky note**. Prefer `Question` / `Claim` / `Comment` under
`SENSEMAKING` or `Source` under `EVIDENCE`. Conversation-grounded notes may use
`CONVERSATION` provenance as above.

### After the tool returns

- If `app_gui_action` returns `ok: false`, tell the user the error and retry with a valid action.
- If it succeeds, say the note(s) are **staged in the Review tray** (dashed previews), not accepted.
- Never claim “it’s on the board” unless `proposeTransaction` / `stageOpening` / `recallToBoard`
  returned success for this turn.

If a requested action exceeds these boundaries, explain the boundary and ask the user to use
the visible review controls.
