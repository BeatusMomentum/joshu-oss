#!/usr/bin/env node
/**
 * One-off retry for SMS handoff continuation (ops).
 * Uses autoStartGateway:false so we do not replace the live Hermes gateway.
 *
 * Usage (inside joshu-stack container):
 *   node /tmp/retry-sms-handoff-continuation.mjs <handoff-id>
 */
import { deliverSmsHandoffContinuation } from "/opt/joshu/dist/browserHandoff/smsContinue.js";
import { getHandoffRecord } from "/opt/joshu/dist/browserHandoff/store.js";
import { HermesApiRunner } from "/opt/joshu/dist/hermesApi.js";

const handoffId = process.argv[2]?.trim();
if (!handoffId) {
  console.error("usage: retry-sms-handoff-continuation.mjs <handoff-id>");
  process.exit(1);
}

const projectRoot = process.env.JOSHU_PROJECT_ROOT?.trim() || "/opt/joshu";
const record = getHandoffRecord(projectRoot, handoffId);
if (!record) {
  console.error("handoff not found:", handoffId);
  process.exit(1);
}

console.log(
  "retry",
  JSON.stringify({
    id: record.id,
    status: record.status,
    session: record.hermesSessionKey?.slice(0, 32),
    smsContinuationDeliveredAt: record.smsContinuationDeliveredAt ?? null,
  }),
);

const runner = new HermesApiRunner({
  binary: process.env.HERMES_BIN || "/opt/hermes-agent/venv/bin/hermes",
  camofoxUrl: process.env.CAMOFOX_URL || "http://127.0.0.1:9377",
  apiBaseUrl: process.env.HERMES_API_BASE_URL || "http://127.0.0.1:8642",
  apiKey: process.env.HERMES_API_KEY || "",
  autoStartGateway: false,
  hitlCamofoxUserId: process.env.HITL_CAMOFOX_USER_ID || "hitl-camofox",
  hitlCamofoxSessionKey: process.env.HITL_CAMOFOX_SESSION_KEY || "hitl-main",
});

const started = Date.now();
const result = await deliverSmsHandoffContinuation(projectRoot, record, runner);
console.log("result", JSON.stringify(result), "elapsedSec", Math.round((Date.now() - started) / 1000));
