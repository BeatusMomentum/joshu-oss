import { markdownSpeechPlaintext } from "./markdownSpeechPlaintext.js";
import {
  looksLikeLeakedModelOutput,
  scrubHermesAssistantContent,
} from "./hermesStreamContentScrubber.js";

export {
  looksLikeLeakedModelOutput,
  looksLikeLeakedModelOutput as looksLikeSmsModelLeak,
  stripLeakedModelMarkup,
  HermesStreamContentScrubber,
  scrubHermesAssistantContent,
} from "./hermesStreamContentScrubber.js";

/** Owner-facing SMS text from a Hermes completion — strips markdown + model leaks. */
export function smsModelReplyPlaintext(raw: string): string {
  const stripped = scrubHermesAssistantContent(raw);
  const plain = markdownSpeechPlaintext(stripped).trim();
  if (looksLikeLeakedModelOutput(plain)) return "";
  return plain;
}
