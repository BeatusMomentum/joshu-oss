import { createHmac, timingSafeEqual } from "node:crypto";

function handoffLinkSecret(): string {
  return (
    process.env.JOSHU_BROWSER_HANDOFF_SECRET?.trim() ||
    process.env.JOSHU_OWNER_CHANNEL_APPROVAL_SECRET?.trim() ||
    process.env.JOSHU_OWNER_CHANNEL_SLACK_SIGNING_SECRET?.trim() ||
    "joshu-local-browser-handoff"
  );
}

function signPayload(payload: string): string {
  return createHmac("sha256", handoffLinkSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function mintHandoffToken(handoffId: string, expiresAtMs: number): string {
  const exp = String(expiresAtMs);
  return signPayload(`${handoffId}.${exp}`);
}

/** Cookie proving the owner typed box username/password for this handoff. */
export const HANDOFF_AUTH_COOKIE = "joshu_handoff_auth";

export function mintHandoffAuthToken(handoffId: string, expiresAtMs: number): string {
  return signPayload(`handoff-reauth.${handoffId}.${expiresAtMs}`);
}

export function verifyHandoffAuthToken(
  handoffId: string,
  expRaw: string,
  token: string,
): { ok: true; expiresAtMs: number } | { ok: false; reason: string } {
  if (!handoffId || !expRaw || !token) {
    return { ok: false, reason: "missing_parameters" };
  }
  const expiresAtMs = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: "invalid_expiry" };
  }
  // Wall-clock expiry is the handoff *record* (heartbeats extend it). The
  // signed exp is only bound into the HMAC so the URL cannot be retargeted.
  const expected = mintHandoffAuthToken(handoffId, expiresAtMs);
  if (!safeEqual(expected, token)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, expiresAtMs };
}

export function readCookieValue(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return "";
}

export function verifyHandoffToken(
  handoffId: string,
  expRaw: string,
  token: string,
): { ok: true; expiresAtMs: number } | { ok: false; reason: string } {
  if (!handoffId || !expRaw || !token) {
    return { ok: false, reason: "missing_parameters" };
  }
  const expiresAtMs = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: "invalid_expiry" };
  }
  // Live expiry is getHandoffRecord() → expired/pending. Heartbeats extend
  // the record past the original URL exp; HMAC still requires the signed exp.
  const expected = mintHandoffToken(handoffId, expiresAtMs);
  if (!safeEqual(expected, token)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, expiresAtMs };
}
