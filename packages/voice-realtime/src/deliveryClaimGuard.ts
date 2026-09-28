/**
 * "The link has been texted" — said on a call on the canary box (2026-09-26)
 * while nothing had been sent. Sends are facts Joshu records (`delivered` on
 * think results); the model saying so is not one.
 *
 * The guard watches what the model says while a think job is still running.
 * A send claimed then is logged (`ANTIPATTERN delivery-claim-before-result`),
 * and if the result shows nothing was sent, the model is told to correct it.
 */
import type { DeliveredFact } from "./brainThink.js";

const CLAIM_PATTERNS: RegExp[] = [
  /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+|already\s+)?(texted|sent|emailed|e-mailed|messaged|forwarded|booked|scheduled)\b/i,
  /\b(?:it|that|the (?:link|details|confirmation|email|text))(?:'s| is| has been| was)\s+(?:just\s+|already\s+)?(texted|sent|emailed|booked|scheduled)\b/i,
  /\b(?:you(?:'ll| will| should)?\s+(?:get|have|see|find))\s+(?:a|the|an)\s+(text|email|message)\s+(?:from me\s+)?(?:with|shortly|now|in a moment)/i,
];

/** The send the model just claimed ("texted", "emailed", …), if any. */
export function detectDeliveryClaim(text: string): string | undefined {
  for (const pattern of CLAIM_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

/**
 * Correction for a claim made before the result, or undefined when the result
 * backs it (Joshu sent something, or the answer itself reports a send its tools
 * made).
 */
export function claimCorrection(
  claims: string[],
  answer: string,
  delivered: DeliveredFact[] | undefined,
): string | undefined {
  if (claims.length === 0) return undefined;
  if (delivered?.some((fact) => fact.ok)) return undefined;
  if (detectDeliveryClaim(answer)) return undefined;
  return (
    `Correction: while this was running you told the owner it was already ${claims[0]} — nothing was sent. ` +
    `Say so plainly in one short sentence (for example "Sorry, I haven't actually sent that yet."), then relay the answer.`
  );
}
