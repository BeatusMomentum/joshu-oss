/**
 * Call gate hand-off.
 *
 * voice-realtime authenticates PSTN callers with Twilio <Gather> before any
 * model hears the call (packages/voice-realtime/src/gate/). Joshu keeps the
 * Twilio number webhooks and the owner outbox; it just redirects calls there:
 * inbound calls from /api/twilio/voice/inbound, owner callbacks from their
 * TwiML, and answering-machine hits to the voicemail notice.
 */
import { normalizeOwnerMobile } from "./telephoneSettings/resolve.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Carrier-verified caller ID: STIR/SHAKEN full ("A") attestation. */
export const VERIFIED_CALLER_STATUS = "TN-Validation-Passed-A";

/**
 * Public base of the gate, e.g. `https://box.example/voice-rt/gate`:
 * `JOSHU_VOICE_GATE_URL`, else next to the voice-realtime media stream URL,
 * else `/voice-rt/gate` on the voice webhook's host.
 */
export function voiceGateBaseUrl(): string | undefined {
  const explicit = envTrim("JOSHU_VOICE_GATE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const media = envTrim("TWILIO_MEDIA_STREAM_WSS_URL");
  if (media) {
    try {
      const url = new URL(media);
      const match = url.pathname.match(/^(.*\/(?:voice-rt|voice))\/media(?:\/|$)/);
      if (match) {
        const proto = url.protocol === "ws:" || url.protocol === "http:" ? "http:" : "https:";
        return `${proto}//${url.host}${match[1]}/gate`;
      }
    } catch {
      /* fall through */
    }
  }
  const webhook = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!webhook) return undefined;
  try {
    return `${new URL(webhook).origin}/voice-rt/gate`;
  } catch {
    return undefined;
  }
}

export function voiceGateUrl(
  path: "start" | "voicemail",
  params: Record<string, string | undefined>,
): string | undefined {
  const base = voiceGateBaseUrl();
  if (!base) return undefined;
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return `${base}/${path}?${query.toString()}`;
}

/**
 * Inbound caller may skip the passphrase: the owner opted in, the call comes
 * from the owner's mobile, and the carrier fully attested that caller ID.
 * voice-realtime re-checks the opt-in and number before honoring it.
 */
export function callerTrustedForGate(input: {
  from: string;
  stirVerstat: string;
  ownerCaller: string;
  trustVerifiedCallerId: boolean;
}): boolean {
  if (!input.trustVerifiedCallerId || !input.ownerCaller) return false;
  if (input.stirVerstat.trim() !== VERIFIED_CALLER_STATUS) return false;
  const from = normalizeOwnerMobile(input.from);
  return Boolean(from) && from === normalizeOwnerMobile(input.ownerCaller);
}

/** TwiML that hands the call to the gate. */
export function gateRedirectTwiml(url: string): string {
  const escaped = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${escaped}</Redirect></Response>`;
}
