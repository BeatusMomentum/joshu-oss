/**
 * Serialize owner SMS Hermes turns per phone number.
 *
 * Twilio ACKs webhooks immediately and processes each inbound in a fire-and-forget
 * task. Without a mutex, a second text while streamHermesChat is in flight hits the
 * same Hermes session concurrently — history gets injected mid-turn and the owner
 * can receive partial/wrong replies out of order.
 */

import { normalizePhone } from "./twilioSmsSend.js";

const ownerSmsChains = new Map<string, Promise<unknown>>();

function mutexKey(ownerPhone: string): string {
  return normalizePhone(ownerPhone) || ownerPhone.trim();
}

/** Run async work when no other SMS Hermes turn is active for this owner. */
export function withOwnerSmsMutex<T>(ownerPhone: string, work: () => Promise<T>): Promise<T> {
  const key = mutexKey(ownerPhone);
  if (!key) return work();

  const previous = ownerSmsChains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  ownerSmsChains.set(key, tail);
  void tail.finally(() => {
    if (ownerSmsChains.get(key) === tail) {
      ownerSmsChains.delete(key);
    }
  });
  return run;
}
