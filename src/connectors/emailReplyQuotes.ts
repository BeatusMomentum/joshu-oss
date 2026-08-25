/**
 * Strip quoted reply tails from email bodies before EA classification.
 * Quote-heavy replies (short ask + long companion FYI) otherwise get disposition=info.
 */

const ON_WROTE_RE =
  /\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{0,200}?wrote:\s*\n/i;

const ORIGINAL_MESSAGE_RE = /\n[-_]{2,}\s*Original Message\s*[-_]{2,}/i;

const OUTLOOK_FROM_BLOCK_RE = /\nFrom:\s+.+\nSent:\s+/i;

/** Pure acks — safe to leave as disposition=info on owner→agent Nylas. */
const PURE_ACK_RE =
  /^(thanks|thank you|thx|ty|got it|ok|okay|sounds good|perfect|great|lgtm|will do|noted|👍|🙏)([!.\s]*)$/i;

/**
 * Keep only the sender's new text above common reply-quote markers.
 * Does not touch leading content; returns trimmed original when no marker found.
 */
export function stripEmailReplyQuotes(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  if (!t.trim()) return "";

  for (const re of [ON_WROTE_RE, ORIGINAL_MESSAGE_RE, OUTLOOK_FROM_BLOCK_RE]) {
    const m = re.exec(t);
    if (m?.index != null && m.index > 0) {
      t = t.slice(0, m.index);
    }
  }

  // Drop a trailing run of >-quoted lines (common plain-text quotes).
  const lines = t.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  let quoteRun = 0;
  while (end - quoteRun > 0 && /^\s*>/.test(lines[end - quoteRun - 1]!)) quoteRun += 1;
  if (quoteRun > 0) end -= quoteRun;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  t = lines.slice(0, end).join("\n");

  return t.trim();
}

/** True when the (already quote-stripped) body is an empty or ack-only note. */
export function isPureAckOrEmptyBody(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 80) return false;
  return PURE_ACK_RE.test(t);
}
