# Agent safety (write policy, HITL, owner channel)

Joshu owns **agent write safety** end-to-end. Composio is OAuth and transport; Hermes is the agent runtime. All enforcement lives in Joshu code, MCP proxies, and REST gates — not in Composio SDK modifiers alone.

**Related docs**

| Topic | Doc |
|-------|-----|
| Safety desktop app (configure policy in UI) | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| Safety UI (owner channel, policy) | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| Mail/calendar MCP + cron | [`connectors.md`](connectors.md) |
| Browser HITL (Camofox / noVNC) | [`hitl-camofox-notes.md`](hitl-camofox-notes.md) |

---

## Design principle

1. **Joshu decides** what is blocked, gated, or allowed — deterministically where possible.
2. **Owner channel** is notification + approve/deny ingress only; it does not replace policy.
3. **One HITL gate** — every gated path (`awaitOwnerApproval` in [`gate.ts`](../src/actionGuard/gate.ts)) shares one pending store and one resolve path. Inbound SMS Y/N replies via [`smsIngress.ts`](../src/actionGuard/smsIngress.ts) call `resolvePending` — not separate safety systems.
4. **Same gate for every agent path** — Hermes MCP, `execute_code`, `curl`, browser writes, and Composio SDK calls that hit Joshu should converge on the same rules.
5. **Owner human UI bypasses** — jMail compose and owner browser sessions (jWeb / noVNC) are not agent paths.

---

## Three enforcement tiers

| Tier | When | Owner sees | Agent sees on block/deny |
|------|------|------------|--------------------------|
| **1 — Hard block** | Always-on policy (`mcpToolPolicy`) | Nothing (tool never listed or explicit error) | Error: use Nylas send / no delete / no Nylas calendar write |
| **2 — HITL (action guard)** | Enabled + owner SMS configured (Telephone mobile or `TWILIO_OWNER_CALLER`) | Approve / Deny by SMS (reply Y/N) | Success-shaped stub (no side effect) or timeout stub |
| **3 — Soft deny (LLM classifier)** | Optional; ambiguous actions only | Same as tier 2 if escalated to HITL | Classifier may skip gate when below threshold |

Hard blocks run **before** HITL. Example: Composio `GMAIL_SEND_EMAIL` is hard-blocked by MCP policy — it never reaches the approval flow. Agent mail must use `nylas_send_message` (tier 2 when guard is on).

---

## Architecture

```mermaid
flowchart TB
  subgraph agent [Hermes agent]
    MCP[MCP tool calls]
    Term[terminal / execute_code]
    Browser[browser click/type]
  end

  subgraph proxies [Local MCP proxies]
    Conn[Connectors MCP :8795]
    CompGuard[Composio guard :8796]
  end

  subgraph joshu [Joshu API :8788]
    Hard[mcpToolPolicy]
    Gate[actionGuard / ownerChannel]
    REST[Nylas REST gates]
  end

  subgraph owner [Owner]
    SMS[Owner SMS]
  end

  MCP --> Conn
  MCP --> CompGuard
  Conn --> Hard
  Conn --> REST
  CompGuard --> Hard
  CompGuard --> Gate
  REST --> Gate
  Term --> REST
  Browser --> Gate
  Gate --> SMS
  SMS --> Gate
  Gate -->|approved| REST
  CompGuard -->|approved| ComposioCloud[Composio cloud]
```

| Layer | Port | Role |
|-------|------|------|
| Connectors MCP | `:8795` | Joshu connectors tools; `nylas_send_message` → REST (gate on API) |
| Composio MCP guard | `:8796` | Pass-through to Composio cloud; write tools → `POST …/owner-channel/await` |
| Joshu API | `:8788` | Policy, owner channel, Nylas send gate, webhooks |

When action guard is enabled, Hermes `mcp_servers.composio.url` points at `http://127.0.0.1:8796/mcp`, not Composio cloud directly.

**Code map**

