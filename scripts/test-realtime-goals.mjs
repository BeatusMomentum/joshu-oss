#!/usr/bin/env npx tsx
/**
 * Focused unit/contract tests for durable realtime goal intake.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyRealtimeGoalMessage,
  isExplicitCancelPhrase,
  routeRealtimeGoalMessage,
} from "../src/realtimeGoals/router.ts";
import { RealtimeGoalBroker } from "../src/realtimeGoals/broker.ts";
import {
  isDeferCapableChannel,
  isQueueCapableChannel,
} from "../src/realtimeGoals/channelPolicy.ts";
import {
  normalizeOwnerSelection,
  ownerSelectionKanbanAppend,
  shouldSuppressRepeatBlockedPrompt,
} from "../src/realtimeGoals/blockedAnswer.ts";
import { buildHermesBrokerContextMessage } from "../src/realtimeGoals/brokerContext.ts";
import {
  RealtimeGoalStore,
  realtimeGoalDeliveryContentKey,
} from "../src/realtimeGoals/store.ts";
import { SessionThreadStore } from "../src/realtimeGoals/sessionThread.ts";
import {
  realtimeGoalSessionKey,
} from "../src/realtimeGoals/types.ts";
import {
  realtimeGoalVoiceToken,
  verifyRealtimeGoalVoiceToken,
} from "../src/realtimeGoals/voiceCallback.ts";
import { formatOwnerCompletion } from "../src/realtimeGoals/ownerDelivery.ts";
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
  title: "Research Fareed Zakaria AI article",
  objective: "Research Fareed Zakaria AI article from Washington Post",
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
  messages: [{ at: now, role: "owner", text: "Research Fareed Zakaria AI article from Washington Post" }],
  intakeReply: "Queued.",
  delivery: { state: "pending", attempts: 0 },
};

try {
  const store = new RealtimeGoalStore(process.cwd());
  const threads = new SessionThreadStore(process.cwd());
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

  await threads.recordOwnerTurn("sms:+15555550123", "Research article", "SM-owner-1");
  await threads.recordBoxTurn(
    "sms:+15555550123",
    "This will take a little longer, so I queued it. I'll reply here when it's done. Anything else?",
    "broker",
    goal.id,
  );
  assert.equal((await threads.getTurns("sms:+15555550123")).length, 2);
  assert.equal(
    await threads.recordOwnerTurn("sms:+15555550123", "Research article", "SM-owner-1"),
    false,
    "messageId idempotency must skip duplicate owner turns",
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
  assert.equal(duplicateClaim.claimed, false, "delivered content key must block re-send");
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

  assert.equal(isQueueCapableChannel("sms"), true);
  assert.equal(isQueueCapableChannel("jchat"), false);
  assert.equal(isDeferCapableChannel("agui"), false);

  const cancel = await classifyRealtimeGoalMessage("never mind", [goal]);
  assert.equal(cancel.decision, "cancel");
  assert.equal(cancel.goalId, goal.id);

  const status = await classifyRealtimeGoalMessage("how is that going?", [goal]);
  assert.equal(status.decision, "status");

  const syncOnly = await routeRealtimeGoalMessage({
    text: "Book me a flight to Chicago",
    activeGoals: [goal],
    threadTurns: [],
    queueCapable: false,
  });
  assert.equal(syncOnly.decision, "pass");
  assert.equal(syncOnly.reason, "sync_only_channel");

  const threadTurns = await threads.getTurns("sms:+15555550123");
  const ackRoute = await routeRealtimeGoalMessage(
    {
      text: "Nope",
      activeGoals: [goal],
      threadTurns,
      queueCapable: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "ack",
          confidence: 0.95,
          goal_id: goal.id,
          reply: "Got it — I'll text you when the article research is done.",
          reason: "answering_anything_else",
        }),
    },
  );
  assert.equal(ackRoute.decision, "ack");
  assert.match(ackRoute.reply ?? "", /article research/i);

  const legacyUpdateRoute = await routeRealtimeGoalMessage(
    {
      text: "also include the New York Times",
      activeGoals: [goal],
      threadTurns,
      queueCapable: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "update",
          confidence: 0.9,
          goal_id: goal.id,
          reason: "scope_addition",
        }),
    },
  );
  assert.equal(legacyUpdateRoute.decision, "pass", "unbound legacy update folds to pass");

  assert.equal(isExplicitCancelPhrase("cancel that"), true);

  const brokerContext = buildHermesBrokerContextMessage([goal], threadTurns);
  assert.match(brokerContext ?? "", /Active background goals/);
  assert.match(brokerContext ?? "", /Recent owner↔box thread/);

  await store.update(goal.id, (item) => {
    item.status = "queued";
    item.kanbanTaskId = undefined;
    item.delivery.state = "pending";
  });
  const broker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    async () => ({
      decision: "ack",
      confidence: 0.95,
      goalId: goal.id,
      reply: "Got it — I'll text you when the article research is done.",
      reason: "answering_anything_else",
    }),
  );
  const ack = await broker.route({
    origin: {
      channel: "sms",
      sessionKey: goal.origin.sessionKey,
      messageId: "SM-nope-ack",
      replyAddress: goal.origin.replyAddress,
    },
    text: "Nope",
  });
  assert.equal(ack.action, "reply");
  assert.match(ack.text, /article research/i);
  const stillQueued = await store.get(goal.id);
  assert.equal(stillQueued?.status, "queued", "ack must not cancel queued goal");

  // Patrick replay: active branch binds follow-ups (search → reserve → rate).
  const patrickSession = "sms:+15555550999";
  const hotelSearch = {
    id: "goal-hotel-search",
    version: 1,
    title: "Chicago hotel search Sep 25-27",
    objective: "Search Chicago hotels Sep 25-27 under $250",
    status: "blocked",
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-search",
      replyAddress: "+15555550999",
    },
    sourceMessageId: "SM-search",
    idempotencyKey: "realtime-goal:v1:hotel-search",
    createdAt: now,
    updatedAt: now,
    kanbanTaskId: "t_hotel_search",
    lastKanbanStatus: "blocked",
    lastBlockReason: "The Wade is back ($711 non-ref / $782 ref). Which rate?",
    messages: [{ at: now, role: "owner", text: "Can you do another search for me?" }],
    intakeReply: "Queued.",
    delivery: { state: "delivered", attempts: 1 },
  };
  await store.insert(hotelSearch);
  await threads.setActiveGoal(patrickSession, hotelSearch.id);

  const patrickRouter = async (input) => {
    if (input.activeBranch) {
      return {
        decision: "update",
        confidence: 0.9,
        goalId: input.activeBranch.id,
        reason: "bound_continuation",
      };
    }
    if (/^hey[!,. ]*$/i.test(input.text.trim())) {
      return { decision: "pass", confidence: 1, reason: "greeting" };
    }
    return { decision: "pass", confidence: 0.78, reason: "would_sync_pass" };
  };
  const patrickBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    patrickRouter,
  );

  const reserve = await patrickBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-reserve",
      replyAddress: "+15555550999",
    },
    text: "Can you reserve for me the wade",
  });
  assert.equal(reserve.action, "reply", "reserve must bind active branch, not pass");
  assert.equal(reserve.outcome, "updated");
  const afterReserve = await store.get(hotelSearch.id);
  assert.match(afterReserve?.objective ?? "", /reserve for me the wade/i);

  const clarifyingGoal = {
    id: "goal-clarifying",
    version: 1,
    title: "Book The Wade",
    objective: "Book The Wade Chicago Sep 25-27",
    status: "clarifying",
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555551000",
      messageId: "SM-clarify",
      replyAddress: "+15555551000",
    },
    sourceMessageId: "SM-clarify",
    idempotencyKey: "realtime-goal:v1:clarifying",
    createdAt: now,
    updatedAt: now,
    clarificationQuestion: "Non-refundable ($711) or refundable ($782)?",
    messages: [{ at: now, role: "owner", text: "Book The Wade" }],
    intakeReply: "Non-refundable ($711) or refundable ($782)?",
    delivery: { state: "pending", attempts: 0 },
  };
  await store.insert(clarifyingGoal);
  await threads.setActiveGoal("sms:+15555551000", clarifyingGoal.id);

  const clarifyingBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    patrickRouter,
  );
  const rateChoice = await clarifyingBroker.route({
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555551000",
      messageId: "SM-nonref",
      replyAddress: "+15555551000",
    },
    text: "Non refundable",
  });
  assert.equal(rateChoice.action, "reply");
  assert.equal(rateChoice.outcome, "queued");
  const promoted = await store.get(clarifyingGoal.id);
  assert.equal(promoted?.status, "queued", "clarifying answer must promote to queued");
  assert.ok(promoted?.releaseAt, "clarifying answer must set releaseAt");

  await threads.clearActiveGoal(patrickSession);
  const hey = await patrickBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-hey",
      replyAddress: "+15555550999",
    },
    text: "hey",
  });
  assert.equal(hey.action, "pass", "unbound greeting must pass to sync Hermes");

  assert.equal((await threads.getActiveGoal(patrickSession))?.goalId, undefined);
  await threads.setActiveGoal(patrickSession, hotelSearch.id);
  assert.equal((await threads.getActiveGoal(patrickSession))?.goalId, hotelSearch.id);

  const doneHotel = {
    ...hotelSearch,
    id: "goal-hotel-done",
    status: "done",
    kanbanTaskId: "t_hotel_done",
    lastKanbanStatus: "done",
    sourceMessageId: "SM-done",
    idempotencyKey: "realtime-goal:v1:hotel-done",
  };
  await store.insert(doneHotel);
  await threads.setActiveGoal(patrickSession, doneHotel.id);

  const pivotRouter = async (input) => {
    if (input.activeBranch?.id === doneHotel.id) {
      return {
        decision: "queue",
        confidence: 0.92,
        title: "NYC–Chicago flight under $400",
        reason: "bound_pivot_new_work",
      };
    }
    return {
      decision: "queue",
      confidence: 0.9,
      title: "NYC–Chicago flight under $400",
      reason: "new_long_work",
    };
  };
  const pivotBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    pivotRouter,
  );
  const pivot = await pivotBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-flight-new",
      replyAddress: "+15555550999",
    },
    text: "Sorry, lets do something new: Book me a round-trip flight from New York to Chicago, leaving Friday morning and back Sunday evening, aisle seat, under $400.",
  });
  assert.equal(pivot.action, "reply", "bound pivot must queue new branch, not update hotel");
  assert.equal(pivot.outcome, "queued");
  assert.notEqual(pivot.goalId, doneHotel.id);
  const doneAfterPivot = await store.get(doneHotel.id);
  assert.equal(doneAfterPivot?.status, "done", "done hotel goal must stay untouched");
  assert.doesNotMatch(doneAfterPivot?.objective ?? "", /round-trip flight/i);

  const boundPivotRoute = await routeRealtimeGoalMessage(
    {
      text: "Sorry, lets do something new: Book me a round-trip flight from New York to Chicago.",
      activeGoals: [doneHotel],
      threadTurns: [],
      queueCapable: true,
      activeBranch: doneHotel,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "queue",
          confidence: 0.92,
          title: "NYC–Chicago flight",
          reason: "pivot_from_hotel_to_flight",
        }),
    },
  );
  assert.equal(boundPivotRoute.decision, "queue");

  const failOpen = await classifyRealtimeGoalMessage("Please investigate this", []);
  assert.equal(failOpen.decision, "pass");
  assert.equal(failOpen.reason, "router_unconfigured_fail_open");

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
  assert.match(bridge, /if action == "reopen":/);
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

  const routerSource = await readFile(
    path.join(process.cwd(), "src", "realtimeGoals", "router.ts"),
    "utf8",
  );
  assert.match(routerSource, /decision.*ack/);
  assert.doesNotMatch(routerSource, /SHORT_ACK_PATTERN/);

  const raw =
    "Alaska LAX\u2194SFO same-day round trip for Mon 2026-09-28 is staged at checkout and handed to the owner. " +
    "Out AS 1501 LAX 7:16 AM \u2192 SFO 8:40 AM; back AS 520 SFO 3:41 PM \u2192 LAX 5:12 PM; Main cabin, $442.80 all-in. " +
    "Contact fields prefilled (db@project-aeon.com, +1, US); owner enters name and pays at the handoff link. " +
    "An image CAPTCHA on alaskaair.com's cart\u2192checkout step was cleared this run.";
  const link = "https://patrick.box.joshu.me/joshu/handoff/ddc5d6eb-8a75-4d1a-9fee-2670383dec00?exp=1";
  const friendly = formatOwnerCompletion(raw, [link]);
  assert.match(friendly, /LAX-SFO/);
  assert.match(friendly, /7:16 AM to SFO/);
  assert.match(friendly, /^Out /m);
  assert.match(friendly, /ready for you to finish/);
  assert.match(friendly, /Please enter/);
  assert.match(friendly, /Finish and pay here/);
  assert.match(friendly, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(friendly, /handed to the owner/);
  assert.doesNotMatch(friendly, /CAPTCHA/);
  assert.doesNotMatch(friendly, /cart to checkout/);
  assert.match(friendly, /^Back /m);
  assert.equal(formatOwnerCompletion(`Done.\n\nFinish and pay here:\n${link}`, [link]).split(link).length, 2);

  console.log("test-realtime-goals: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
