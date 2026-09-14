#!/usr/bin/env node
/**
 * SMS channel must not route handoff results through nylas_send_message.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gateNylasSendRequest } from "../dist/actionGuard/nylasSendGate.js";
import { createHandoff, completeHandoff } from "../dist/browserHandoff/store.js";
import {
  isOwnerSmsRecentlyActive,
  isSmsHermesSessionKey,
  resolveOwnerSmsSessionKey,
} from "../dist/twilioSmsSession.js";
import {
  phoneFromSmsHermesSessionKey,
  shouldDeliverSmsHandoffContinuation,
} from "../dist/browserHandoff/smsContinue.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-nylas-"));
const smsDir = path.join(root, ".joshu", "sms");
fs.mkdirSync(smsDir, { recursive: true, mode: 0o700 });

const now = Date.now();
const phone = "+15551234567";
fs.writeFileSync(
  path.join(smsDir, "sessions.json"),
  JSON.stringify(
    {
      sessions: {
        [phone]: {
          sessionKey: `sms:${phone}:${now}`,
          lastActiveAt: new Date(now).toISOString(),
        },
      },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

assert.equal(isSmsHermesSessionKey(`sms:${phone}:${now}`), true);
assert.equal(isSmsHermesSessionKey("joshu-hermes-chat:abc"), false);
assert.equal(isOwnerSmsRecentlyActive(root), true);
assert.equal(phoneFromSmsHermesSessionKey(`sms:${phone}:123`), phone);

const handoff = createHandoff(root, {
  pageUrl: "https://amazon.com/orders",
  pageTitle: "Your Orders",
  instructions: "Find most recent order",
  hermesSessionKey: `sms:${phone}:${now}`,
});
completeHandoff(root, handoff.id);
const completed = JSON.parse(
  fs.readFileSync(path.join(root, ".joshu", "browser-handoff", `${handoff.id}.json`), "utf8"),
);
assert.equal(shouldDeliverSmsHandoffContinuation(completed), true);

const gate = await gateNylasSendRequest(
  { headers: {} },
  { to: "owner@example.com", subject: "Amazon order", body: "Your order is …" },
  root,
);
assert.equal(gate.allowed, false);
assert.equal(gate.unavailable?.code, "nylas_send_blocked_sms_channel");

const eaGate = await gateNylasSendRequest(
  { headers: {} },
  {
    to: "guest@example.com",
    subject: "Meeting",
    body: "Confirming…",
    kanbanTaskId: "t_abc123",
  },
  root,
);
assert.notEqual(eaGate.unavailable?.code, "nylas_send_blocked_sms_channel");

// Stale SMS session should not block when no recent handoff either.
const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-stale-"));
fs.mkdirSync(path.join(staleRoot, ".joshu", "sms"), { recursive: true });
fs.writeFileSync(
  path.join(staleRoot, ".joshu", "sms", "sessions.json"),
  JSON.stringify(
    {
      sessions: {
        [phone]: {
          sessionKey: `sms:${phone}:1`,
          lastActiveAt: new Date(now - 3 * 60 * 60_000).toISOString(),
        },
      },
    },
    null,
    2,
  ),
);
assert.equal(isOwnerSmsRecentlyActive(staleRoot), false);

console.log("sms-nylas-block: ok");
