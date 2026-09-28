/**
 * Twilio PSTN voice webhook. Inbound calls are validated here and redirected to
 * the voice-realtime call gate (see voiceGate.ts); Joshu no longer terminates
 * Media Streams itself.
 */

import twilio from "twilio";
import type { Request, Router } from "express";
import express from "express";

import type { HermesApiRunner } from "./hermesApi.js";
import { resolveOwnerCaller, resolveThinkPassword } from "./telephoneSettings/resolve.js";
import { readTelephoneSettingsFile } from "./telephoneSettings/store.js";
import { callerTrustedForGate, gateRedirectTwiml, voiceGateUrl } from "./voiceGate.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function normalizePublicBasePath(raw: string): string {
  if (!raw) return "";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return p.replace(/\/+$/, "") || "";
}

function mediaStreamHttpPath(publicBasePath: string): string {
  const base = normalizePublicBasePath(publicBasePath);
  return `${base}/api/twilio/media-stream`;
}

/** Token in the URL path survives ngrok/proxy WebSocket upgrades that drop query strings. */
function mediaStreamPathWithToken(publicBasePath: string, secret: string): string {
  const enc = encodeURIComponent(secret);
  return `${mediaStreamHttpPath(publicBasePath)}/${enc}`;
}

/**
 * Full HTTPS URL configured in Twilio console for POST /voice/inbound (must match signature validation exactly).
 */
function voiceInboundWebhookUrl(): string | undefined {
  const u = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  return u || undefined;
}

export function twilioMediaStreamWssUrl(
  secret: string,
  publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): string | undefined {
  const explicit = envTrim("TWILIO_MEDIA_STREAM_WSS_URL");
  if (explicit) {
    try {
      const u = new URL(explicit);
      u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
      u.hash = "";
      const hasQueryToken = u.searchParams.has("token");
      const isVoiceGatewayPath =
        u.pathname.includes("/voice/media") || u.pathname.includes("/voice-rt/media");
      if (hasQueryToken || isVoiceGatewayPath) {
        return u.toString();
      }
      u.search = "";
      const base = mediaStreamHttpPath(publicBasePath);
      if (u.pathname === base || u.pathname.endsWith("/media-stream")) {
        u.pathname = mediaStreamPathWithToken(publicBasePath, secret);
      } else if (!u.pathname.endsWith(`/${encodeURIComponent(secret)}`)) {
        u.pathname = `${u.pathname.replace(/\/$/, "")}/${encodeURIComponent(secret)}`;
      }
      return u.toString();
    } catch {
      return undefined;
    }
  }
  const hook = voiceInboundWebhookUrl();
  if (!hook) return undefined;
  try {
    const u = new URL(hook);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = mediaStreamPathWithToken(publicBasePath, secret);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Strip wrapping quotes — instance.env often stores `TWILIO_THINK_PASSWORD="Falken's Maze"`. */
function twilioThinkPassword(): string {
  return resolveThinkPassword();
}

/**
 * PSTN is off unless auth + stream secret + webhook + think passphrase are all set.
 * No passphrase → no inbound voice routes (open phone without a gate is not allowed).
 */
function twilioGatewayEnabled(): boolean {
  return Boolean(
    envTrim("TWILIO_AUTH_TOKEN") &&
      envTrim("TWILIO_MEDIA_STREAM_SECRET") &&
      voiceInboundWebhookUrl() &&
      twilioThinkPassword(),
  );
}

/** URLs Twilio may have signed (console URL, env, trailing slash, ngrok forwarded host). */
function signatureValidationUrls(req: Request, publicBasePath: string): string[] {
  const out = new Set<string>();
  const add = (raw?: string) => {
    const u = raw?.trim();
    if (!u) return;
    out.add(u);
    if (u.endsWith("/")) out.add(u.replace(/\/+$/, ""));
    else out.add(`${u}/`);
  };

  add(voiceInboundWebhookUrl());

  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
      : undefined) || "https";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0]?.trim()
      : undefined) ||
    (typeof req.headers.host === "string" ? req.headers.host : "");
  if (host) {
    const base = normalizePublicBasePath(publicBasePath);
    add(`${proto}://${host}${base}/api/twilio/voice/inbound`);
  }

  return [...out];
}