| Area | Path |
|------|------|
| Hard MCP policy | [`src/mcpToolPolicy.ts`](../src/mcpToolPolicy.ts) |
| Action guard core | [`src/actionGuard/`](../src/actionGuard/) |
| Owner 1:1 channel | [`src/ownerChannel/`](../src/ownerChannel/) |
| Composio SDK modifier (direct execute paths) | [`src/composio/modifiers/ownerChannelBeforeExecute.ts`](../src/composio/modifiers/ownerChannelBeforeExecute.ts) |
| Composio MCP guard proxy | [`scripts/composio-mcp-guard-proxy.mjs`](../scripts/composio-mcp-guard-proxy.mjs) |
| Connectors MCP | [`scripts/joshu-connectors-mcp-http-server.mjs`](../scripts/joshu-connectors-mcp-http-server.mjs) |
| Terminal mail bypass block | [`scripts/patch-hermes-terminal-mail-guard.mjs`](../scripts/patch-hermes-terminal-mail-guard.mjs) |
| Browser write gate (Hermes) | [`scripts/patch-hermes-camofox-action-guard.mjs`](../scripts/patch-hermes-camofox-action-guard.mjs) → `POST …/api/action-guard/browser` |
| Browser gate logic | [`src/actionGuard/browserGate.ts`](../src/actionGuard/browserGate.ts) |
| SMS approval ingress | [`src/actionGuard/smsIngress.ts`](../src/actionGuard/smsIngress.ts) (via [`twilioSmsGateway.ts`](../src/twilioSmsGateway.ts)) |
| Approval reply parse | [`src/actionGuard/approvalReply.ts`](../src/actionGuard/approvalReply.ts) — short Y/N/`ok` only |
| SMS send (GSM fold + 640-char cap) | [`src/twilioSmsSend.ts`](../src/twilioSmsSend.ts) |
| Safety settings API + UI | [`src/safetySettings/`](../src/safetySettings/), [`apps/safety-settings/`](../apps/safety-settings/) |

---

## Tier 1 — MCP tool policy (hard blocks)

Default **on** when unset. Enforced in Composio guard proxy, Connectors MCP, and Joshu REST (defense in depth).

| Rule | Blocked | Use instead |
|------|---------|-------------|
| Outbound mail via Composio Gmail | `GMAIL_SEND_*`, `GMAIL_REPLY_*`, send heuristics | `mcp_joshu_connectors_nylas_send_message` |
| Nylas calendar writes | `nylas_create_event`, `nylas_update_event`, `nylas_delete_event` | Composio `GOOGLECALENDAR_CREATE_EVENT` |
| Deletes | Composio tools matching `DELETE` / `TRASH` | — (not available to agents) |

Blocked tools are removed from `listTools` where the proxy supports it. Owner **jMail** Gmail send still works (`X-Joshu-Mail-Client: jmail` + same-origin browser).

**Configure:** `JOSHU_MCP_TOOL_POLICY_ENABLED` or **Safety** app → Hard policy → MCP tool policy → writes `mcpToolPolicyEnabled` in `.joshu/action-guard/policy.json`.

API: `GET /joshu/api/mcp-tool-policy`

---

## Tier 2 — Action guard (HITL)

Before an **agent write** that affects third parties, Joshu texts the owner on **SMS** (Telephone owner mobile, or `TWILIO_OWNER_CALLER`) with a Y/N approval prompt. Deny and timeout return **success-shaped stubs** so the agent does not retry blindly; no write occurs.

### Gate modes

| Mode | Behavior |
|------|----------|
| **`external_writes`** (default) | Gates Composio write heuristics (`_SEND_`, `_CREATE_`, `_UPDATE_`, `_POST_`, `_REPLY_`), `nylas_send_message`, and browser writes when enabled |
| **`allowlist`** | Skips write heuristics; only actions in `guardedActions` (default includes Nylas send + Gmail send ids — Gmail send is hard-blocked anyway) |

### What is gated vs not

| Path | Gated? |
|------|--------|
| `mcp_joshu_connectors_nylas_send_message` → REST | **Yes** |
| `execute_code` / `curl` → `POST …/nylas/messages/send` | **Yes** (same REST gate) |
| Composio proxy → `GOOGLECALENDAR_CREATE_EVENT`, `SLACK_SEND_MESSAGE`, etc. | **Yes** (`external_writes`) |
| Composio `GMAIL_SEND_EMAIL` | **Hard-blocked** (tier 1) |
| Composio read/meta tools (`COMPOSIO_SEARCH_TOOLS`, list/read) | **No** |
| jMail owner compose | **No** |
| Mail to owner `primaryWorkEmail` only | **No** when `bypassOwnerOnlyRecipients: true` (default) |
| External mail (counterparty recipients) | **Auto-CC** owner primary work email (API-enforced); approval SMS warns when owner was not on prior thread messages |
| Browser click/type/press | **Yes** when `browserGateWrites: true` (default **off**) |
| Browser navigate/scroll/snapshot | **No** |
| Browser evaluate/submit | Classified as writes; Hermes patch does not hook them yet |

