/**
 * Twilio PSTN SMS gateway: inbound Messaging webhook → Hermes chat → SMS reply.
 * Owner-only (TWILIO_OWNER_CALLER). Uses the box subaccount credentials.
 */

import twilio from "twilio";
import type { Request, Router } from "express";
import express from "express";

import type { HermesApiRunner, HermesChatMessage } from "./hermesApi.js";
import { buildOwnerTimeSystemMessage } from "./ownerLocalTime.js";
import { markdownSpeechPlaintext } from "./markdownSpeechPlaintext.js";

const SMS_MAX_CHARS = 1500;

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

function normalizePublicBasePath(raw: string): string {
  if (!raw) return "";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return p.replace(/\/+$/, "") || "";
}

function smsInboundWebhookUrl(): string | undefined {
  const explicit = envTrim("TWILIO_SMS_WEBHOOK_URL");
  if (explicit) return explicit;
  const voice = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!voice) return undefined;
  return voice.replace(/\/voice\/inbound\/?$/, "/sms/inbound");
}

/** SMS is off unless subaccount creds, box number, owner allowlist, and webhook are set. */
export function twilioSmsGatewayEnabled(): boolean {
  return Boolean(
    envTrim("TWILIO_AUTH_TOKEN") &&
      envTrim("TWILIO_ACCOUNT_SID") &&
      envTrim("TWILIO_PHONE_NUMBER") &&
      envTrim("TWILIO_OWNER_CALLER") &&
      smsInboundWebhookUrl(),
  );
}

function signatureValidationUrls(req: Request, publicBasePath: string): string[] {
  const out = new Set<string>();
  const add = (raw?: string) => {
    const u = raw?.trim();
    if (!u) return;
    out.add(u);
    if (u.endsWith("/")) out.add(u.replace(/\/+$/, ""));
    else out.add(`${u}/`);
  };

  add(smsInboundWebhookUrl());

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
    add(`${proto}://${host}${base}/api/twilio/sms/inbound`);
  }

  return [...out];
}

function validateTwilioSmsSignature(
  authToken: string,
  signature: string,
  req: Request,
  publicBasePath: string,
): boolean {
  const params = req.body as Record<string, string>;
  for (const url of signatureValidationUrls(req, publicBasePath)) {
    if (twilio.validateRequest(authToken, signature, url, params)) return true;
  }
  return false;
}

function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // US 10-digit vs +1E164
  const stripCountry = (p: string) => (p.startsWith("+1") ? p.slice(2) : p.replace(/^\+/, ""));
  return stripCountry(na) === stripCountry(nb);
}

function keywordBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").toUpperCase();
}

async function sendSmsReply(to: string, body: string): Promise<void> {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = envTrim("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = envTrim("TWILIO_PHONE_NUMBER");
  const client = twilio(accountSid, authToken);
  const text = body.slice(0, SMS_MAX_CHARS);
  if (messagingServiceSid) {
    await client.messages.create({ to, messagingServiceSid, body: text });
  } else {
    await client.messages.create({ to, from: fromNumber, body: text });
  }
}

export function registerTwilioSmsRoutes(
  router: Router,
  runner: HermesApiRunner,
  publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  if (!twilioSmsGatewayEnabled()) {
    console.info(
      "[twilio-sms] disabled (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_OWNER_CALLER, TWILIO_SMS_WEBHOOK_URL or TWILIO_VOICE_WEBHOOK_URL)",
    );
    return;
  }

  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const ownerCaller = envTrim("TWILIO_OWNER_CALLER");
  const webhookUrl = smsInboundWebhookUrl()!;
  const systemPrompt =
    envTrim("TWILIO_SMS_SYSTEM_PROMPT") ||
    "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown, tables, or long URLs. Keep replies short enough for a text message.";

  router.post("/api/twilio/sms/inbound", express.urlencoded({ extended: false }), (req, res) => {
    const sig = req.headers["x-twilio-signature"];
    if (typeof sig !== "string") {
      res.status(403).send("missing signature");
      return;
    }
    if (!validateTwilioSmsSignature(authToken, sig, req, publicBasePath)) {
      console.warn("[twilio-sms] invalid Twilio signature");
      res.status(403).send("bad signature");
      return;
    }

    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const body = typeof req.body?.Body === "string" ? req.body.Body : "";
    const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid : "";
    console.info(`[twilio-sms] inbound from=${from} sid=${messageSid} body=${body.slice(0, 120)}`);

    // Ack immediately; reply via REST (long Hermes turn).
    res.type("text/xml").send("<Response></Response>");

    void (async () => {
      try {
        if (!phonesMatch(from, ownerCaller)) {
          await sendSmsReply(
            from,
            "Joshu SMS is owner-only. This number does not accept texts from unknown senders.",
          );
          return;
        }

        const kw = keywordBody(body);
        if (kw === "STOP" || kw === "STOPALL" || kw === "UNSUBSCRIBE" || kw === "CANCEL" || kw === "END" || kw === "QUIT") {
          await sendSmsReply(from, "You are unsubscribed from Joshu SMS. Reply START to opt back in.");
          return;
        }
        if (kw === "HELP" || kw === "INFO") {
          await sendSmsReply(
            from,
            "Joshu owner-only SMS with your box. Msg frequency varies. Reply STOP to cancel. Support: info@joshu.me",
          );
          return;
        }
        if (kw === "START" || kw === "YES" || kw === "UNSTOP") {
          await sendSmsReply(from, "Joshu SMS enabled for this number. Text your box anytime.");
          return;
        }
        if (!body.trim()) return;

        await runner.ensureGatewayReady();
        const sessionKey = `sms:${normalizePhone(from)}`;
        const messages: HermesChatMessage[] = [
          buildOwnerTimeSystemMessage(process.cwd()),
          { role: "system", content: systemPrompt },
          { role: "user", content: body.trim() },
        ];
        const { finalText } = await runner.streamHermesChat(
          {
            sessionId: sessionKey,
            sessionKey,
            messages,
            signal: AbortSignal.timeout(180_000),
          },
          {},
        );
        const reply = markdownSpeechPlaintext(finalText).trim();
        if (!reply) {
          await sendSmsReply(from, "I didn't have a reply for that — try again or reply HELP.");
          return;
        }
        await sendSmsReply(from, reply);
      } catch (err) {
        console.warn("[twilio-sms] inbound handler error:", err);
        try {
          await sendSmsReply(from, "Joshu hit an error processing that text. Please try again shortly.");
        } catch {
          /* ignore secondary failure */
        }
      }
    })();
  });

  router.get("/api/twilio/sms/health", (_req, res) => {
    res.json({
      ok: true,
      gateway: "twilio-sms",
      webhookUrlConfigured: Boolean(webhookUrl),
      ownerConfigured: Boolean(ownerCaller),
      messagingServiceConfigured: Boolean(envTrim("TWILIO_MESSAGING_SERVICE_SID")),
    });
  });

  console.info("[twilio-sms] webhook expects POST URL:", webhookUrl);
}
