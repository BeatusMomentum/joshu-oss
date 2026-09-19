# Realtime goals

Joshu moves clearly long owner requests out of realtime chat turns and into a
durable Hermes Kanban worker. The owner receives an immediate same-channel
acknowledgment, may continue chatting or queue more work, and receives blocked
questions and completion results on the originating channel.

## Scope

Included owner-authenticated surfaces:

- Twilio SMS
- jChat
- embedded AG-UI app chat
- browser voice
- Twilio PSTN voice
- Hermes Slack
- Hermes Telegram

Mail ingress and public Share Chat are intentionally excluded.

## Flow

1. The channel adapter sends the owner message and stable transport identity to
   `RealtimeGoalBroker`.
2. Deterministic cancel/status phrases run first. A small structured classifier
   then returns `pass`, `clarify`, `queue`, `update`, `cancel`, or `status`.
3. Classification is intentionally conservative. Only high-confidence work that
   is clearly longer than about one minute is deferred. Errors and uncertainty
   pass through to the normal Hermes turn.

### Channel-neutral admission (coding preference)

**One policy for every surface** — SMS, jChat, AG-UI, Slack, Telegram, browser
voice, PSTN. Do **not** add domain whitelists (`search_flights`, `book_hotel`,
travel regexes, etc.) or channel-specific “long intent” tables in the broker or
classifier. Those rot quickly and duplicate what the classifier already does.

When a channel mis-queues or mis-passes, fix **plumbing** so the classifier sees
the same owner substance other channels get:

| Surface | Broker `text` source |
| --- | --- |
| jChat / AG-UI | Last user message in the chat turn |
| SMS | Inbound body |
| Slack / Telegram | Gateway hook message |
| Voice `think` | Full structured think user message (`Intent` / `Conversation summary` / `User said`) — same string Hermes receives, **not** a thin Realtime paraphrase |

Voice-realtime: [`packages/voice-realtime/src/brainThink.ts`](../packages/voice-realtime/src/brainThink.ts)
calls `POST /api/realtime-goals/route` before Hermes. PSTN uses stable
`sessionKey: pstn:owner` so status/cancel works across `CallSid`s.

The classifier prompt may mention structured voice fields generically (weight
`User said` when present). Deterministic shortcuts stay limited to **control
phrases** — cancel, status, greetings — never task taxonomy.

General Joshu preferences for this subsystem: minimize scope, keep architecture
clean, avoid application-specific exceptions when a structural fix suffices, and
prefer DRY channel adapters over parallel policies.

4. Consequential missing information is requested on the same channel before
   work is queued.
5. Accepted work enters a durable 60-second commit window. During that window,
   owner updates merge into the goal and “never mind” cancels without starting a
   worker.
6. The lifecycle sweeper creates one directly assigned task on the managed
   `realtime-goals` Kanban board. Automatic decomposition is disabled for this
   board to avoid duplicate external actions and make cancellation atomic.
7. The worker completes with `kanban_complete(summary, metadata, artifacts)` or
   blocks with one concise question. The broker treats persisted Kanban
   task/run state as authoritative and delivers the event on the source channel.

Hermes's pinned Kanban implementation documents `scheduled_at`, but does not
implement it. The commit window therefore lives in Joshu's persisted broker
state; the bridge does not pretend that an ignored field delayed execution.

## Durable state and idempotency

State defaults to:

```text
${JOSHU_FILES_ROOT}/.joshu/realtime-goals/state.json
```

Local development falls back to `.local/realtime-goals/state.json`. Override
with `JOSHU_REALTIME_GOALS_STATE_DIR`.

Each record stores the logical goal ID, origin route, source event ID, intake
messages, release time, Kanban task ID, task status, result summary, and delivery
cursor. Provider event IDs (Twilio `MessageSid`, Slack/Telegram message ID,
jChat message ID, AG-UI run ID, voice think job ID) deduplicate transport
retries. Logical goal IDs remain distinct so separate requests in one
conversation never collapse.

SMS owner messages are written to a small durable inbox before Joshu returns the
Twilio webhook ACK. Normal completion clears the inbox entry. If the process
dies before handling it, restart recovery texts the owner with a bounded preview
and asks for a replay rather than silently losing an ACKed message.

Strict realtime Kanban keys use a partial unique SQLite index and search all
task statuses, including archived tasks. Each handled provider event also keeps
its immutable response receipt so an older webhook retry receives its original
acknowledgment instead of a newer goal response.

## Channel delivery

- SMS uses the existing carrier-safe `sendSms` helper.
- jChat and AG-UI use a durable per-session surface-event queue polled by their
  mounted chat clients. Before acknowledging consumption, the client persists
  the assistant event in a bounded browser cache; reloads rehydrate it into the
  visible transcript and the next Hermes turn includes it.
