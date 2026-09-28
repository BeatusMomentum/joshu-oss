/**
 * Keypad PIN check. The Telephone app stores only a salted scrypt hash
 * (`scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, see src/telephoneSettings on
 * the Joshu side). A short PIN is guessable across many calls, so failed PIN
 * entries are also counted box-wide: past the limit, the keypad is turned off
 * for a while and only the spoken passphrase works.
 */
import { scryptSync, timingSafeEqual } from "node:crypto";

export function verifyPin(pin: string, stored: string | undefined): boolean {
  if (!stored || !/^\d{4,8}$/.test(pin)) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((value) => Number.isInteger(value) && value > 0)) return false;
  const expected = Buffer.from(hashB64, "base64");
  try {
    const actual = scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Failed PIN entries (all calls) allowed per window before the keypad is disabled. */
export const PIN_FAILURE_LIMIT = 10;
export const PIN_FAILURE_WINDOW_MS = 60 * 60_000;

const failures: number[] = [];

function prune(now: number): void {
  while (failures.length && failures[0]! <= now - PIN_FAILURE_WINDOW_MS) failures.shift();
}

export function recordPinFailure(now = Date.now()): void {
  prune(now);
  failures.push(now);
}

/** True while too many wrong PINs were entered recently. */
export function pinEntryLocked(now = Date.now()): boolean {
  prune(now);
  return failures.length >= PIN_FAILURE_LIMIT;
}

/** Tests only. */
export function resetPinFailures(): void {
  failures.length = 0;
}
