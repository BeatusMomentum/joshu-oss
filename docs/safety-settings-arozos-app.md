# Safety (ArozOS desktop app)

**Safety** is the desktop UI for Joshu agent write policy: action guard (HITL), MCP hard blocks, owner SMS approval status, and Hermes chat tokens.

For the full security model (tiers, bypass matrix, architecture), see **[`agent-safety.md`](agent-safety.md)**.

---

## Stack

| Layer | Path |
|-------|------|
| Desktop UI | `apps/safety-settings/` → `dist/safety-settings/` → `arozos/subservice/safety-settings/app/` |
| ArozOS subservice | `arozos/subservice/safety-settings/` (`moduleInfo.json`, `start.sh`, **`.startscript`**) |
| REST API | `src/safetySettings/` → `/joshu/api/safety-settings` |
| Policy file | `.joshu/action-guard/policy.json` |
| Local secrets / toggles | `.joshu/safety-settings/local-env.json` |
| Owner channel | `.joshu/owner-channel/owner-channel.json` |

**Display name:** desktop label and `moduleInfo.json` `"Name"` are **Safety**. Subservice directory remains `safety-settings/`.

---

## Dev and build

```bash
npm run dev:safety-settings   # Vite :3010, proxies /joshu → :8788
npm run build:safety-settings
npm run dev:arozos            # builds all subservices + installs Safety.shortcut
```

Open from the ArozOS **Safety** desktop icon, or `http://127.0.0.1:8787/safety-settings/index.html` (path via subservice proxy).

---

## UI sections

### Status bar

Live summary: gate active/off, owner SMS configured, Slack chat configured, **Hermes gateway** running/stopped.

### Action guard (HITL)

