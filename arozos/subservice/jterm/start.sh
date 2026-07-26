#!/usr/bin/env bash
# Launched by ArozOS with: -port :NNNN -rpt http://localhost:PARENT/api/ajgi/interface
set -euo pipefail

SUBSERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AROZ_STATIC_DIR="${AROZ_STATIC_DIR:-${SUBSERVICE_DIR}/app}"
export AROZ_STATIC_APP_NAME="${AROZ_STATIC_APP_NAME:-joshu-jterm}"

# Prefer system python3 (stdlib PTY + WebSocket). Hermes venv is a fine fallback.
PYTHON_BIN="${JTERM_PYTHON:-}"
if [[ -z "${PYTHON_BIN}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  elif [[ -x /opt/hermes-agent/venv/bin/python ]]; then
    PYTHON_BIN="/opt/hermes-agent/venv/bin/python"
  else
    echo "[joshu-jterm] python3 not found" >&2
    exit 1
  fi
fi

# Soft defaults — full container access once the shell starts.
export JTERM_SHELL="${JTERM_SHELL:-/bin/bash}"
export JTERM_CWD="${JTERM_CWD:-/root}"
export HERMES_BIN="${HERMES_BIN:-/opt/hermes-agent/venv/bin/hermes}"
export HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
export HERMES_HOME="${HERMES_HOME:-${HOME:-/root}/.hermes}"

exec "${PYTHON_BIN}" "${SUBSERVICE_DIR}/server.py" "$@"
