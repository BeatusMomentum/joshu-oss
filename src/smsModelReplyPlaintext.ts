import { markdownSpeechPlaintext } from "./markdownSpeechPlaintext.js";

/** Owner-facing SMS text — markdown to plain only; DSML scrub happens in Hermes. */
export function smsModelReplyPlaintext(raw: string): string {
  return markdownSpeechPlaintext(raw).trim();
}