export function validateTwilioVoiceSignature(
  authToken: string,
  signature: string,
  req: Request,
  publicBasePath: string,
): { ok: boolean; matchedUrl?: string; tried: string[] } {
  const params = req.body as Record<string, string>;
  const tried = signatureValidationUrls(req, publicBasePath);
  for (const url of tried) {
    if (twilio.validateRequest(authToken, signature, url, params)) {
      return { ok: true, matchedUrl: url, tried };
    }
  }
  return { ok: false, tried };
}

export function registerTwilioVoiceRoutes(
  router: Router,
  runner: HermesApiRunner,
  publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  if (!twilioGatewayEnabled()) {
    console.info(
      "[twilio-phone] disabled (set TWILIO_AUTH_TOKEN, TWILIO_MEDIA_STREAM_SECRET, TWILIO_VOICE_WEBHOOK_URL, TWILIO_THINK_PASSWORD)",
    );
    return;
  }

  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const webhookFullUrl = voiceInboundWebhookUrl()!;
  const secret = envTrim("TWILIO_MEDIA_STREAM_SECRET");
  const wssUrl = twilioMediaStreamWssUrl(secret, publicBasePath);
  if (!wssUrl) {
    console.warn("[twilio-phone] could not build media stream WSS URL");
    return;
  }

  router.post("/api/twilio/voice/inbound", express.urlencoded({ extended: false }), (req, res) => {
    const sig = req.headers["x-twilio-signature"];
    if (typeof sig !== "string") {
      res.status(403).send("missing signature");
      return;
    }
    const validation = validateTwilioVoiceSignature(authToken, sig, req, publicBasePath);
    if (!validation.ok) {
      console.warn(
        "[twilio-phone] invalid Twilio signature (check TWILIO_AUTH_TOKEN = Primary Auth Token for this account, and Twilio console voice URL matches TWILIO_VOICE_WEBHOOK_URL exactly)",
      );
      console.warn("[twilio-phone] configured webhook:", webhookFullUrl);
      console.warn("[twilio-phone] signature URLs tried:", validation.tried.join(" | "));
      res.status(403).send("bad signature");
      return;
    }
    if (validation.matchedUrl && validation.matchedUrl !== webhookFullUrl) {
      console.info("[twilio-phone] signature ok via URL:", validation.matchedUrl);
    }

    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const ownerCaller = resolveOwnerCaller();
    console.info(`[twilio-phone] inbound voice callSid=${callSid} from=${from}`);

    // Call gate: voice-realtime authenticates the caller (passphrase / PIN) before
    // any model hears the call. Caller-ID trust is decided here, where Twilio's
    // original STIR/SHAKEN verdict is available; the redirect URL is signed by
    // Twilio on the way in, so voice-realtime can rely on it.
    const stirVerstat = typeof req.body?.StirVerstat === "string" ? req.body.StirVerstat : "";
    const trusted = callerTrustedForGate({
      from,
      stirVerstat,
      ownerCaller,
      trustVerifiedCallerId: readTelephoneSettingsFile().trustVerifiedCallerId === true,
    });
    const gateUrl = voiceGateUrl("start", { mode: "inbound", trusted: trusted ? "1" : "0" });
    if (!gateUrl) {
      console.error("[twilio-phone] no call gate URL — set TWILIO_MEDIA_STREAM_WSS_URL (or JOSHU_VOICE_GATE_URL)");
      res.type("text/xml").send("<Response><Say>This line is not available right now.</Say><Hangup/></Response>");
      return;
    }
    console.info(`[twilio-phone] inbound callSid=${callSid} → call gate trusted=${trusted} stir=${stirVerstat || "-"}`);
    res.type("text/xml").send(gateRedirectTwiml(gateUrl));
  });

  router.get("/api/twilio/health", async (_req, res) => {
    try {
      await runner.ensureGatewayReady();
      res.json({
        ok: true,
        gateway: "twilio",
        hermesReady: true,
        webhookUrlConfigured: Boolean(webhookFullUrl),
        mediaStreamConfigured: Boolean(wssUrl),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        gateway: "twilio",
        hermesReady: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  console.info("[twilio-phone] voice webhook expects POST URL:", webhookFullUrl);
  console.info(
    "[twilio-phone] media stream WSS:",
    wssUrl.replace(/token=[^&]+/, "token=(redacted)").replace(encodeURIComponent(secret), "(redacted)"),
  );
}
