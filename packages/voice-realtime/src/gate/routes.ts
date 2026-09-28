/**
 * Call gate: authenticate a PSTN caller with Twilio <Gather> (spoken passphrase
 * or keypad PIN) before any speech-to-speech model hears the call.
 *
 * The in-stream lock this replaces had the conversation model transcribe the
 * passphrase: unlock waited on the model's turn (3.7–8.7 s), 4 of 13 unlocks
 * were misheard, and the model's leftover reaction to the passphrase became
 * double greetings, silence, or a reply in Spanish (canary box 2026-09-26).
 *
 * Flow:
 *   Joshu /api/twilio/voice/inbound ─<Redirect>→ POST {gate}/start?mode=inbound&trusted=0|1
 *   Joshu owner callback TwiML      ─<Redirect>→ POST {gate}/start?mode=callback&batch=…&bt=…
 *   start → <Gather><Play greeting/></Gather> → POST {gate}/check → retry | lockout | voicemail
 *         → <Connect><Stream> with a single-use unlock token bound to the CallSid.
 *
 * Every request must carry a valid Twilio signature over its full URL, so the
 * query state (mode, attempts, trusted) is as trustworthy as the body. The
 * gate keeps no per-call state.
 */
import express, { type Request, type Response, type Router } from "express";

import { MEDIA_STREAM_SECRET } from "../config.js";
import { type LockPromptKey } from "../lockPrompts.js";
import { looksLikeVoicemailGreeting, matchesGatePassphrase, redactPassphrase } from "../phonePassphrase.js";
import { classifyUserTranscript } from "../userInputGate.js";
import { voiceLog, voiceWarn } from "../voiceLog.js";
import { gateClipWav, isGateClipKey, speakClip } from "./clips.js";
import {
  twilioAccountSid,
  twilioAuthToken,
  voiceGateHintsEnabled,
  voiceGateSpeechModel,
  voiceGateSpeechTimeout,
} from "./config.js";
import { reportCallbackOutcome } from "./joshu.js";
import { pinEntryLocked, recordPinFailure, verifyPin } from "./pin.js";
import { readGateSettings, samePhone, type GateSettings } from "./settings.js";
import { twimlResponse, type TwimlNode } from "./twiml.js";
import { mintUnlockToken, type GateMode, type UnlockVia } from "./unlockToken.js";
import { validateTwilioRequest } from "./twilioSignature.js";

/** Wrong passphrase / PIN entries before the call is hung up. */
export const MAX_GATE_ATTEMPTS = 3;
/** Gather rounds per call, counting silence and unclear speech (bounds a silent line). */
export const MAX_GATE_ROUNDS = 6;
/** Seconds of silence after the greeting before Twilio posts an empty result. */
const GATHER_TIMEOUT_S = 6;
/** Carrier-verified caller ID (STIR/SHAKEN full attestation). */
export const VERIFIED_CALLER_STATUS = "TN-Validation-Passed-A";

export const GATE_PATH_PREFIXES = ["/voice-rt/gate", "/gate", "/voice/gate"];

type GateQuery = {
  mode: GateMode;
  /** Wrong entries so far. */
  attempt: number;
  /** Gather rounds so far. */
  round: number;
  batchId?: string;
  batchToken?: string;
  ownerRequested: boolean;
};

type GateRequestContext = {
  callSid: string;
  from: string;
  body: Record<string, string>;
  /** Public base of the gate (e.g. https://box.example/voice-rt/gate), from the signed URL. */
  gateBaseUrl: string;
  query: GateQuery;
};

/** When the gate saw each call (log timings: greeting → check → stream). */
const gateTimings = new Map<string, number>();

function rememberGateStart(callSid: string, now = Date.now()): void {
  for (const [sid, at] of gateTimings) if (at < now - 30 * 60_000) gateTimings.delete(sid);
  if (!gateTimings.has(callSid)) gateTimings.set(callSid, now);
}

