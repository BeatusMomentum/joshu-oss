# Connectors (ArozOS desktop app)

**Connectors** is the app-wide place to manage OAuth connections (Gmail, calendar, Slackbot, etc.). Owner 1:1 approval channel is configured in the **Safety** app. jMail, jChat, Hermes, and cron all read the same backend via `GET /joshu/api/connectors/status`.

## What ships in this repo

| Layer | Location |
|-------|----------|
| Desktop UI | `apps/connectors/` → `dist/connectors-app/` → `arozos/subservice/connectors/app/` |
| Composio OAuth API | `src/connectors/composioRoutes.ts` → `/joshu/api/connectors/composio/*` |
| Connector status + Gmail sync | `src/connectors/routes.ts`, `src/connectors/composio/gmailAccounts.ts` |
| Registry snapshot | `.joshu/connectors-registry.json` (per sandbox user) |
| Multi-Gmail mirrors | `connectors/mail/gmail/{account_key}/threads/` under `JOSHU_FILES_ROOT` |
| jMail | One sidebar tab per `status.gmail.accounts[]` entry |
| jChat | **Open Connectors** only (no inline OAuth modal) |
| Hermes MCP | `mcp-joshu-connectors` — `connectors_sync_now` accepts optional `connectedAccountId` |
| Cron | `poll-nylas` + `sync-gmail` jobs sync agent inbox and **all** enabled Gmail accounts every **10m** |

## Desktop

| Field | Value |
|-------|--------|
| Module name | `Connectors` |
| Subservice dir | `arozos/subservice/connectors/` |
| URL | `/connectors/index.html` |
| Shortcut | `Connectors.shortcut` |

### Slackbot (share-chat KB channels)

Featured toolkit **`slackbot`** is separate from user **`slack`** (approvals / agent tools) and Hermes Slack chat.

1. Open Connectors → Connect apps → **Slackbot** (or `/connectors/index.html#slackbot`).
2. Generate / copy the Slack app manifest → create the app at api.slack.com.
3. Paste Client ID, Client Secret, **Signing Secret**, and **App-Level Token (`xapp-`)** → **Save & Connect** (or **Save credentials** if already OAuth-connected).
4. Paste the shown Event Subscriptions URL into the Slack app. Already connected? Use **Configure Slack app** — do not disconnect.
5. Joshu creates/updates the Composio auth config + webhook endpoint (`ac_…` in `.joshu/composio-auth-configs.json`).

API: `GET/POST /joshu/api/connectors/composio/slackbot/setup`, `GET …/slackbot/manifest`.

### Teams bot (Share Chat, free Teams)

Sideloaded Azure Bot (not Composio). Works with free/personal Teams.

**Feature flag:** Connectors shows this card only when `JOSHU_TEAMS_BOT_UI_ENABLED=true` (default **off**). Backend messaging / bind APIs still work if credentials are already configured.

1. Set `JOSHU_TEAMS_BOT_UI_ENABLED=true`, then open Connectors → **Teams bot** (`#teams-bot`).
2. Create Azure Bot (F0) + Entra app; enable Teams channel; set Messaging endpoint to the URL Joshu shows.
3. Paste App ID + client secret → Save; download the app package zip → Teams → Upload a custom app.
4. From Chat sharing, copy `bind <uuid>` into a Teams chat with the bot.

API: `GET/POST /joshu/api/share-chat/teams/setup` (includes `uiEnabled`), `GET …/teams/manifest.zip`. See [share-chat.md](share-chat.md#microsoft-teams-bot-free--personal-teams).

## Dev

```bash
npm run dev:connectors   # Vite :3009, proxies /joshu → :8788
npm run build:connectors
```

Bundled into ArozOS template by `scripts/dev-arozos.sh` and VPS Docker image.

**Build note:** Vite outputs to `dist/connectors-app/` (not `dist/connectors/` — that path is reserved for Joshu API modules from `tsc`).

## VPS provisioning

| `instance.env` key | Source | Notes |
|------------------|--------|--------|
| `COMPOSIO_API_KEY` | `DEFAULT_COMPOSIO_API_KEY` in control plane | Required for Connect tab |
| `COMPOSIO_USER_ID` | Customer slug at provision | Composio OAuth **per box**; ArozOS login unchanged |
| `NYLAS_API_KEY` | `DEFAULT_NYLAS_API_KEY` in control plane | Agent mailbox (jMail Setup / Welcome) |

If Connectors shows **NYLAS_API_KEY not configured** or Gmail accounts from another box, set keys in `/etc/joshu/instance.env` and recreate the stack — see [connectors.md](connectors.md).

## API (Composio)

Base: `/joshu/api/connectors/composio/`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `status` | `{ enabled, userId? }` |
| GET | `toolkits` | List/search providers |
| GET | `gmail/accounts` | All connected Gmail accounts |
| POST | `connect` | `{ toolkit, callbackUrl? }` → OAuth popup; callback defaults to `/joshu/oauth-done.html` (“you can close this tab”) |
| POST | `disconnect` | `{ connectedAccountId }` |
| POST | `sync` | Refresh Hermes MCP config |
| POST | `post-connect` | After OAuth: registry + seed Gmail `historyId` (no mail backfill) |

Legacy jChat paths under `/joshu/api/hermes-chat/composio/*` still work (same handlers).

## Multi-Gmail (and multi-account OAuth)

1. Open **Connect apps** and connect Gmail (or Google Calendar, Drive, etc.) via Composio OAuth.
2. Use **Connect another account** on the same provider row for additional inboxes or Google identities.
3. Each Gmail account mirrors to `connectors/mail/gmail/{account_key}/threads/`.
4. **jMail** shows one inbox tab per connected Gmail address.
5. **Day 0 setup** — after at least one Gmail account is connected, use **Analyze mail for setup (Day 0)** at the bottom of **Connect apps** to sync 30 days of mail + calendar and pre-fill the Welcome onboarding draft. See [`docs/day0-cold-start.md`](day0-cold-start.md).

## Owner 1:1 channel

Configure Telegram/Slack approval DMs in the **Safety** desktop app (not Connectors). Connect Slack for agent tools via **Connect apps** above if needed; paste the DM/channel ID in Safety.

Slack approvals use **Y/N replies** in that channel (not interactive Block Kit buttons). Approval messages show companion **avatar + name** in the message body via Block Kit. Full flow: [`agent-safety.md` — Slack approval flow](agent-safety.md#slack-approval-flow-v1).

**Hermes Slack chat** (full agent DM/@mention) is separate — configure in **Safety → Hermes Slack chat**. See [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway).

For policy tiers, bypass rules, browser gate, and the **Safety** desktop app, see [`agent-safety.md`](agent-safety.md).

## Related

- [`docs/agent-safety.md`](agent-safety.md) — write policy, HITL, hard blocks
- [`docs/safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety desktop app
- [`docs/connectors.md`](connectors.md) — mirror layout and REST API
- [`docs/day0-cold-start.md`](day0-cold-start.md) — Day 0 cold-start pipeline
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) — shortcut format
