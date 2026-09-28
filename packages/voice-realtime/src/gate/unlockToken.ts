/**
 * Unlock tokens: the gate's proof that this call passed authentication.
 *
 * The media-stream URL (with its shared secret) sits in TwiML, so it alone must
 * never open an unlocked conversation. The gate mints a token bound to the
 * CallSid when the caller passes; the stream `start` must carry it. Tokens are
 * short-lived and single-use.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { twilioAuthToken } from "./config.js";

export const UNLOCK_TOKEN_TTL_MS = 2 * 60_000;

export type GateMode = "inbound" | "callback";
/** How the caller got through: spoken passphrase, keypad PIN, or verified caller ID. */
export type UnlockVia = "passphrase" | "pin" | "trusted";

export type UnlockClaims = {
  callSid: string;
  mode: GateMode;
  via: UnlockVia;
  batchId?: string;
  expiresAt: number;
};

/** Per-process fallback so a box without an auth token still never accepts a forged token. */
const processKey = randomBytes(32);

function signingKey(): Buffer {
  const authToken = twilioAuthToken();
  if (!authToken) return processKey;
  return createHmac("sha256", authToken).update("joshu-voice-unlock-v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function mintUnlockToken(
  claims: Omit<UnlockClaims, "expiresAt">,
  now = Date.now(),
): string {
  const payload = [
    "v1",
    claims.callSid,
    claims.mode,
    claims.via,
    claims.batchId ?? "",
    String(now + UNLOCK_TOKEN_TTL_MS),
  ].join("|");
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

const used = new Map<string, number>();

function forgetExpired(now: number): void {
  for (const [token, expiresAt] of used) if (expiresAt <= now) used.delete(token);
}

/**
 * Claims when `token` is authentic, unexpired, unused, and minted for `callSid`.
 * A successful check consumes the token.
 */
export function redeemUnlockToken(
  token: string,
  callSid: string,
  now = Date.now(),
): UnlockClaims | undefined {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return undefined;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  const [version, sid, mode, via, batchId, expires] = payload.split("|");
  const expiresAt = Number(expires);
  if (version !== "v1" || !sid || sid !== callSid) return undefined;
  if (mode !== "inbound" && mode !== "callback") return undefined;
  if (via !== "passphrase" && via !== "pin" && via !== "trusted") return undefined;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  forgetExpired(now);
  if (used.has(token)) return undefined;
  used.set(token, expiresAt);
  return { callSid: sid, mode, via, ...(batchId ? { batchId } : {}), expiresAt };
}
