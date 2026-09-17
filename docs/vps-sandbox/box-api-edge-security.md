# Box API edge security (Caddy + localhost)

Joshu listens on `127.0.0.1:8788`. Caddy reverse-proxies `/joshu/*` from the public hostname, so **`req.ip === 127.0.0.1` is not a security boundary** — every public request looks local.

## Helpers (`src/httpLocalhost.ts`)

| Helper | Use for |
|--------|---------|
| `isDirectLocalhostRequest` | Cron, instance-agent, Hermes plugins, box mutate, proactive, desktop-actions, app-gui-actions |
| `isDesktopBrowserOrLocalRequest` | Browser apps via same-origin Caddy: files, CWM, AG-UI (requires `Sec-Fetch-Site: same-origin\|same-site` + Cookie + `Host === CUSTOMER_DOMAIN`) |

## Status

| Surface | Gate |
|---------|------|
| `/api/proactive/*` | Direct localhost |
| `/api/box/snap\|restore\|…` + status/snapshots | Direct localhost |
| `/api/instance/send-owner-email`, `sync-companion-identity` | Direct localhost |
| `/api/desktop-actions/*`, `/api/app-gui-actions/*` | Direct localhost |
| `/api/browser-handoff/request`, `/status/*`, `/lock`, `/:id/cancel` | Direct localhost (Hermes plugin + Camofox lock patch) |
| `/api/browser-handoff/:id/login` | Signed handoff token; verifies box username/password against ArozOS; sets `joshu_handoff_auth` |
| `/api/browser-handoff/:id/heartbeat`, `/:id/complete`, `/:id/form-fields`, `/:id/page-key`, `/:id/fill-form` | Signed handoff token **and** `joshu_handoff_auth` cookie (fresh password for this handoff) |
| `GET /handoff/:id` (mobile shell + noVNC) | Signed token; missing auth cookie serves the Joshu sign-in gate (does **not** skip if already logged into the desktop) |
| `/api/files/*`, `/api/excalidraw/cwm/*`, `/api/ag-ui/run` | Desktop browser or local |

## Remaining risk

`isDesktopBrowserOrLocalRequest` blocks **anonymous** probes (no Cookie / no Sec-Fetch-Site). It does **not** cryptographically verify an ArozOS session — a client that forges those headers still passes. Follow-up: validate ArozOS session server-side (or Bearer tied to owner login).

## Hermes Admin (separate hostname)

`hermes-admin.<slug>.<suffix>` is **not** gated by Joshu’s localhost helpers — it is a **separate Caddy vhost** to Hermes on `127.0.0.1:9119` with Caddy basic auth. Without `JOSHU_HERMES_DASHBOARD_PASSWORD`, the vhost must not be published (2026-09 fleet incident). **A password in `instance.env` is not the lock** — unauth GET must return **401**, and Caddy must run `caddy-entrypoint.sh` (Clara 2026-09-16: password set, static Aug 14 Caddyfile, unauth 200). Caddy sets `header_up Host 127.0.0.1:9119`, which bypasses Hermes’ DNS-rebinding Host check — so **live basic auth + MCP allowlist** are the production controls, not Hermes’ Host validation alone. See [agent-safety.md](../agent-safety.md#hermes-admin-incident-2026-09).
