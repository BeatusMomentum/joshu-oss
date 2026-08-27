#!/usr/bin/env bash
# Joshu SMS uses twilioSmsGateway — disable Hermes native SMS platform auto-start.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-joshu-disable-native-sms-platform.py"

if [[ ! -f "${HERMES_DIR}/gateway/config.py" ]]; then
  echo "[disable-native-sms-platform] skip: no Hermes gateway config under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[disable-native-sms-platform] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[disable-native-sms-platform] applying via patch-hermes-joshu-disable-native-sms-platform.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
