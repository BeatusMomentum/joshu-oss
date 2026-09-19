---
name: realtime-goal
description: Finish one deferred owner request; block or summarize.
metadata:
  hermes:
    category: productivity
---

# Realtime Goal

Use this skill for a single owner request deferred from SMS, jChat, voice, Slack,
or Telegram.

## Intake turns

- Prefer finishing a request in the current conversation when it is plausibly
  under one minute.
- If required information is missing, ask one focused clarification before
  calling `realtime_goal_defer`.
- If the turn began as quick work but tools/retries make it clearly long, call
  `realtime_goal_defer` with a self-contained objective, then return the tool's
  acknowledgment verbatim. Do not continue the long work in that turn.

## Kanban worker turns

1. Read the complete card body and recent comments before every action.
2. Execute only that card's objective. Use reasonable defaults for low-risk
   details.
3. Follow the normal action guard before consequential external writes.
4. Re-read recent comments before a consequential action and before finishing;
   the owner may amend the goal while it runs.

### Booking phase (after owner picks from a blocked list)

If the card body contains **`Owner selection — BOOK THIS (do not re-search)`**:

- The search phase is **over**. Book the named property only.
- Do **not** run a new broad OTA search or re-send a multi-hotel comparison list.
- Go directly to checkout on that property (IHG direct, Hotels.com property page,
  or a URL already in prior comments).
- When checkout is staged with a browser handoff link, call **`kanban_complete`
  immediately** with the link, total price, cancellation terms, and which fields
  the owner must enter (card, billing ZIP, etc.).
- Never `kanban_block` with the old hotel menu after the owner already chose.
- Only `kanban_block` if that **specific** property is unavailable — with a **new**
  question, not the prior comparison list.

5. If required owner input is missing and there is no owner selection yet, call
   `kanban_block` with one concise, answerable question. Do not guess
   consequential details.
6. When the owner answers a blocked question with a specific choice (hotel name,
   date confirmation, etc.), treat it as authorization to proceed — book or hold
   **that** option. Do not restart a broad OTA search unless the chosen option
   is unavailable.
7. On success, call `kanban_complete` with a self-contained plain-language
   summary. Include artifact paths, handoff links, confirmations, and any
   unresolved caveats.
8. Never send the completion directly. Joshu's durable delivery layer returns it
   to the originating channel.

Treat cancellation or an archived task as terminal. Stop work immediately and do
not perform further side effects.
