#!/usr/bin/env node
/**
 * Slack/Telegram idle-reset product default.
 * Usage: npm run test:hermes-messaging-session-reset
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  DEFAULT_JOSHU_MESSAGING_IDLE_MINUTES,
  joshuMessagingResetPolicy,
  resolveJoshuMessagingIdleMinutes,
  syncJoshuMessagingSessionReset,
} = await import(pathToFileURL(path.join(rootDir, "dist/hermesMessagingSessionReset.js")).href);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
}

assert(DEFAULT_JOSHU_MESSAGING_IDLE_MINUTES === 30, "default idle minutes is 30");
assert(resolveJoshuMessagingIdleMinutes({}) === 30, "empty env → 30");
assert(resolveJoshuMessagingIdleMinutes({ JOSHU_HERMES_MESSAGING_IDLE_MINUTES: "0" }) === null, "0 disables");
assert(resolveJoshuMessagingIdleMinutes({ JOSHU_HERMES_MESSAGING_IDLE_MINUTES: "none" }) === null, "none disables");
assert(resolveJoshuMessagingIdleMinutes({ JOSHU_HERMES_MESSAGING_IDLE_MINUTES: "45" }) === 45, "45 override");

const cfg = {};
assert(syncJoshuMessagingSessionReset(cfg, 30) === true, "first sync writes");
assert(cfg.session_reset.mode === "none", "jChat global remains none");
assert(cfg.reset_by_platform.slack.idle_minutes === 30, "slack 30m");
assert(cfg.reset_by_platform.telegram.mode === "idle", "telegram idle");
assert(syncJoshuMessagingSessionReset(cfg, 30) === false, "idempotent");

const disabled = {};
syncJoshuMessagingSessionReset(disabled, null);
assert(disabled.reset_by_platform.slack.mode === "none", "disable → none on slack");
assert(joshuMessagingResetPolicy(30).idle_minutes === 30, "policy idle_minutes");

console.log("OK: hermes messaging session reset");
