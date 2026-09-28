/**
 * Twilio request signatures (X-Twilio-Signature), without the Twilio SDK.
 *
 * Twilio signs the full URL it requested plus the POST params, sorted by name
 * and concatenated as name+value, with HMAC-SHA1 over the account auth token.
 * Behind Caddy the URL we see is not the one Twilio used, so a few public-URL
 * candidates are tried; the one that matches is the trustworthy public URL of
 * this request (the gate builds its own action / clip URLs from it).
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[] | undefined>,
): string {
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? [...value].sort() : [value];
    for (const v of values) data += name + v;
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type SignatureRequest = {
  /** Path + query as received (`req.originalUrl`). */
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, string | string[] | undefined>;
};

function header(req: SignatureRequest, name: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").split(",")[0]!.trim();
}

/** Public URLs Twilio may have signed for this request. */
export function signatureUrlCandidates(req: SignatureRequest, publicOrigins: string[] = []): string[] {
  const out: string[] = [];
  const add = (url: string) => {
    if (url && !out.includes(url)) out.push(url);
  };
  const proto = header(req, "x-forwarded-proto") || "https";
  const hosts = [header(req, "x-forwarded-host"), header(req, "host")].filter(Boolean);
  const origins = [
    ...publicOrigins.map((origin) => origin.replace(/\/+$/, "")),
    ...hosts.map((host) => `${proto}://${host}`),
    // Twilio signs https URLs without the default port.
    ...hosts.map((host) => `${proto}://${host.replace(/:443$/, "")}`),
  ];
  const paths = [req.originalUrl];
  // A proxy that strips /voice-rt would hand us the bare path.
  if (!req.originalUrl.startsWith("/voice-rt/")) paths.push(`/voice-rt${req.originalUrl}`);
  for (const origin of origins) for (const path of paths) add(`${origin}${path}`);
  return out;
}

/**
 * The public URL whose signature matches, or undefined when none does (the
 * request did not come from Twilio on this account).
 */
export function validateTwilioRequest(
  authToken: string,
  req: SignatureRequest,
  publicOrigins: string[] = [],
): string | undefined {
  const signature = header(req, "x-twilio-signature");
  if (!authToken || !signature) return undefined;
  for (const url of signatureUrlCandidates(req, publicOrigins)) {
    if (safeEqual(computeTwilioSignature(authToken, url, req.body), signature)) return url;
  }
  return undefined;
}
