/**
 * Placeholder substitution for control-plane–composed owner emails.
 *
 * The CP has no way to read a box's live telephone settings (all traffic is
 * box-initiated heartbeat polling), and the owner can change the unlock
 * passphrase at any time in the Telephone app. So the CP queues copy containing
 * `{{think_passphrase}}` / `{{phone_number}}` tokens and the box fills in the
 * values it actually enforces, right before the send. The passphrase therefore
 * never leaves the box, and the email can never quote a stale value.
 */
import { readTelephoneStatus } from "./resolve.js";

/** Matches `{{name}}`, tolerating inner whitespace and any casing. */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type PlaceholderSubstitution = {
  /** Input texts with every resolvable placeholder replaced. */
  texts: string[];
  /** Placeholder names replaced with a live value (never the values themselves). */
  substituted: string[];
  /** Placeholders that are unknown, or known but unset on this box. */
  unresolved: string[];
};

function telephoneValues(projectRoot: string): Record<string, string> {
  const status = readTelephoneStatus(projectRoot);
  return {
    phone_number: status.phoneNumberDisplay,
    phone_number_e164: status.phoneNumber,
    think_passphrase: status.thinkPassword,
  };
}

/**
 * Substitute live telephone facts into CP-composed copy.
 *
 * Callers should refuse to send when `unresolved` is non-empty: shipping an
 * email with a literal `{{think_passphrase}}` in it, or with an empty value
 * where a passphrase belongs, is worse than failing the command loudly.
 */
export function substituteTelephonePlaceholders(
  texts: string[],
  projectRoot = process.cwd(),
): PlaceholderSubstitution {
  // Read once per call so a single email is internally consistent, while
  // successive sends still pick up owner changes without a restart.
  const values = telephoneValues(projectRoot);
  const substituted = new Set<string>();
  const unresolved = new Set<string>();

  const out = texts.map((text) =>
    text.replace(PLACEHOLDER_PATTERN, (match, rawName: string) => {
      const name = rawName.toLowerCase();
      const value = values[name];
      if (!value) {
        unresolved.add(name);
        return match;
      }
      substituted.add(name);
      return value;
    }),
  );

  return {
    texts: out,
    substituted: [...substituted].sort(),
    unresolved: [...unresolved].sort(),
  };
}