/** ms since the gate first answered this call (for stream-start logs), if known. */
export function msSinceGateStart(callSid: string, now = Date.now()): number | undefined {
  const at = gateTimings.get(callSid);
  return at === undefined ? undefined : now - at;
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

function parseQuery(query: Request["query"]): GateQuery {
  const int = (name: string) => {
    const n = Number.parseInt(firstString(query[name]), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const batchId = firstString(query.batch).trim();
  const batchToken = firstString(query.bt).trim();
  return {
    mode: firstString(query.mode) === "callback" ? "callback" : "inbound",
    attempt: int("attempt"),
    round: int("round"),
    ...(batchId ? { batchId } : {}),
    ...(batchToken ? { batchToken } : {}),
    ownerRequested: firstString(query.req) === "1",
  };
}

function queryString(query: GateQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    mode: query.mode,
    attempt: String(query.attempt),
    round: String(query.round),
    ...(query.batchId ? { batch: query.batchId } : {}),
    ...(query.batchToken ? { bt: query.batchToken } : {}),
    ...(query.ownerRequested ? { req: "1" } : {}),
    ...extra,
  });
  return params.toString();
}

/** Public origins Twilio may use for this box (besides the request's Host). */
function configuredPublicOrigins(): string[] {
  const origins: string[] = [];
  for (const name of ["JOSHU_VOICE_GATE_URL", "TWILIO_MEDIA_STREAM_WSS_URL", "TWILIO_VOICE_WEBHOOK_URL"]) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      const proto = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
      origins.push(`${proto}//${url.host}`);
    } catch {
      /* ignore malformed */
    }
  }
  return origins;
}

/** Twilio-signed request → context; undefined after the 403 is sent. */
function authenticate(req: Request, res: Response): GateRequestContext | undefined {
  const body = Object.fromEntries(
    Object.entries((req.body ?? {}) as Record<string, unknown>).map(([key, value]) => [key, firstString(value)]),
  );
  const matchedUrl = validateTwilioRequest(
    twilioAuthToken(),
    { originalUrl: req.originalUrl, headers: req.headers, body },
    configuredPublicOrigins(),
  );
  const callSid = body.CallSid ?? "";
  if (!matchedUrl) {
    voiceWarn(callSid || undefined, "gate", `rejected ${req.path} — bad Twilio signature`);
    res.status(403).type("text/plain").send("bad signature");
    return undefined;
  }
  const accountSid = twilioAccountSid();
  if (accountSid && body.AccountSid !== accountSid) {
    voiceWarn(callSid || undefined, "gate", `rejected ${req.path} — AccountSid mismatch`);
    res.status(403).type("text/plain").send("wrong account");
    return undefined;
  }
  const url = new URL(matchedUrl);
  const gatePath = url.pathname.replace(/\/[^/]*$/, "");
  return {
    callSid,
    from: body.From ?? "",
    body,
    gateBaseUrl: `${url.origin}${gatePath}`,
    query: parseQuery(req.query),
  };
}

function sendTwiml(res: Response, ...nodes: TwimlNode[]): void {
  res.type("text/xml").send(twimlResponse(...nodes));
}

function pinUsable(settings: GateSettings): boolean {
  return Boolean(settings.pinHash && settings.pinLength) && !pinEntryLocked();
}