| Control | Description |
|---------|-------------|
| Enable action guard | Master switch (`policy.json` / `JOSHU_ACTION_GUARD_ENABLED`) |
| Gate mode | `external_writes` (default) or `allowlist` |
| Approval timeout | 5 / 15 / 30 / 60 minutes |
| Gate browser writes | Camofox **click/type/press** when enabled (default **off**). Requires Hermes `browser_camofox.py` patch + gateway restart — see [`agent-safety.md` — Browser write gate](agent-safety.md#browser-write-gate) |
| Bypass owner-only mail | Skip gate for sends to `primaryWorkEmail` only |
| LLM classifier | Optional soft classifier for ambiguous actions + threshold |

### Owner approval (SMS)

Read-only status for Twilio owner SMS (Telephone owner mobile, or `TWILIO_OWNER_CALLER`). Approvals are sent by text; reply **Y** or **N**. See [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md) and [`telephone-arozos-app.md`](telephone-arozos-app.md).

### Hard policy

| Control | Description |
|---------|-------------|
| MCP tool policy | Tier-1 blocks: Composio Gmail send, deletes, Nylas calendar writes |
| Terminal mail guard | Block `nylas email send` / curl send bypass in Hermes terminal |

### Hermes Telegram chat

Password field for `TELEGRAM_BOT_TOKEN` (Hermes owner ↔ agent chat — separate from SMS approvals).

### Hermes Slack chat

Full agent chat in Slack (Hermes **Socket Mode**) — separate from **Composio Slack** (MCP tools). Action-guard approvals use **SMS**, not Slack. See [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway).

| Control | Description |
|---------|-------------|
| **Generate manifest** | Runs `hermes slack manifest --write`; shows JSON in the UI (companion name from `.joshu/identity.json`). Slash-command `url` fields (`hermes-agent.local`) are schema placeholders — Socket Mode ignores them. |
| **Verify tokens** | `auth.test` on `xoxb-…` + format check on `xapp-…` |
| **Slack bot token** | `SLACK_BOT_TOKEN` (`xoxb-…`, from OAuth & Permissions after install) |
| **Slack app token** | `SLACK_APP_TOKEN` (`xapp-…`, App-Level Token with `connections:write`) |
| **Allowed member IDs** | `SLACK_ALLOWED_USERS` — required (`U…`); empty allowlist blocks all messages |
| **Home channel** | Optional `SLACK_HOME_CHANNEL` (`C…` / `D…`) for cron / proactive delivery |
| **Allowed channels** | Optional `SLACK_ALLOWED_CHANNELS` — restrict which channels accept @mentions |

On **Save**, Joshu writes `local-env.json` and syncs `SLACK_*` / `TELEGRAM_*` into `~/.hermes/.env`. When messaging fields change, Save prompts to **restart the gateway** (recommended).

### Actions

- **Save** — writes policy file, optional owner-channel `gateMode`, and local-env; optional gateway restart when messaging changed
- **Restart gateway** — sync messaging env and restart Hermes (picks up Slack/Telegram tokens)
- **Test approval** — sends a test HITL notification by SMS. Reply **Y** or **N** to approve or deny.
- **Refresh** — reload from server

---

## Source badges

Each setting shows where the effective value comes from:

| Badge | Meaning |
|-------|---------|
| **.env** | Locked — set in process environment |
| **saved here** | `.joshu/safety-settings/local-env.json` |
| **policy file** | `.joshu/action-guard/policy.json` |
| **default** | Built-in default |

---

## Settings map

| UI control | Env var (if set) | Persisted to |
|------------|------------------|--------------|
| Enable action guard | `JOSHU_ACTION_GUARD_ENABLED` | `policy.json` |
| Gate mode | `JOSHU_ACTION_GUARD_GATE_MODE` | `policy.json` + owner channel |
| Browser gate | `JOSHU_ACTION_GUARD_BROWSER_GATE` | `policy.json` |
| LLM classifier | `JOSHU_ACTION_GUARD_LLM` | `policy.json` |
| Approval timeout | `JOSHU_ACTION_GUARD_TIMEOUT_MS` | `policy.json` |
| MCP hard policy | `JOSHU_MCP_TOOL_POLICY_ENABLED` | `policy.json` `mcpToolPolicyEnabled` |
| Terminal mail guard | `JOSHU_TERMINAL_MAIL_GUARD` | `local-env.json` |
| Owner SMS | Telephone **Your mobile** (or `TWILIO_OWNER_CALLER`) + Twilio account/number/webhook | `.joshu/telephone/settings.json` then `instance.env` |
| Hermes chat bot | `TELEGRAM_BOT_TOKEN` | `local-env.json` |
| Hermes Slack bot / app tokens | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `local-env.json` |
| Slack allowed users / channels | `SLACK_ALLOWED_USERS`, `SLACK_HOME_CHANNEL`, `SLACK_ALLOWED_CHANNELS` | `local-env.json` |

---

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/joshu/api/safety-settings` | GET | Current settings + source badges |
| `/joshu/api/safety-settings` | PUT | Update policy, secrets; optional `restartGateway: true` |
| `/joshu/api/safety-settings/restart-gateway` | POST | Sync `~/.hermes/.env` messaging vars and restart Hermes gateway |
| `/joshu/api/safety-settings/slack-setup` | GET | Slack setup steps + configured flags |
| `/joshu/api/safety-settings/slack-manifest` | POST | Generate Hermes Slack app manifest JSON |
| `/joshu/api/safety-settings/slack-verify` | POST | Verify `xoxb` / `xapp` tokens |
| `/joshu/api/safety-settings/test-approval` | POST | Send test approval notification |
| `/joshu/api/hermes/gateway` | GET | Gateway running / auto-start status |

Implementation: [`src/safetySettings/store.ts`](../src/safetySettings/store.ts), [`src/safetySettings/routes.ts`](../src/safetySettings/routes.ts).

---

## Apply vs restart

| Change | Takes effect |
|--------|----------------|
| Gate mode, timeouts, MCP policy toggle | Immediately for Joshu + MCP proxies on next policy fetch |
| **Browser gate** (`browserGateWrites`) | Joshu immediately; Hermes after gateway restart (`JOSHU_ACTION_GUARD_BROWSER_GATE` synced to `~/.hermes/.env`) |
| Approval SMS | Immediate when Twilio owner SMS is configured |
| `TELEGRAM_BOT_TOKEN`, `SLACK_*`, `JOSHU_TERMINAL_MAIL_GUARD` (local-env) | After Hermes gateway restart (**Safety → Restart gateway**, or confirm on Save when messaging changed) |
| Values in `.env` | After process restart |

Save syncs messaging env to `~/.hermes/.env` immediately; the running gateway process must restart to load new Slack/Telegram tokens.

---

## Troubleshooting

### Desktop icon does nothing

ArozOS static subservices require **`.startscript`** in `arozos/subservice/safety-settings/` so boot uses `start.sh` instead of looking for a missing binary.

1. Confirm `arozos/subservice/safety-settings/.startscript` exists
2. Restart `npm run dev:arozos`
3. Look for log line: `[joshu-safety-settings] serving …/safety-settings/app on 127.0.0.1:…`

### API errors in the app

Joshu must be running on `:8788`. In dev, Vite proxies `/joshu` to the API.

### Test approval fails

Owner SMS must be configured (Telephone owner mobile or `TWILIO_OWNER_CALLER`, plus Twilio webhook). Check `GET /joshu/api/action-guard/status` → `smsConfigured` / `ownerChannelLinked`. Reply **Y** or **N** to the test SMS.

**Hermes Slack chat:** after Save, use **Restart gateway**; confirm `SLACK_ALLOWED_USERS` includes your `U…` ID; DM the bot or `@mention` in an invited channel. One Socket Mode connection per Slack app — do not reuse the same `xapp-` token on two boxes at once. Channel `@mentions` reply in a **thread** by default — see [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway) (`reply_in_thread: false` for in-channel replies). If nothing happens, check `~/.hermes/logs/gateway.log` for `inbound message: platform=slack` (no line ⇒ Socket Mode not receiving on this box).

**Hermes Telegram chat:** DM the **chat** bot (`TELEGRAM_BOT_TOKEN`) — that is not the approval path.

---

## Related

- Security overview: [`agent-safety.md`](agent-safety.md)
- Connectors: [`connectors-arozos-app.md`](connectors-arozos-app.md)
- Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