### Browser write gate

When **`browserGateWrites: true`** (Safety app → **Gate browser writes**, or `JOSHU_ACTION_GUARD_BROWSER_GATE=true`), Hermes Camofox **click**, **type**, and **press** call Joshu before executing:

```text
camofox_click / camofox_type / camofox_press
  → POST /joshu/api/action-guard/browser
  → gateBrowserWriteRequest → awaitOwnerApproval (same HITL as mail)
```

**Requirements (all):** action guard enabled, owner channel linked, browser gate on, Hermes `browser_camofox.py` patched (`scripts/apply-hermes-hitl-patch.sh` applies `patch-hermes-camofox-action-guard.mjs`), gateway restarted so `JOSHU_ACTION_GUARD_BROWSER_GATE=true` is in `~/.hermes/.env` (synced from policy on gateway boot).

**Scheduling links:** confirming a Calendly/Google booking is a **`browser:click`** — gated when browser gate is on.

**Not gated:** owner clicking in jWeb/noVNC; agent **navigate** to open a scheduling page (only the confirm click is gated).

### Browser handoff lock (owner mobile checkout)

Separate from the optional browser **action guard**. When `browser_handoff_request` creates a **pending** handoff, Joshu pauses the browser-use sidecar and **refuses `browser_task`** until the owner completes via the signed handoff URL or the handoff is cancelled. On an SMS-originated realtime goal the owner does not get that URL from the worker’s chat reply. They get the Kanban completion, after [`formatOwnerCompletion`](../src/realtimeGoals/ownerDelivery.ts) appends the pending handoff link if the summary never pasted it. See [channel delivery](realtime-goals.md#channel-delivery). **I'm done** completes the handoff and starts an SMS continuation. If the worker minted the record without `hermesSessionKey`, that continuation uses the owner phone from Telephone settings. The form overlay includes shadow-DOM fields whose host is visible, including Alaska's 1×0 inputs, and writes the custom element's `value`. On the shared Chromium the built-in tool lock is still in `browser_tool.py` if that toolset is loaded. On the Camofox HTTP fallback it is in `browser_camofox.py`. Form fill and screencast clicks stay available to the owner while the agent is paused.

| Path | Role |
|------|------|
| [`src/browserHandoff/`](../src/browserHandoff/) | Pending record, HMAC URL tokens, lock API |
| Hermes `patch-hermes-camofox-handoff-lock.mjs` | Pre-flight `GET /api/browser-handoff/lock` in `browser_camofox.py` (Camofox HTTP fallback) |
| Hermes `patch-hermes-browser-cdp-guards.mjs` | Same lock, plus the browser write gate, in `tools/browser_tool.py` after the Camofox early-return. This is the path when `BROWSER_CDP_URL` is set. `browser_snapshot` is left unlocked. |
| [`src/actionGuard/browserGate.ts`](../src/actionGuard/browserGate.ts) | Also returns `browser_handoff_locked` stub before action-guard HITL |

**Allowed during lock:** `browser_handoff_status`, the owner's screencast clicks, and the form overlay (`fill-form`, paste). `browser_task` is refused. `browser_snapshot` still works if the built-in browser toolset is loaded.

**Fail-open:** if Hermes cannot reach the lock endpoint, the handoff patch logs and allows the write (same as action guard).

**Fail-open:** if Hermes cannot reach Joshu (`POST …/browser` errors), the patch logs a warning and allows the write (same pattern as other Hermes guards).

**Deny/timeout:** Hermes receives a success-shaped browser stub; no click/type/press occurs.

### Owner visibility on external mail

Joshu enforces that the owner stays visible on counterparty mail:

1. **Auto-CC** — `POST …/nylas/messages/send` appends the owner's **primary work email** to `cc` on any send that includes external recipients (not owner-only, not agent-only). jMail owner compose bypasses this path.
2. **Ingress flag** — mail ingress tasks include `owner_on_thread: true|false` from the thread mirror. When `false`, agents should summarize the counterparty ask in the first external reply.
3. **Action-guard SMS** — when `ownerOnThread: false`, the approval message includes a note and a short context snippet from the latest non-agent message on the thread.

This is **soft policy** (no hard 403 block). Action guard remains the approval gate.

### Enable conditions

Action guard is active when **all** of:

1. `enabled: true` (`JOSHU_ACTION_GUARD_ENABLED` or `policy.json`)
2. Owner SMS configured (owner mobile in **Telephone** / Welcome, or `TWILIO_OWNER_CALLER`, plus Twilio account/number/webhook — `twilioSmsGatewayEnabled()`)

If guard is enabled but SMS is not configured, agent sends return **503** `owner_channel_sms_not_configured` (Joshu stays up).

### MCP timeout vs approval wait

REST and proxy calls **block synchronously** until approve, deny, or policy timeout (default **30 minutes**). Hermes MCP per-tool timeout (~120s) can expire first — workers should `kanban_block(reason="awaiting owner approval")` rather than treat as MCP outage. See [`connectors.md` — Action guard timeout](connectors.md#action-guard--mcp-tool-timeout-vs-approval-wait-2026-06-23).

### Audit

Owner-only audit log: `.joshu/action-guard/audit.jsonl`  
Status: `GET /joshu/api/action-guard/status`

---

## Owner approval (SMS)

Action-guard write approvals use **owner SMS only** — the same Twilio gateway as owner ↔ Joshu chat.

The owner mobile is captured on the box:

1. **Telephone** → Your mobile (`.joshu/telephone/settings.json` `ownerCaller`)
2. **Welcome** Schedule & email (same file on complete)
3. Fallback: `TWILIO_OWNER_CALLER` in `instance.env` (ops `rotate_secrets`)

| Step | Behavior |
|------|----------|
| Notify | `notifyOwnerForApproval` sends a plain-text SMS summary + “Reply Y to approve or N to deny” |
| Ingress | Inbound SMS on `/api/twilio/sms/inbound` → `handleSmsApprovalIngress` before Hermes chat routing |
| Resolve | Short Y/N (also `yes`/`no`/`ok`/`approve`/`deny`) → `resolvePending` on the newest open pending. Conversational SMS starting with “Ok …” / “Yes …” is **not** an approval. If nothing is pending, the message falls through to Hermes chat. |

**Configure:** Twilio subaccount vars on the box — see [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md). Enable action guard in **Safety** or `JOSHU_ACTION_GUARD_ENABLED=1`. Test: **Safety → Test approval** — reply Y or N by SMS. Parser tests: `npm run test:sms-send`.

Approval and chat SMS share [`sendSms`](../src/twilioSmsSend.ts): Unicode is folded to GSM-7 and bodies are capped at **640 characters** so US carriers do not drop the message (Twilio **30019**).

**Not Hermes Slack/Telegram chat:** those remain separate agent chat surfaces in **Safety → Hermes Slack chat** / `TELEGRAM_BOT_TOKEN` ([hermes-integration](hermes-integration.md)).

**Storage:** optional `.joshu/owner-channel/owner-channel.json` for `gateMode` override only. Owner mobile lives in Telephone settings (then `TWILIO_OWNER_CALLER`).

**Slack / Telegram integrations (agent tools & chat — not action guard)**

| Integration | Config | Purpose |
|-------------|--------|---------|
| Composio Slack | Connectors OAuth (`slack`) | Agent MCP tools (`SLACK_SEND_MESSAGE`, …) |
| Hermes Slack chat | Safety → `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Full agent chat (Socket Mode) |
| Hermes Telegram chat | Safety → `TELEGRAM_BOT_TOKEN` | Owner ↔ agent chat |
| Share-chat Slackbot | Connectors toolkit **`slackbot`** | KB-scoped channel Q&A ([share-chat.md](share-chat.md)) |

---

## Terminal mail guard

Hermes `terminal` could bypass REST by calling `nylas email send` or `curl …/api/nylas/messages/send` directly.

**Fix:** `scripts/patch-hermes-terminal-mail-guard.mjs` patches Hermes `terminal_tool.py` to hard-block known mail-send shell patterns. Default **on** (`JOSHU_TERMINAL_MAIL_GUARD=1`).

**Configure:** **Safety** app → Terminal mail guard, or env / `.joshu/safety-settings/local-env.json`. Hermes reads the value on gateway dotenv sync (restart gateway after change).

---

## Composio SDK paths (beforeExecute)

Hermes normally uses the **:8796 MCP guard proxy**. Joshu REST routes that call Composio `tools.execute` directly (e.g. some connector helpers) use [`ownerChannelBeforeExecute`](../src/composio/modifiers/ownerChannelBeforeExecute.ts):

1. Hard block via `mcpToolPolicy`
2. If action-guarded → `awaitOwnerApproval`
3. On deny/timeout → throw (no execute)

This keeps SDK and MCP paths aligned without relying on Composio-hosted modifiers.

---

## Bypass defense matrix

| Vector | Mitigation | Residual risk |
|--------|------------|---------------|
| Hermes → connectors MCP → Nylas send | REST gate | — |
| Hermes → Composio MCP → writes | Guard proxy + owner channel | — |
| `execute_code` / `curl` → Joshu Nylas send | REST gate | — |
| Hermes `terminal` → `nylas email send` | Terminal mail guard patch | Custom/obfuscated shell |
| `execute_code` / `curl` → arbitrary external URL | Not gated by Joshu | Egress allowlist (out of scope v1) |
| Hermes `mcp_servers` **stdio** (`command` / `args`) | Stripped on gateway sync (`hermesMcpAllowlist.ts`) | Extra **HTTP** MCPs still allowed |
| Public Hermes Admin without basic auth | Caddy omits `hermes-admin` vhost; dashboard does not start | **Password in `instance.env` ≠ live lock** — unauth curl must be **401**. Stale host compose can still publish the vhost |
| Composio Gmail send | Hard MCP policy | — |
| Agent delete/trash | Hard MCP policy | — |
| Hermes browser click/type/press | Browser gate + owner channel when `browserGateWrites` | navigate-only; evaluate/submit unhooked; Hermes fail-open if Joshu unreachable |
| jMail owner UI | Client header + same-origin bypass | By design |
| Owner-only recipient mail | `bypassOwnerOnlyRecipients` | By design |

---

## Configuration reference

### Environment variables

| Variable | Purpose |
|----------|---------|
| `JOSHU_MCP_TOOL_POLICY_ENABLED` | Tier 1 hard blocks (default on) |
| `JOSHU_ACTION_GUARD_ENABLED` | Tier 2 master switch |
| `JOSHU_ACTION_GUARD_GATE_MODE` | `external_writes` \| `allowlist` |
| `JOSHU_ACTION_GUARD_BROWSER_GATE` | Gate Camofox writes |
| `JOSHU_ACTION_GUARD_LLM` | Soft classifier for ambiguous actions |
| `JOSHU_ACTION_GUARD_TIMEOUT_MS` | Approval wait (default 30m) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_SMS_WEBHOOK_URL` | Twilio SMS gateway — see managed fleet A2P runbook (not in OSS) |
| `TWILIO_OWNER_CALLER` | Optional env fallback for owner mobile (Telephone / Welcome preferred) |
| `JOSHU_TERMINAL_MAIL_GUARD` | Terminal mail bypass block (default on) |
| `TELEGRAM_BOT_TOKEN` | Hermes chat bot (separate from action guard) |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Hermes Slack chat (Socket Mode) |
| `SLACK_ALLOWED_USERS` | Required allowlist of Slack member IDs (`U…`) for Hermes chat |
| `SLACK_HOME_CHANNEL`, `SLACK_ALLOWED_CHANNELS` | Optional Hermes Slack routing |
| `JOSHU_COMPOSIO_MCP_GUARD_PORT` | Guard proxy port (default 8796) |
| `JOSHU_HERMES_DASHBOARD_PASSWORD` | Caddy basic auth for `hermes-admin.*`; empty → vhost and dashboard stay off |

See [`.env.example`](../.env.example) for full list.

### On-disk files

| File | Contents |
|------|----------|
| `.joshu/action-guard/policy.json` | Gate mode, timeouts, browser gate, LLM, MCP policy toggle |
| `.joshu/owner-channel/owner-channel.json` | Optional `gateMode` override (`provider` is always `sms`) |
| `.joshu/safety-settings/local-env.json` | Hermes Slack/Telegram chat tokens, terminal guard when not in `.env` |
| `.joshu/action-guard/audit.jsonl` | Approval audit trail |

**Precedence:** process `.env` overrides UI for keys present at boot. Policy file merges with env for non-env-locked fields.

### REST API summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/joshu/api/safety-settings` | GET/PUT | Read/write all safety settings (Safety app); PUT accepts `restartGateway: true` |
| `/joshu/api/safety-settings/restart-gateway` | POST | Sync messaging env and restart Hermes gateway |
| `/joshu/api/safety-settings/slack-setup` | GET | Hermes Slack setup steps + status |
| `/joshu/api/safety-settings/slack-manifest` | POST | Generate Hermes Slack app manifest |
| `/joshu/api/safety-settings/slack-verify` | POST | Verify Slack bot/app tokens |
| `/joshu/api/safety-settings/test-approval` | POST | Send test approval SMS |
| `/joshu/api/action-guard/status` | GET | Guard + SMS owner-channel status |
| `/joshu/api/connectors/owner-channel` | GET/PUT | Owner channel status (`provider: sms`) |
| `/joshu/api/owner-channel/await` | POST | Internal: MCP proxy approval wait |
| `/joshu/api/action-guard/browser` | POST | Internal: Hermes Camofox write gate |
| `/joshu/api/mcp-tool-policy` | GET | Hard policy snapshot for proxies |

---

## Safety desktop app

The **Safety** ArozOS app is the operator UI for tiers 1–2 and SMS approval status. Full detail: [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md).

Quick start:

```bash
npm run dev:arozos          # builds app + installs desktop shortcut
# or
npm run dev:safety-settings # Vite only on :3010
```

**Troubleshooting:** If the desktop icon does nothing, ensure `arozos/subservice/safety-settings/.startscript` exists and restart `dev:arozos` (ArozOS loads subservices at boot). You should see `[joshu-safety-settings] serving …` in logs.

---

## Operational checklist

1. Enable action guard in **Safety** or env; set owner mobile in **Telephone** (or `TWILIO_OWNER_CALLER`) and Twilio SMS.
2. **Test:** Safety → Test approval — reply Y or N by SMS.
3. Confirm: `curl -fsS http://127.0.0.1:8788/joshu/api/action-guard/status | jq .` → `ownerChannelLinked: true`, `smsConfigured: true`.
4. **Browser writes (optional):** enable **Gate browser writes** in Safety; run `scripts/apply-hermes-hitl-patch.sh`; restart Hermes gateway.
5. Verify Composio guard: Hermes config `mcp_servers.composio.url` → `http://127.0.0.1:8796/mcp`.
6. After policy/browser-gate/messaging changes affecting Hermes: **Safety → Restart gateway**, or `GET …/hermes-chat/status?after_mcp_boot=1` on VPS.

---

## Hermes Admin incident (2026-09)

Fleet incident: **unauthenticated public Hermes Admin** let an attacker add a **stdio MCP dropper** (`lab-beacon-*`) that mined XMR and could read secrets via the dashboard **`env/reveal`** API. Full operator timeline: [troubleshooting — Hermes Admin unauthenticated](vps-sandbox/troubleshooting-and-lessons.md#hermes-admin-unauthenticated-stdio-mcp-miner).

### Attack surface (now mitigated in code)

| Vector | What happened | Mitigation (2026-09-07+) |
|--------|---------------|---------------------------|
| Public `hermes-admin.*` with **empty** `JOSHU_HERMES_DASHBOARD_PASSWORD` | Caddy published the vhost; `header_up Host 127.0.0.1:9119` bypasses Hermes DNS-rebind check | No vhost without bcrypt password; dashboard does not start |
| **Password set, Caddyfile still unauth** (Clara 2026-09-16) | Host compose bind-mounted an **Aug 14** `Caddyfile` with **no `basicauth`**. Health `0.1.44` and `JOSHU_HERMES_DASHBOARD_PASSWORD` did not re-render the edge. Unauth stayed **200** | Current compose uses `caddy-entrypoint.sh` (render from `instance.env` on every start). Recreate Caddy only after the **caddy service** has that entrypoint. Source of truth: unauth **401** |
| **`hermes mcp add --command python3`** (stdio) | RCE + persistence via crontab; miner under `/usr_*vt/…/dns-filter` | **`hermesMcpAllowlist.ts`** strips unknown stdio MCPs on every gateway sync; test: `npm run test:hermes-mcp-allowlist` |
| Dashboard **MCP form** + in-memory registry | Cleaning `config.yaml` alone was insufficient — dashboard respawned the server | Remove MCP from config **and** restart gateway **and** dashboard |
| Dashboard **`env/reveal`** | Leaked OpenRouter, Exa, `API_SERVER_KEY`, Slack tokens, Telegram allow-list | Rotate vendor keys; regenerate Slack at api.slack.com (not CP-mintable) |

### Compromise vs exposure (Sep 2026 fleet scan)

| Status | Boxes |
|--------|--------|
| **Confirmed malware** (miner or `lab-beacon` in logs) | **Patrick**, **Clara** (Clara **reinfected 2026-09-15** via `/etc/.dd` crontab after the Sep 7 config cleanup) |
| **Exposed** (unauth admin HTTP 200, empty dashboard password; rotate keys as precaution) | Gideon, Tess, Finn, Mina, Joe, Kaelen, Joshua, Cleo, Alex, Debra |
| **Fleet re-scan 2026-09-16** | All **11** live boxes unauth **401**, no live miner. Clara was the only **old Caddy bind-mount** — patched to `caddy-entrypoint` that night |
| **Not this campaign** | Owner HTTP MCP **`known_quantity`** (legitimate) |

Best marker on Patrick: dashboard logout **2026-09-06 09:52Z** from **`149.102.245.71`** (Datacamp VPN). Treat that IP as hostile unless confirmed otherwise.

### Post-incident checklist (existing fleet box)

1. **Lock admin:** password in `instance.env` is not enough. Unauth `https://hermes-admin.<slug>.<suffix>/` must return **401**. Caddy must use **`caddy-entrypoint.sh`** (not a static `./Caddyfile` bind). Recreate **Caddy** after that compose change.
2. **Contain MCP/miner:** strip stdio extras; kill miner; remove `/usr_bwvt`, `/usr_npvf`, `/etc/.dd` **and** root crontab (`*/45 … cron-fetch`). **Reboot is not enough** — dropper files live in the container writable layer; **`--force-recreate joshu-stack`**. Restart **gateway and dashboard**. Keep `config.yaml.bak-malware-*` — do not restore. Do **not** `POST /joshu/api/hermes/reset` while a dropper is live (Clara: load 5 → 172).
3. **Rotate secrets:** OpenRouter, Exa, `API_SERVER_KEY` / `HERMES_API_KEY` / `JOSHU_READ_API_KEY` via control-plane `scripts/rotate-exposed-vendor-keys.ts` **after** a full `sync-dist-from-image.sh`. **Slack:** regenerate bot + app tokens in Slack app settings → Safety or `~/.hermes/.env`.
4. **Verify allowlist:** after gateway sync, `mcp_servers` in `config.yaml` must have **no** `command`/`args` stdio entries except Joshu-managed servers.
5. **Dist integrity:** after `rotate_secrets` or `--force-recreate joshu-stack`, host **`/opt/joshu/dist/` must match the release image** — never hotpatch a single `dist/*.js` without syncing the full tree ([hotpatch-running-box.md](vps-sandbox/hotpatch-running-box.md#dist-atomicity-after-secret-rotation-or-recreate)).
6. **Re-scan the fleet** after any Clara-class incident: unauth 401 on every `hermes-admin`, Caddy entrypoint contains `caddy-entrypoint`, no `/etc/.dd`, no stdio MCP. See [troubleshooting](vps-sandbox/troubleshooting-and-lessons.md#hermes-admin-unauthenticated-stdio-mcp-miner).

### Provision hardening (control plane)

New boxes: CP mints **`JOSHU_HERMES_DASHBOARD_PASSWORD`** in `instance.env` (`sandboxEnv.ts`). See [zero-touch-provisioning.md](https://github.com/db-aeon/joshu-control-plane/blob/main/docs/zero-touch-provisioning.md) in the control-plane repo.

---

## Out of scope (v1)

- Egress allowlist for `execute_code` / arbitrary `curl`
- Stripping extra **HTTP** MCP servers the owner added (stdio is stripped)
- Stripping API keys from shell environment
- Full owner ↔ agent chat demux on approval SMS (chat and approvals share one inbound webhook; Y/N is handled first)
- Composio-hosted `beforeExecute` modifiers (Joshu-owned only)
- Slack Events API / thread replies for approvals (SMS only for HITL)
- Slack Block Kit interactive **buttons** for approvals
- Browser `evaluate` / `submit` Hermes hooks (click/type/press only)