/** Speech recognition hints: the whole passphrase and its words. */
function passphraseHints(passphrase: string): string | undefined {
  if (!voiceGateHintsEnabled() || !passphrase) return undefined;
  const phrase = passphrase.replace(/[,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const words = phrase.split(" ").filter((word) => word.length >= 3);
  return [...new Set([phrase, ...words])].join(", ");
}

function gather(ctx: GateRequestContext, settings: GateSettings, prompt: LockPromptKey): TwimlNode {
  const withPin = pinUsable(settings);
  const speechModel = voiceGateSpeechModel();
  const next: GateQuery = { ...ctx.query, round: ctx.query.round + 1 };
  return {
    verb: "Gather",
    attrs: {
      input: withPin ? "dtmf speech" : "speech",
      action: `${ctx.gateBaseUrl}/check?${queryString(next)}`,
      method: "POST",
      language: process.env.JOSHU_VOICE_GATE_LANGUAGE?.trim() || "en-US",
      hints: passphraseHints(settings.passphrase),
      speechTimeout: voiceGateSpeechTimeout(),
      speechModel: speechModel || undefined,
      timeout: GATHER_TIMEOUT_S,
      actionOnEmptyResult: "true",
      profanityFilter: "false",
      ...(withPin ? { numDigits: settings.pinLength, finishOnKey: "#" } : {}),
    },
    children: [speakClip(prompt, ctx.gateBaseUrl)],
  };
}

function greetingKey(mode: GateMode, withPin: boolean): LockPromptKey {
  if (mode === "callback") return withPin ? "callback_greeting_pin" : "callback_greeting";
  return withPin ? "greeting_pin" : "greeting";
}

/** Media stream URL for this box: the gate's public base with /media/<secret>. */
function mediaStreamUrl(gateBaseUrl: string): string {
  const url = new URL(gateBaseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/gate$/, "")}/media/${encodeURIComponent(MEDIA_STREAM_SECRET)}`;
  return url.toString();
}

function connectStream(ctx: GateRequestContext, settings: GateSettings, via: UnlockVia): TwimlNode {
  const token = mintUnlockToken({
    callSid: ctx.callSid,
    mode: ctx.query.mode,
    via,
    ...(ctx.query.batchId ? { batchId: ctx.query.batchId } : {}),
  });
  const parameter = (name: string, value: string | undefined): TwimlNode[] =>
    value ? [{ verb: "Parameter", attrs: { name, value } }] : [];
  // Callbacks dial the owner: "caller" is the number called.
  const caller = ctx.query.mode === "callback" ? ctx.body.To ?? "" : ctx.from;
  return {
    verb: "Connect",
    children: [
      {
        verb: "Stream",
        attrs: { url: mediaStreamUrl(ctx.gateBaseUrl) },
        children: [
          ...parameter("unlock", token),
          ...parameter("caller", caller.replace(/[^\d+]/g, "")),
          ...parameter("ownerCaller", settings.ownerCaller),
          ...parameter("realtimeGoalBatchId", ctx.query.batchId),
          ...parameter("realtimeGoalBatchToken", ctx.query.batchToken),
          ...parameter("ownerRequested", ctx.query.ownerRequested ? "1" : undefined),
        ],
      },
    ],
  };
}

function unlock(res: Response, ctx: GateRequestContext, settings: GateSettings, via: UnlockVia): void {
  voiceLog(ctx.callSid, "gate", `unlocked via=${via} mode=${ctx.query.mode}`, {
    msSinceGateStart: msSinceGateStart(ctx.callSid),
    attempts: ctx.query.attempt,
    rounds: ctx.query.round,
  });
  sendTwiml(res, connectStream(ctx, settings, via));
}

async function wrongEntry(
  res: Response,
  ctx: GateRequestContext,
  settings: GateSettings,
  detail: Record<string, unknown>,
): Promise<void> {
  const attempt = ctx.query.attempt + 1;
  voiceWarn(ctx.callSid, "gate", "wrong entry", { attempt, maxAttempts: MAX_GATE_ATTEMPTS, ...detail });
  if (attempt >= MAX_GATE_ATTEMPTS) {
    if (ctx.query.mode === "callback" && ctx.query.batchId && ctx.query.batchToken) {
      await reportCallbackOutcome(ctx.callSid, ctx.query.batchId, ctx.query.batchToken, "auth_failed");
    }
    voiceWarn(ctx.callSid, "gate", "locked out — hanging up");
    sendTwiml(res, speakClip("locked_out", ctx.gateBaseUrl), { verb: "Hangup" });
    return;
  }
  const next = { ...ctx, query: { ...ctx.query, attempt } };
  sendTwiml(res, gather(next, settings, attempt === MAX_GATE_ATTEMPTS - 1 ? "last_try" : "retry"));
}

function voicemailNotice(gateBaseUrl: string, pauseFirst: boolean): TwimlNode[] {
  return [
    ...(pauseFirst ? [{ verb: "Pause", attrs: { length: 1 } } as TwimlNode] : []),
    speakClip("voicemail_notice", gateBaseUrl),
    { verb: "Hangup" },
  ];
}

async function handleStart(req: Request, res: Response): Promise<void> {
  const ctx = authenticate(req, res);
  if (!ctx) return;
  rememberGateStart(ctx.callSid);
  const settings = readGateSettings();
  if (!settings.passphrase && !settings.pinHash) {
    voiceWarn(ctx.callSid, "gate", "no passphrase or PIN configured — refusing call");
    sendTwiml(res, { verb: "Hangup" });
    return;
  }
  const trustedClaim = firstString(req.query.trusted) === "1";
  if (
    ctx.query.mode === "inbound" &&
    trustedClaim &&
    settings.trustVerifiedCallerId &&
    samePhone(ctx.from, settings.ownerCaller)
  ) {
    unlock(res, ctx, settings, "trusted");
    return;
  }
  voiceLog(ctx.callSid, "gate", `greeting mode=${ctx.query.mode}`, {
    pin: pinUsable(settings),
    hints: Boolean(passphraseHints(settings.passphrase)),
    speechModel: voiceGateSpeechModel() || "default",
  });
  sendTwiml(res, gather(ctx, settings, greetingKey(ctx.query.mode, pinUsable(settings))));
}

async function handleCheck(req: Request, res: Response): Promise<void> {
  const ctx = authenticate(req, res);
  if (!ctx) return;
  const settings = readGateSettings();
  const digits = (ctx.body.Digits ?? "").trim();
  const speech = (ctx.body.SpeechResult ?? "").trim();
  const withPin = pinUsable(settings);

  if (digits && withPin) {
    if (verifyPin(digits, settings.pinHash)) {
      unlock(res, ctx, settings, "pin");
      return;
    }
    recordPinFailure();
    await wrongEntry(res, ctx, settings, { input: "pin", digits: digits.length });
    return;
  }

  if (speech) {
    if (ctx.query.mode === "callback" && looksLikeVoicemailGreeting(speech)) {
      voiceLog(ctx.callSid, "gate", "voicemail greeting — leaving a notice", { heard: speech.slice(0, 80) });
      if (ctx.query.batchId && ctx.query.batchToken) {
        await reportCallbackOutcome(ctx.callSid, ctx.query.batchId, ctx.query.batchToken, "voicemail");
      }
      sendTwiml(res, ...voicemailNotice(ctx.gateBaseUrl, true));
      return;
    }
    if (settings.passphrase && matchesGatePassphrase(speech, settings.passphrase)) {
      unlock(res, ctx, settings, "passphrase");
      return;
    }
    if (classifyUserTranscript(speech) === "clear") {
      await wrongEntry(res, ctx, settings, {
        input: "speech",
        heardPreview: redactPassphrase(speech, settings.passphrase).slice(0, 80),
        confidence: ctx.body.Confidence,
      });
      return;
    }
  }

  // Silence, a stray key, or unclear speech: ask again without spending an attempt.
  if (ctx.query.round >= MAX_GATE_ROUNDS) {
    voiceWarn(ctx.callSid, "gate", "no usable input — hanging up", { rounds: ctx.query.round });
    sendTwiml(res, { verb: "Hangup" });
    return;
  }
  voiceLog(ctx.callSid, "gate", "no usable input — asking again", {
    round: ctx.query.round,
    ...(speech ? { heardPreview: redactPassphrase(speech, settings.passphrase).slice(0, 80) } : {}),
    ...(digits ? { digits: digits.length } : {}),
  });
  sendTwiml(res, gather(ctx, settings, withPin ? "unclear_pin" : "unclear"));
}

/** Joshu redirects a callback here when answering-machine detection hears the beep. */
async function handleVoicemail(req: Request, res: Response): Promise<void> {
  const ctx = authenticate(req, res);
  if (!ctx) return;
  voiceLog(ctx.callSid, "gate", "voicemail (answering machine) — leaving a notice");
  sendTwiml(res, ...voicemailNotice(ctx.gateBaseUrl, false));
}

function handleClip(req: Request, res: Response): void {
  const key = String(req.params.key ?? "");
  const clip = isGateClipKey(key) ? gateClipWav(key) : null;
  if (!clip) {
    res.status(404).end();
    return;
  }
  res.set("Content-Type", "audio/wav");
  // URLs are versioned by content; an unversioned fetch must not be cached long.
  res.set("Cache-Control", req.query.v === clip.version ? "public, max-age=86400, immutable" : "no-cache");
  res.send(clip.wav);
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error: unknown) => {
      voiceWarn(undefined, "gate", `${req.path} failed`, { error: (error as Error).message });
      // Never leave Twilio without TwiML: a failed gate hangs up rather than letting anyone in.
      if (!res.headersSent) sendTwiml(res, { verb: "Hangup" });
    });
  };
}

export function createGateRouter(): Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: "64kb" });
  for (const prefix of GATE_PATH_PREFIXES) {
    router.post(`${prefix}/start`, form, wrap(handleStart));
    router.post(`${prefix}/check`, form, wrap(handleCheck));
    router.post(`${prefix}/voicemail`, form, wrap(handleVoicemail));
    router.get(`${prefix}/clips/:key.wav`, handleClip);
  }
  return router;
}
