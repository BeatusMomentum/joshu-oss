#!/usr/bin/env npx tsx
/**
 * Focused unit/contract tests for durable realtime goal intake.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyRealtimeGoalMessage } from "../src/realtimeGoals/classifier.ts";
import {
  normalizeOwnerSelection,
  ownerSelectionKanbanAppend,
  shouldSuppressRepeatBlockedPrompt,
} from "../src/realtimeGoals/blockedAnswer.ts";
import {
  RealtimeGoalStore,
  realtimeGoalDeliveryContentKey,
} from "../src/realtimeGoals/store.ts";
import {
  realtimeGoalSessionKey,
} from "../src/realtimeGoals/types.ts";
import {
  realtimeGoalVoiceToken,
  verifyRealtimeGoalVoiceToken,
} from "../src/realtimeGoals/voiceCallback.ts";
import {
  EA_KANBAN_BOARDS,
  REALTIME_GOALS_KANBAN_BOARD,
  eaKanbanCreateDefaults,
} from "../src/hermesKanbanBridge.ts";
import { verifyArozosDesktopSession } from "../src/httpLocalhost.ts";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-realtime-goals-"));
process.env.JOSHU_REALTIME_GOALS_STATE_DIR = temp;
process.env.JOSHU_REALTIME_GOALS_CALLBACK_SECRET = "unit-test-secret";
delete process.env.JOSHU_DAY0_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const now = new Date().toISOString();
const goal = {
  id: "goal-1",
  version: 1,
  title: "Research flights",
  objective: "Research flights for next week",
  status: "queued",
  origin: {
    channel: "sms",
    sessionKey: "sms:+15555550123",
    messageId: "SM123",
    replyAddress: "+15555550123",
  },
  sourceMessageId: "SM123",
  idempotencyKey: "realtime-goal:v1:test",
  createdAt: now,
  updatedAt: now,
  releaseAt: new Date(Date.now() + 60_000).toISOString(),
  messages: [{ at: now, role: "owner", text: "Research flights for next week" }],
  intakeReply: "Queued.",
  delivery: { state: "pending", attempts: 0 },
};

try {
  const store = new RealtimeGoalStore(process.cwd());
  assert.equal((await store.insert(goal)).id, goal.id);
  assert.equal((await store.insert({ ...goal, id: "duplicate" })).id, goal.id);
  assert.equal((await store.read()).goals.length, 1, "source event must be idempotent");

  const session = realtimeGoalSessionKey(goal.origin);
  assert.equal((await store.listActiveForSession(session)).length, 1);
  await store.update(goal.id, (item) => {
    item.kanbanTaskId = "t_goal";
    item.status = "ready";
    item.delivery.state = "delivered";
  });
  assert.equal(
    (await store.listOutstanding()).length,
    1,
    "nonterminal tasks must reconcile even after a blocked event was delivered",
  );

  await store.reserveInbound({
    id: "sms:SM-INBOX",
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555550123",
      messageId: "SM-INBOX",
      replyAddress: "+15555550123",
    },
    text: "Durably reserve me before Twilio ACK",
    receivedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.equal((await store.listStaleInbound(0)).length, 1);
  await store.completeInbound("sms:SM-INBOX");
  assert.equal((await store.listStaleInbound(0)).length, 0);

  await store.update(goal.id, (item) => {
    item.delivery.state = "pending";
    item.delivery.attempts = 0;
    item.delivery.lastDeliveredKey = undefined;
  });
  const contentKey = realtimeGoalDeliveryContentKey("completed", "Hotel shortlist ready.");
  const firstClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(firstClaim.claimed, true, "first delivery claim must win");
  await store.finalizeDeliveryAttempt(goal.id, contentKey, { delivered: true }, 5);
  const duplicateClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(duplicateClaim.claimed, false, "duplicate completion SMS must be suppressed");
  const concurrentClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(concurrentClaim.claimed, false, "delivered content key must block re-send");

  const hotelMenu =
    "No Loop-area hotel is under $250/night. Holiday Inn ($646), Ohio House ($638). Which one do you want me to hold?";
  const answeredGoal = {
    blockedAnsweredAt: now,
    lastBlockedPrompt: hotelMenu,
  };
  assert.equal(
    shouldSuppressRepeatBlockedPrompt(answeredGoal, hotelMenu),
    true,
    "exact repeat blocked prompt after owner answer must suppress SMS",
  );
  assert.equal(
    shouldSuppressRepeatBlockedPrompt(answeredGoal, `${hotelMenu} `),
    true,
    "trimmed repeat blocked prompt must suppress SMS",
  );
  assert.equal(
    shouldSuppressRepeatBlockedPrompt(answeredGoal, "Which one do you want me to hold — confirm 2 nights?"),
    true,
    "hotel menu re-ask pattern must suppress SMS after owner answer",
  );
  assert.equal(
    shouldSuppressRepeatBlockedPrompt(answeredGoal, "Hotels.com bot wall — please solve the captcha in the handoff link."),
    false,
    "new blocked question after owner answer must still deliver",
  );
  assert.equal(
    shouldSuppressRepeatBlockedPrompt({}, hotelMenu),
    false,
    "blocked prompt without prior answer must deliver",
  );
  assert.equal(normalizeOwnerSelection("  lets   do  holiday inn  "), "lets do holiday inn");
  assert.match(
    ownerSelectionKanbanAppend("Holiday Inn", now, "SM123"),
    /Owner selection.*BOOK THIS \(do not re-search\)/,
    "blocked-answer kanban append must use booking directive marker",
  );
  assert.match(
    ownerSelectionKanbanAppend("Holiday Inn", now, "SM123"),
    /Owner chose: Holiday Inn/,
  );

  const cancel = await classifyRealtimeGoalMessage("never mind", [goal]);
  assert.equal(cancel.decision, "cancel");
  assert.equal(cancel.goalId, goal.id);

  const status = await classifyRealtimeGoalMessage("how is that going?", [goal]);
  assert.equal(status.decision, "status");

  const failOpen = await classifyRealtimeGoalMessage("Please investigate this", []);
  assert.equal(failOpen.decision, "pass");
  assert.equal(failOpen.reason, "classifier_unconfigured_fail_open");

  assert.ok(EA_KANBAN_BOARDS.includes(REALTIME_GOALS_KANBAN_BOARD));
  assert.equal(
    eaKanbanCreateDefaults(REALTIME_GOALS_KANBAN_BOARD).max_runtime_seconds,
    28_800,
  );

  const token = realtimeGoalVoiceToken(goal.id);
  assert.equal(verifyRealtimeGoalVoiceToken(goal.id, token), true);
  assert.equal(verifyRealtimeGoalVoiceToken("other-goal", token), false);

  assert.equal(
    await verifyArozosDesktopSession({
      headers: { host: "127.0.0.1:8788" },
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    }),
    true,
  );
  process.env.CUSTOMER_DOMAIN = "box.example.test";
  process.env.PUBLIC_AROZ_PORT = "1";
  assert.equal(
    await verifyArozosDesktopSession({
      headers: {
        host: "box.example.test",
        cookie: "forged-cookie",
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "203.0.113.1",
      },
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    }),
    false,
    "forged cookie/header shape must fail authoritative ArozOS validation",
  );

  const bridge = await readFile(
    path.join(process.cwd(), "scripts", "hermes-kanban-bridge.py"),
    "utf8",
  );
  assert.match(bridge, /if action == "cancel":/);
  assert.match(bridge, /include_run/);
  assert.match(bridge, /strict_idempotency/);
  assert.match(bridge, /"realtime-goals"/);
  assert.match(bridge, /idx_joshu_realtime_goal_idempotency/);
  assert.match(bridge, /HERMES_KANBAN_TASK=/);
  assert.match(bridge, /os\.killpg/);

  const noDecomposePatch = await readFile(
    path.join(
      process.cwd(),
      "scripts",
      "patch-hermes-ea-kanban-no-autodecompose.py",
    ),
    "utf8",
  );
  assert.match(noDecomposePatch, /"realtime-goals"/);

  const voiceCallback = await readFile(
    path.join(process.cwd(), "src", "realtimeGoals", "voiceCallback.ts"),
    "utf8",
  );
  assert.match(voiceCallback, /purpose: "result" \| "status"/);
  assert.match(voiceCallback, /voiceServiceAuthorized/);
  assert.match(voiceCallback, /x-joshu-voice-call-sid/);

  const phoneSession = await readFile(
    path.join(
      process.cwd(),
      "packages",
      "voice-realtime",
      "src",
      "twilioRealtimeSession.ts",
    ),
    "utf8",
  );
  assert.match(phoneSession, /realtimeGoalAckPending/);
  assert.match(phoneSession, /trailing mark/);

  console.log("test-realtime-goals: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
