---
name: joshu-browser-handoff
description: Live browser HITL — hand shared Camofox tab to owner on mobile for sensitive or owner-only steps.
metadata:
  hermes:
    category: browser
    version: "1.4.1"
---

# Joshu browser handoff (live HITL)

Use when the **owner must take over the shared Camofox tab** (`hitl-camofox` / `hitl-main`) on their phone — payment, login, 2FA, irreversible confirms, or any step that is **sensitive, policy-bound, or explicitly owner-only**.

This is **sustained live HITL**: the owner gets a signed link, embedded noVNC, your brief, and time to finish. It is **not** a single-click SMS approval (see action guard below).

**Tools:** `browser_handoff_request`, `browser_handoff_status` (Hermes plugin `joshu-browser-handoff`).

**Hard lock:** while handoff is `pending`, agent `browser_navigate` / click / type / press / back are blocked. Owner uses the handoff URL + noVNC. **`browser_snapshot` still works** for verification after completion.

---

## When to use

| Use handoff | Do not use handoff |
|-------------|-------------------|
| Payment, card entry, 3DS, bank auth | Still browsing, comparing, or gathering options |
| Site login, SSO, CAPTCHA, OTP the agent cannot complete | Owner is already at desktop jWeb and asked you to wait |
| Irreversible confirm (book, buy, submit application, cancel subscription) | Informational read-only pages |
| Sensitive form (legal attest, medical, government ID upload) | One trivial click — use action guard if enabled |
| Owner said "I'll finish this" / "send me the link" | You can safely continue autonomously |
| Task policy says **ask before paying** or **owner must approve in browser** | Desktop-only flow with no need to preserve this tab session |

**Rule of thumb:** if the **next meaningful browser actions belong to the owner** (credentials, money, or binding consent), stage the page and hand off. If you only need a one-time Y/N on a single agent click, action guard may suffice instead.

### Account-specific web data (Amazon orders, bank, portals)

**Use the browser + handoff** — not Composio/Gmail search alone — when the answer lives behind the owner's login:

| Ask | Wrong first move | Right move |
|-----|------------------|------------|
| "My most recent Amazon order" | Gmail order-confirmation search only | `browser_navigate` → Amazon sign-in/orders → `browser_handoff_request` → send link |
| "What's in my cart?" | Guess or stale snapshot | Hand off on cart or login page |
| "Did my refund post?" | Mail thread only | Browser account order history after owner login |

Gmail may help **after** the fact (confirmation emails), but it is not a substitute for an authenticated Amazon session.

### SMS / owner texted you

When the channel is **SMS**, still **`browser_handoff_request`** and **include the full handoff URL** in your reply. Joshu splits long texts across multiple SMS — do not omit the link to stay under 500 characters.

**After handoff on SMS:** `browser_snapshot`, then put the answer in your **assistant reply text** (order details, confirmation, etc.). Joshu sends that as SMS automatically.

**Never** call `nylas_send_message` or email the owner to deliver SMS-originated handoff results — that triggers action-guard approval and skips the SMS reply path.

---

## Workflow

1. **Do prep work autonomously** — search, compare, fill non-sensitive fields, verify constraints in **`browser_snapshot`** (dates, price, terms, correct account, etc.).
2. **`browser_navigate`** to the page where the owner should start (review screen, login, payment step — whatever you are handing off).
3. **`browser_snapshot`** — confirm the staged state matches what you will describe in the brief.
4. **`browser_handoff_request(instructions=…)`** — short owner brief: what site, what to check, what to do, any caps or policies. Examples:
   - *"Review Chicago hotel Fri–Sat, under $250/night, free cancellation — pay when ready."*
   - *"Log into the airline account and complete 2FA — I'll continue after you're in."*
   - *"Confirm the subscription cancellation on this page — only proceed if the refund amount matches $49."*
5. Include the returned **`url`** in your outbound message (email, jChat, or SMS). On SMS, always send the link — splitting is automatic.
6. **`kanban_block("awaiting owner browser handoff")`** (or equivalent wait state).
7. Poll **`browser_handoff_status(handoff_id=…)`** until `status` is `completed` (or handle `expired` / `cancelled`).
8. **`browser_snapshot`** — verify the outcome (confirmation page, logged-in state, success message).
9. **Deliver results on the same channel** — SMS → assistant reply text only; email/jChat → normal outbound for that channel. **Not** `nylas_send_message` after SMS handoff.
10. **`kanban_complete`** or continue the task.

---

## Handoff vs action guard

| | **Browser handoff** | **Action guard (SMS Y/N)** |
|--|---------------------|----------------------------|
| **Best for** | Owner drives the browser for a while | Agent proposes one write; owner approves/denies |
| **Owner UI** | Mobile link + noVNC + instructions | SMS reply Y/N |
| **Agent during wait** | Locked out of navigate/click/type | Can still navigate; only gated writes blocked |
| **Session** | Pins current tab URL until done | No session pin |

Use **handoff** for live owner browser work. Use **action guard** for "may I click Send / Pay?" when the agent stays in control.

---

## Warm browser before heavy navigation

Same as [ea-scheduling](../executive-assistant/ea-scheduling/SKILL.md): if Camofox was idle, **`browser_navigate`** may cold-start the browser. Prefer one navigation to the target; avoid redundant navigations that fight the shared tab.

During **pending handoff**, do **not** navigate away — the server pins `pageUrl` and blocks agent writes.

---

## Owner experience

Owner opens the handoff link on their phone → **signs in with the box username and password** (a desktop session is not enough) → compact Joshu header + embedded noVNC → types in native fields (**Fill** enables after an edit) or **More Options** for scan/paste → **I'm done** (bottom right).

If desktop jWeb/noVNC is also connected, only one viewer may hold the session — ask the owner to close desktop jWeb if the phone viewer disconnects.

---

## Errors

| Signal | Action |
|--------|--------|
| `browser_handoff_already_pending` | Poll existing handoff or `browser_handoff_status`; do not create a second request |
| `browser_handoff_locked` on navigate/click | Wait for owner completion |
| `expired` | Re-stage the page and mint a new link, or ask the owner to retry |
| `no_active_browser_tab` | Navigate to the handoff page first, then request handoff |

---

## Related

- HITL Camofox notes: [`docs/hitl-camofox-notes.md`](../../../../docs/hitl-camofox-notes.md)
- Action guard (single-click HITL): [`docs/agent-safety.md`](../../../../docs/agent-safety.md)
