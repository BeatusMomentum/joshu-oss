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
  if (Date.now() > expiresAtMs) {
    return { ok: false, reason: "link_expired" };
  }
  const expected = mintHandoffToken(handoffId, expiresAtMs);
  if (!safeEqual(expected, token)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, expiresAtMs };
}
