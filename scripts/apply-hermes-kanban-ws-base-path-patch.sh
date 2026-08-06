#!/usr/bin/env bash
# Kanban dashboard WebSocket must honour __HERMES_BASE_PATH__ when Joshu (or any
# reverse proxy) serves Hermes admin under a path prefix, e.g. /joshu/hermes-admin.
#
# Hermes >= ~0.20 builds the URL via SDK.buildWsUrl(); older bundles used a
# literal `const url = \`${proto}//${host}${API}/events?${qs}\``.
set -euo pipefail

HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
KANBAN_JS="${HERMES_DIR}/plugins/kanban/dashboard/dist/index.js"

if [[ ! -f "${KANBAN_JS}" ]]; then
  echo "[hermes-kanban-ws-patch] skip: ${KANBAN_JS} not found"
  exit 0
fi

if rg -q 'function kanbanDashboardBasePath' "${KANBAN_JS}" 2>/dev/null; then
  echo "[hermes-kanban-ws-patch] already applied"
  exit 0
fi

python3 - <<'PY' "${KANBAN_JS}"
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

helper = """
  function kanbanDashboardBasePath() {
    const injected = (window.__HERMES_BASE_PATH__ || "").replace(/\\/+$/, "");
    if (injected) return injected;
    const m = window.location.pathname.match(/^(\\/.+?\\/hermes-admin)(?:\\/|$)/);
    return m ? m[1] : "";
  }
"""

anchor = '  const MIME_TASK = "text/x-hermes-task";'
if anchor not in text:
    raise SystemExit("anchor not found — upstream kanban bundle changed")
if "function kanbanDashboardBasePath" not in text:
    text = text.replace(anchor, anchor + helper, 1)

applied = False

# v0.20+: SDK.buildWsUrl(`${API}/events`, wsParams).then(...)
build_pat = r"SDK\.buildWsUrl\(`\$\{API\}/events`,\s*wsParams\)\.then\(function\s*\(\s*url\s*\)\s*\{"
if re.search(build_pat, text):
    # Prefix path into the API segment passed to buildWsUrl.
    text2, n = re.subn(
        build_pat,
        "SDK.buildWsUrl(`${kanbanDashboardBasePath()}${API}/events`, wsParams).then(function (url) {",
        text,
        count=1,
    )
    if n:
        text = text2
        applied = True

# Legacy one-liner WS URL (patched or stock).
if not applied:
    patterns = [
        r"const url = `\$\{proto\}//\$\{window\.location\.host\}\$\{basePath\}\$\{API\}/events\?\$\{qs\}`;",
        r"const url = `\$\{proto\}//\$\{window\.location\.host\}\$\{API\}/events\?\$\{qs\}`;",
    ]
    replacement = (
        "const basePath = kanbanDashboardBasePath();\n"
        "        const url = `${proto}//${window.location.host}${basePath}${API}/events?${qs}`;"
    )
    for pat in patterns:
        new_text, n = re.subn(pat, replacement, text, count=1)
        if n:
            text = new_text
            applied = True
            break

if not applied:
    raise SystemExit("WebSocket url line not found — upstream kanban bundle changed")

path.write_text(text, encoding="utf-8")
print("[hermes-kanban-ws-patch] applied")
PY

echo "[hermes-kanban-ws-patch] done — hard-refresh Hermes Admin (Kanban tab) in the browser"
