#!/usr/bin/env npx tsx
/**
 * Unit tests: SMS GSM folding + action-guard approval reply parsing.
 *
 * Usage: npm run test:sms-send
 */
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseApprovalReply } from "../src/actionGuard/approvalReply.js";
import { listOpenPending } from "../src/actionGuard/pending.js";
import { handleSmsApprovalIngress } from "../src/actionGuard/smsIngress.js";
import { SMS_MAX_CHARS, SMS_MAX_PARTS, smsGsmParts, smsGsmPlaintext } from "../src/twilioSmsSend.js";
import {
  HermesStreamContentScrubber,
  looksLikeLeakedModelOutput,
  scrubHermesAssistantContent,
} from "../src/hermesStreamContentScrubber.js";
import { smsModelReplyPlaintext } from "../src/smsModelReplyPlaintext.js";

{
  assert.equal(parseApprovalReply("y"), "approved");
  assert.equal(parseApprovalReply("yes"), "approved");
  assert.equal(parseApprovalReply("ok"), "approved");
  assert.equal(parseApprovalReply("ok thanks"), "approved");
  assert.equal(parseApprovalReply("n"), "denied");
  assert.equal(parseApprovalReply("no"), "denied");
}

{
  assert.equal(parseApprovalReply("Ok on Nevada. Before I blocked it I was unable to log in."), null);
  assert.equal(parseApprovalReply("Yes I want to book the Tuesday slot with Maria"), null);
  assert.equal(parseApprovalReply("See last text"), null);
}

{
  const folded = smsGsmPlaintext("I've got your text — the one about Conduit…");
  assert.match(folded, /I've got your text - the one about Conduit.../);
  assert.equal(/[^\x09\x0A\x0D\x20-\x7E]/.test(folded), false);
}

{
  const long = `${"A".repeat(SMS_MAX_CHARS + 80)} leftover`;
  const parts = smsGsmParts(long);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= SMS_MAX_CHARS);
  assert.ok(parts.join("").includes("A"));
  assert.ok(parts.some((p) => p.includes("leftover")));
}

{
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence ${i} has more detail.`).join(" ");
  const parts = smsGsmParts(sentences);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= SMS_MAX_CHARS);
    assert.equal(/[^\x09\x0A\x0D\x20-\x7E]/.test(p), false);
  }
  assert.ok(parts.length <= SMS_MAX_PARTS);
}

{
  const one = smsGsmPlaintext("I've got your text — short.");
  assert.ok(one.length < SMS_MAX_CHARS);
}

{
  const leaked =
    "Owner said no. Closing the card. Let me reconcile the rest. I need to pass the arguments. " +
    "<DSMLtool_calls> <DSMLinvoke name=\"tool_call\"> " +
    "<DSMLparameter name=\"name\" string=\"true\">mcp__joshu_connectors__mail_list_track_tasks</DSMLparameter>";
  assert.equal(scrubHermesAssistantContent(leaked).includes("DSML"), false);
  assert.equal(looksLikeLeakedModelOutput(leaked), true);
  // SMS plaintext is markdown-only — DSML scrub is Hermes's job at source.
  assert.match(smsModelReplyPlaintext(leaked), /Owner said no/);
}

{
  const ok = smsModelReplyPlaintext("Got it — I'll close the ByteDance thread and leave you alone on that one.");
  assert.match(ok, /close the ByteDance thread/);
}

{
  const handoff =
    "Tap here to sign in: https://patrick.box.joshu.me/joshu/handoff/abc?t=token&exp=123";
  assert.match(smsModelReplyPlaintext(handoff), /patrick\.box\.joshu\.me\/joshu\/handoff\/abc/);
}

{
  const scrubber = new HermesStreamContentScrubber();
  const parts = [
    "Sure — ",
    "<DSMLtool_calls> <DSMLinvoke ",
    'name="tool_call"> junk',
  ];
  let out = "";
  for (const p of parts) out += scrubber.feed(p);
  out += scrubber.flush();
  assert.equal(out.includes("DSML"), false);
  assert.match(out, /Sure/);
}

{
  const scrubber = new HermesStreamContentScrubber();
  const parts = ["there is a ", "thread in ", "your inbox"];
  let out = "";
  for (const p of parts) out += scrubber.feed(p);
  out += scrubber.flush();
  assert.equal(out, "there is a thread in your inbox");
}

function pendingDirForRoot(root) {
  const arozUser = "test@example.com";
  return path.join(root, ".local", "arozos-data", "files", "users", arozUser, ".joshu", "action-guard", "pending");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-ingress-"));
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = path.join(root, ".local", "arozos-data");
  const pendingDir = pendingDirForRoot(root);
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, "stale.json"),
    JSON.stringify(
      {
        id: "stale",
        actionId: "nylas_send_message",
        summary: { to: "old@example.com" },
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:30:00.000Z",
        status: "pending",
      },
      null,
      2,
    ),
  );
  assert.equal(listOpenPending(root).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pendingDir, "stale.json"), "utf8")).status, "timeout");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-ingress-off-"));
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = path.join(root, ".local", "arozos-data");
  const policyDir = path.join(root, ".local", "arozos-data", "files", "users", "test@example.com", ".joshu", "action-guard");
  fs.mkdirSync(path.join(policyDir, "pending"), { recursive: true });
  fs.writeFileSync(
    path.join(policyDir, "policy.json"),
    JSON.stringify({ enabled: false }, null, 2),
  );
  const consumed = await handleSmsApprovalIngress("+15551234567", "ok", root);
  assert.equal(consumed, false);
}

console.log("test-sms-send: ok");