- Slack uses `chat.postMessage` with the original channel and `thread_ts`.
- Telegram uses `sendMessage` with the original chat and forum thread.
- Browser voice uses the underlying jChat/app session.
- PSTN completion starts an owner callback only during the configured proactive
  working window. The call still requires the Telephone think passphrase. Only
  after successful unlock does voice-realtime fetch and speak the signed goal
  result, then ask whether the owner needs anything else.

Delivery attempts use persisted leases so a process restart cannot leave an
event permanently stuck in `attempting`. Slack also receives a deterministic
`client_msg_id`; channels without a provider idempotency primitive retain the
durable attempt cursor and bounded retry policy.

Completion SMS is idempotent: owner updates appended to a **done** Kanban task no
longer reset the done cursor, and `claimDeliveryAttempt()` atomically suppresses
duplicate sends of the same completion body (regression fixed 2026-09-18).

### Blocked-answer booking phase (2026-09-18)

When the owner replies while a goal is **blocked** (e.g. picks “Holiday Inn” from
a hotel comparison list):

1. The broker records `blockedAnsweredAt`, `lastBlockedPrompt`, and `ownerSelection`.
2. The Kanban card gets an **`Owner selection — BOOK THIS (do not re-search)`**
   append — not a generic owner update.
3. If the worker later `kanban_block`s with the **same** hotel menu again, the
   broker suppresses repeat blocked SMS (owner already answered).
4. The `realtime-goal` worker skill treats owner selection as **booking phase**:
   skip broad OTA search, go to checkout, and `kanban_complete` with the handoff
   link when checkout is staged.

Optional box-specific travel-booking skills may mirror the same booking-phase
rules; the factory `realtime-goal` skill is the canonical worker path.

Twilio callback status webhooks validate `X-Twilio-Signature`. Goal result fetches
use a purpose-separated HMAC token derived from
`JOSHU_REALTIME_GOALS_CALLBACK_SECRET`, falling back to the media-stream secret
and then the Twilio Auth Token. Result/reply/ack routes additionally require a
direct-loopback request, `HERMES_API_KEY`, and the active callback `CallSid`;
the status-callback token cannot read a result. Delivery is acknowledged only
after the speech response completes and Twilio drains a trailing playback mark.

Privileged browser entry points validate the presented cookie against ArozOS
`/system/auth/checkLogin` over loopback before broker admission or voice-token
issuance. Internal plugin/voice broker calls require both proxy-safe direct
localhost and `HERMES_API_KEY`; Caddy-proxied requests cannot masquerade as
local services.

## Cancellation

“Never mind”, “cancel that”, “stop that”, and “forget it” target the most
recently acknowledged active goal only when unambiguous; with several jobs, the
owner is asked to name one. The broker first enters a durable `cancelling` state
and suppresses completion delivery. A pre-release goal is never created on
Kanban. For a released goal, the bridge verifies the worker PID belongs to that
Kanban task, terminates its process group, confirms it stopped, records an audit
comment, and only then archives the task. Failures remain `cancelling` and retry.
If cancellation races task creation, the post-create compare-and-set immediately
stops the new worker without resurrecting the goal.

## Hermes integration

Repo plugin `.hermes/plugins/joshu-realtime-goals/`:

- intercepts already-authorized Slack/Telegram owner messages through Hermes's
  gateway hook and calls the local broker;
- exposes `realtime_goal_defer` when an initially synchronous Hermes turn
  discovers that the work is long.

The defer handler accepts only explicit jChat/AG-UI/SMS/PSTN/Slack/Telegram
session identities. It rejects mail, public Share Chat, unknown sessions, and
all Kanban worker processes (`HERMES_KANBAN_TASK`) so background workers cannot
recursively create or misroute realtime goals.

Factory skill `realtime-goal` is force-loaded by deferred workers. It requires
workers to re-read owner updates before consequential actions, use normal action
guard policy, block with one question, and return a self-contained completion
summary without sending directly.

## Configuration

```dotenv
# Default 60 seconds; 0 is useful in tests.
JOSHU_REALTIME_GOALS_RELEASE_SECONDS=60

# Default lifecycle poll is 5000 ms, minimum 1000.
JOSHU_REALTIME_GOALS_POLL_MS=5000

# Optional cheap classifier override.
JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL=openai/gpt-5.4-nano

# Optional explicit persistent state directory.
JOSHU_REALTIME_GOALS_STATE_DIR=

# Optional dedicated HMAC secret for PSTN result callbacks.
JOSHU_REALTIME_GOALS_CALLBACK_SECRET=
```

The classifier uses the existing Day 0/OpenRouter credential path. If it is not
configured, realtime admission fails open and normal Hermes handles the turn.

Implementation: [`src/realtimeGoals/classifier.ts`](../src/realtimeGoals/classifier.ts),
[`src/realtimeGoals/broker.ts`](../src/realtimeGoals/broker.ts).

## Verification

```bash
npm run test:realtime-goals
npm run test:realtime-goals-plugin
npm run test:kanban-bridge-max-runtime
npm run test:sms-send
npm run typecheck
npm run build -w @joshu/app-agent
npm run build -w @joshu/voice-realtime
```
