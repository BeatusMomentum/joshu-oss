import { createHmac, timingSafeEqual } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import express, { type Request, type Response, type Router } from "express";
import twilio from "twilio";

import { readAgentProfile, type NylasAgentProfile } from "../nylas/profile.js";
import { resolveOwnerTimezone } from "../ownerLocalTime.js";
import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import { readProactiveState } from "../proactive/state.js";
import { isWithinProactiveWindow } from "../proactive/workingHours.js";
import {
  twilioMediaStreamWssUrl,
} from "../twilioPhoneGateway.js";
import { envTrim, ownerSmsPhone } from "../twilioSmsSend.js";
import type { RealtimeGoalBroker } from "./broker.js";
import type { RealtimeGoalRecord } from "./types.js";

function callbackSecret(): string {
  return (
    envTrim("JOSHU_REALTIME_GOALS_CALLBACK_SECRET") ||
    envTrim("TWILIO_MEDIA_STREAM_SECRET") ||
    envTrim("TWILIO_AUTH_TOKEN")
  );
}

function signGoalId(goalId: string, purpose: "result" | "status"): string {
  const secret = callbackSecret();
  if (!secret) throw new Error("realtime goal callback secret is not configured");
  return createHmac("sha256", secret).update(`${purpose}:${goalId}`).digest("hex");
}

export function realtimeGoalVoiceToken(goalId: string): string {
  return `${goalId}.${signGoalId(goalId, "result")}`;
}

