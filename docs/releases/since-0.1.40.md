# Since 0.1.40 (unreleased)

Stable image is still **`0.1.40`** (`deploy/RELEASE.json`, `ghcr.io/db-aeon/joshu-sandbox:0.1.40` / `ghcr.io/db-aeon/joshu-oss:0.1.40`). This page is the working changelog for **main after that tag** — not a new GHCR tag yet.

Prior cut: [`0.1.38-0.1.40.md`](0.1.38-0.1.40.md).

**As of 2026-08-15.** Mix of commits on `main` plus uncommitted box work.

---

## Slack / Telegram session idle (30 minutes)

Hermes default is `session_reset.mode: none` (one continuous gateway chat until `/new`). Slack DMs were still carrying nine-day-old transcripts.

**Joshu box default:** Slack and Telegram **idle-reset after 30 minutes**. jChat (`api_server`) stays continuous. Override `JOSHU_HERMES_MESSAGING_IDLE_MINUTES` (`0` / `none` to disable). Implementation: [`hermesMessagingSessionReset.ts`](../../src/hermesMessagingSessionReset.ts) (config.yaml + `gateway.json` `reset_by_platform`).

---

## Headline: EA owner-reply child

Owner mail to the **agent Nylas** inbox with a non-meeting ask used to **file** correctly (`ea-mail-ingress` + blocked `mail_track`) and then sit forever: ingress cannot send, project tracks default-block, and `project-*` must not `nylas_send_message`.

**Fix (scheduling analog):** after filing, path **D** spawns a **ready** task on board **`ea-owner-reply`** (`kind: owner_reply`, skill **`ea-owner-reply`**). The worker does the ask, then **`nylas_send_message`** on that thread. Ingress stays send-free. `mail_create_track_task` still default-blocks (waiting on a counterparty).

| Piece | Detail |
|-------|--------|
| Eligibility | Nylas + `from` is owner + track + **not** scheduling path A; skip `owner_sent_update` ([`ownerReplyEligibility.ts`](../../src/ea/ownerReplyEligibility.ts)) |
| Create | Assignee → **ready**; thread_id dedup → `existing_thread`; **no** post-create block |
| Handoff | Later mail on the same thread → `owner_reply_handoff_task` (unblock if blocked) |
| MCP | `owner_reply_list_tasks`, `owner_reply_create_task`, `owner_reply_handoff_task` |
| REST | `GET/POST /api/ea/owner-reply/tasks`, `POST …/tasks/:taskId/handoff` |
| Boards | `ea-owner-reply` in `EA_KANBAN_BOARDS` + no-autodecompose patch set |
| Skill | [`ea-owner-reply`](../../integrations/hermes/skills/executive-assistant/ea-owner-reply/SKILL.md); playbook **2.20.0** path D |
| Test | `npm run test:owner-reply` |

**Out of scope here:** Gmail delete/trash opt-in, unblocking existing `mail_track` cards, global ready-task sweep, sends from `project-*`.

Spec: [`hermes-integration.md`](../hermes-integration.md#owner-reply-child-kanban-first-2026-08) · MCP table: [`connectors.md`](../connectors.md#connectors-mcp-http-8795).

---

## EA Kanban + Nylas (on `main`)

Commit `c1cc83c`:

- **Single-worker EA boards** — skip Hermes `auto_decompose` on `ea-scheduling` / `ea-mail-ingress` / `ea-sched-ingress` (now also `ea-owner-reply` in the working tree). Block-loop stays **blocked**, not triage, so ingress unblock→re-block cannot fan out duplicate outreach.
- **Live Nylas parent for replies** — when the mail mirror is missing, authorize `nylas_send_message` from the live parent message so follow-ups still reach action guard.

---

## Voice / Langfuse (on `main`)

Commit `02c7282`: Realtime often calls `think` before STT lands, so traces showed only Intent/summary. Browser and phone now **backfill `User said:`** from late STT so Langfuse shows the spoken utterance.

---

## jChat SSE through Caddy

Long Hermes turns were dying at the edge (idle timeout / buffered proxy) and jChat marked the assistant **done** with an empty bubble.

| Change | Detail |
|--------|--------|
| [`src/httpSse.ts`](../../src/httpSse.ts) | Shared SSE headers, `sseSend` / `sseData`, **15s comment heartbeats** |
| Chat + AG-UI + last30days run SSE | Heartbeats while the model is quiet |
| Caddy `/joshu/*` | `flush_interval -1` + 1h HTTP read/write timeouts |
| jChat client | Treat missing `done`/`error` as a **dropped connection** (prompt to continue), not a successful empty reply |

Doc: [`hermes-chat-arozos-app.md`](../hermes-chat-arozos-app.md).

---

## Packaging / OSS hygiene (on `main`, post-tag)

These landed after the 0.1.40 tag; they do not change product behavior on an already-built 0.1.40 image:

- OSS README source sync (`README.oss.md`)
- OSS image CI: last30days skill sync, gbrain pin quoting, empty design-pack marker
- Keep `hermesLearningGitCron` in OSS export (tsc import surface)
- ASCII-only `RELEASE.json` notes
- Neutral docker-compose bind-mount comments
- Record OSS sync ref at the 0.1.40 release

---

## Not in this cut

- **`deploy/RELEASE.json` still `0.1.40`** — no new sandbox/OSS image tag
- Hermes pin unchanged (`3c27eb6` / v0.20)
- Deletion of owner Gmail, Exa key minting at provision (fleet `issue-exa-box-keys` already exists)

---

## Timeline

| Date | Change |
|------|--------|
| 2026-08-07 | Ship **0.1.40** |
| 2026-08-07+ | OSS/CI hygiene on `main` |
| 2026-08 | Voice Langfuse user-quote backfill; EA no-autodecompose + live Nylas parent auth |
| 2026-08-14 | EA **owner-reply** child; jChat SSE heartbeats + Caddy flush |

When this becomes a numbered release, retitle to `0.1.40 → 0.1.xx`, bump `RELEASE.json`, and move “unreleased” off this page.
