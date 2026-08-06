# jTerm (ArozOS owner terminal)

Interactive **root shell** into the Joshu box container from the ArozOS desktop.

## What it is

| | |
|--|--|
| **Desktop label** | jTerm |
| **Module** | `arozos/subservice/jterm/` |
| **UI** | Vite + xterm.js (`apps/jterm/`) |
| **Backend** | Python stdlib PTY + WebSocket (`server.py`) on the ArozOS subservice port |
| **Auth** | ArozOS login + module permission (same reverse-proxy / WS path as other apps) |

This is an **owner power tool**, not a sandboxed agent terminal. It is equivalent to `docker exec` into `joshu-stack`: Hermes CLI, `/etc/joshu` secrets, localhost services, and the full container filesystem are reachable. Action guard / Hermes Desktop scoping do **not** apply.

## Hermes CLI

jTerm puts `HERMES_BIN` on `PATH` and sets `HERMES_HOME` (default **`/root/.hermes`** on VPS — same volume the gateway uses). So `hermes chat`, plugins, kanban helpers, etc. share box config (`config.yaml`, skills, `.env`).

**Do not** start a second `hermes gateway run` from jTerm while Joshu already manages the gateway — you will fight that process. One-shot CLI against the existing home is fine.

Shell is interactive non-login (`bash --rcfile … -i`) so `/etc/profile` does not wipe `PATH` (a plain `bash -l` would drop Hermes from `PATH`).

## Layout

```text
apps/jterm/                     # xterm.js UI
arozos/subservice/jterm/
  moduleInfo.json
  joshu.app.json
  start.sh                      # python3 server.py
  server.py                     # static + /ws PTY
  app/                          # built assets (from dist/jterm)
```

## Local

```bash
npm run build:jterm
npm run dev:arozos   # rsyncs subservice + installs jTerm.shortcut
```

Open **jTerm** from the desktop. Default cwd is `/root` (or `$JTERM_CWD`).

## VPS / hotpatch

jTerm is self-contained inside the subservice directory (no native Node addon).

**Quick path onto a live box:**

```bash
bash scripts/hotpatch-jterm.sh root@<customer-domain-or-ip>
# example:
# bash scripts/hotpatch-jterm.sh root@box.example.com
```

That builds the UI, recreates `joshu-stack`, then copies `arozos/subservice/jterm` into the ArozOS volume + template (post-boot, clearing stale Vite hashed assets), and installs the desktop shortcut. **Hard-refresh** the desktop (Cmd+Shift+R) and open a **new** jTerm window.

For a normal image release, `build:deploy` + Dockerfile bake jTerm into `/opt/arozos-template/subservice/jterm`.

## Env

| Variable | Default | Role |
|----------|---------|------|
| `JTERM_SHELL` | `/bin/bash` | Shell binary |
| `JTERM_CWD` | `/root` | Initial cwd |
| `HERMES_BIN` | `/opt/hermes-agent/venv/bin/hermes` | Added to PATH |
| `HERMES_HOME` | `/root/.hermes` | Hermes state (same as gateway) |
| `HERMES_DIR` | `/opt/hermes-agent` | Hermes checkout |
| `JTERM_PYTHON` | `python3` | Override interpreter |

## TUI notes (Hermes CLI)

Hermes (and other full-screen CLIs) clear/redraw the alternate screen — that is expected. jTerm only notifies the PTY of **real** size changes (debounced `ResizeObserver`, ≥2px host delta) so float-window chrome does not spam `SIGWINCH` and force constant redraws. The viewport always reserves a vertical scrollbar gutter (`overflow-y: scroll` + `scrollbar-gutter: stable`) so FitAddon does not blink scrollbars when the measured area toggles by one gutter width.

## Security notes

- Gate access via ArozOS permission groups (module **jTerm**). Prefer admin-only groups on multi-user boxes.
- Do not expose the subservice port outside ArozOS.
- Treat every session as full compromise of the box if the desktop session is compromised.