export function verifyRealtimeGoalVoiceToken(goalId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  const expected = realtimeGoalVoiceToken(goalId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function realtimeGoalStatusToken(goalId: string): string {
  return `${goalId}.${signGoalId(goalId, "status")}`;
}

function verifyRealtimeGoalStatusToken(goalId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  const expected = realtimeGoalStatusToken(goalId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function callbackStatusUrl(goalId: string, token = realtimeGoalStatusToken(goalId)): string | undefined {
  const inbound = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!inbound) return undefined;
  try {
    const url = new URL(inbound);
    const statusPath = url.pathname.replace(
      /\/api\/twilio\/voice\/inbound\/?$/,
      "/api/realtime-goals/voice/status",
    );
    if (statusPath === url.pathname) return undefined;
    url.pathname = statusPath;
    url.search = "";
    url.searchParams.set("goalId", goalId);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return undefined;
  }
}

function nextProactiveWindow(projectRoot: string): string | undefined {
  const savedProfile = readAgentProfile(projectRoot);
  const profile = {
    ...(savedProfile ?? {}),
    timezone: resolveOwnerTimezone(projectRoot),
  } as NylasAgentProfile;
  const preferences = readProactiveState(projectRoot, profile.timezone).preferences;
  const nowMs = Date.now();
  for (let offset = 0; offset <= 7 * 24 * 60; offset += 15) {
    const instant = Temporal.Instant.fromEpochMilliseconds(nowMs + offset * 60_000);
    if (isWithinProactiveWindow(profile, preferences, instant).ok) {
      return new Date(nowMs + offset * 60_000).toISOString();
    }
  }
  return undefined;
}

function voiceServiceAuthorized(req: Request, goal: RealtimeGoalRecord): boolean {
  if (!isDirectLocalhostRequest(req)) return false;
  const expected = envTrim("HERMES_API_KEY");
  const authorization = String(req.headers.authorization ?? "");
  const callSid = String(req.headers["x-joshu-voice-call-sid"] ?? "").trim();
  return Boolean(
    expected &&
      authorization === `Bearer ${expected}` &&
      callSid &&
      goal.delivery.providerId === callSid,
  );
}

export async function startRealtimeGoalCallback(
  projectRoot: string,
  goal: RealtimeGoalRecord,
  _text: string,
): Promise<{
  delivered: boolean;
  pending?: boolean;
  providerId?: string;
  retryAt?: string;
  error?: string;
}> {
  const savedProfile = readAgentProfile(projectRoot);
  const profile = {
    ...(savedProfile ?? {}),
    timezone: resolveOwnerTimezone(projectRoot),
  } as NylasAgentProfile;
  const preferences = readProactiveState(projectRoot, profile.timezone).preferences;
  const window = isWithinProactiveWindow(profile, preferences);
  if (!window.ok) {
    return {
      delivered: false,
      pending: true,
      retryAt: nextProactiveWindow(projectRoot),
      error: window.reason || "outside owner working hours",
    };
  }

  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const from = envTrim("TWILIO_PHONE_NUMBER");
  const to = ownerSmsPhone(projectRoot);
  const streamSecret = envTrim("TWILIO_MEDIA_STREAM_SECRET");
  const wssUrl = twilioMediaStreamWssUrl(streamSecret);
  if (!accountSid || !authToken || !from || !to || !wssUrl || !callbackSecret()) {
    return { delivered: false, error: "Twilio callback is not fully configured" };
  }

  const token = realtimeGoalVoiceToken(goal.id);
  const statusCallback = callbackStatusUrl(goal.id);
  if (!statusCallback) {
    return { delivered: false, error: "Twilio voice webhook URL cannot derive callback status URL" };
  }
  const voice = new twilio.twiml.VoiceResponse();
  const stream = voice.connect().stream({ url: wssUrl });
  // The called party is the configured owner; passphrase still gates disclosure.
  stream.parameter({ name: "caller", value: to });
  stream.parameter({ name: "ownerCaller", value: to });
  stream.parameter({ name: "realtimeGoalId", value: goal.id });
  stream.parameter({ name: "realtimeGoalToken", value: token });

  const client = twilio(accountSid, authToken);
  const call = await client.calls.create({
    from,
    to,
    twiml: voice.toString(),
    statusCallback,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });
  console.info(`[realtime-goals] PSTN callback queued goal=${goal.id} call=${call.sid}`);
  return { delivered: false, pending: true, providerId: call.sid };
}

export function registerRealtimeGoalVoiceRoutes(
  router: Router,
  broker: RealtimeGoalBroker,
  _publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  router.post(
    "/api/realtime-goals/voice/status",
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response) => {
      const goalId = typeof req.query.goalId === "string" ? req.query.goalId : "";
      const token = typeof req.query.token === "string" ? req.query.token : "";
      if (!goalId || !verifyRealtimeGoalStatusToken(goalId, token)) {
        res.status(403).send("bad goal token");
        return;
      }
      const signature = req.headers["x-twilio-signature"];
      const signedUrl = callbackStatusUrl(goalId, token);
      if (
        typeof signature !== "string" ||
        !signedUrl ||
        !twilio.validateRequest(
          envTrim("TWILIO_AUTH_TOKEN"),
          signature,
          signedUrl,
          req.body as Record<string, string>,
        )
      ) {
        res.status(403).send("bad signature");
        return;
      }
      const status = typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "";
      const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
      await broker.recordVoiceCallbackStatus(goalId, status, callSid);
      res.sendStatus(204);
    },
  );

  router.get("/api/realtime-goals/voice/result/:goalId", async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const goal = await broker.store.get(goalId);
    if (!goal || !voiceServiceAuthorized(req, goal)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    const text = goal?.resultSummary || goal?.lastBlockReason;
    if (!text || goal.status === "cancelled" || goal.delivery.state === "delivered") {
      res.status(404).json({ error: "goal result unavailable" });
      return;
    }
    res.json({
      goalId,
      text: text.slice(0, 4_000),
      kind: goal.status === "blocked" ? "blocked" : "completed",
    });
  });

  router.post("/api/realtime-goals/voice/result/:goalId/ack", async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const goal = await broker.store.get(goalId);
    if (!goal || !voiceServiceAuthorized(req, goal)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    await broker.markVoiceDelivered(goalId);
    res.json({ ok: true });
  });

  router.post(
    "/api/realtime-goals/voice/result/:goalId/reply",
    express.json({ limit: "32kb" }),
    async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const existing = await broker.store.get(goalId);
    if (!existing || !voiceServiceAuthorized(req, existing)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const sourceId =
      typeof req.body?.sourceId === "string" ? req.body.sourceId.trim() : "";
    if (!text || !sourceId) {
      res.status(400).json({ error: "text and sourceId are required" });
      return;
    }
    const goal = await broker.answerBlockedGoal(goalId, text, sourceId);
    if (!goal) {
      res.status(409).json({ error: "goal is no longer blocked" });
      return;
    }
      res.json({ ok: true, reply: goal.intakeReply });
    },
  );
}
