/**
 * Did the owner actually hear a result? Compare what the model said aloud with
 * the result's key facts.
 *
 * The old ack fired only when Joshu's own inject turn finished playing. On the
 * 2026-09-26 Cancun callback the model relayed the result in a turn it started
 * itself, the ack never fired, and the same result was called in again 15
 * minutes later. Coverage does not care which turn spoke it — including a
 * result the model relayed from the background context.
 */

/** Key facts compared (the first ones in the result are the headline). */
const MAX_KEY_TOKENS = 6;
/** Share of key facts that must appear in the spoken text. */
const COVERAGE_THRESHOLD = 0.5;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "are", "was",
  "were", "will", "have", "has", "had", "into", "onto", "then", "than", "them", "they",
  "about", "after", "before", "when", "what", "which", "while", "there", "their",
  "here", "just", "only", "also", "each", "every", "some", "more", "most", "less",
  "cheapest", "option", "options", "found", "price", "prices", "total", "flight",
  "flights", "nonstop", "stop", "stops",
]);

/**
 * Digit runs of 2+ characters: "$1,234.50" → "1234", "50"; "7:40" → "40".
 * Years are dropped — results carry them, speech rarely does.
 */
function numericTokens(text: string): string[] {
  const normalized = text.replace(/(\d),(\d{3})/g, "$1$2");
  return (normalized.match(/\d{2,}/g) ?? [])
    .filter((token) => !/^(?:19|20)\d{2}$/.test(token))
    .map((token) => token.replace(/^0+(?=\d)/, ""));
}

/** Capitalized / distinctive words (names, places) for results without numbers. */
function wordTokens(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (!/^[A-Z]/.test(word) && !/[A-Z]/.test(word.slice(1))) continue;
    out.push(lower);
  }
  return out;
}

function unique(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

/** The facts a spoken relay of `result` must contain. */
export function keyTokens(result: string): { kind: "numeric" | "words"; tokens: string[] } {
  const numeric = unique(numericTokens(result)).slice(0, MAX_KEY_TOKENS);
  if (numeric.length >= 2) return { kind: "numeric", tokens: numeric };
  const words = unique(wordTokens(result)).slice(0, MAX_KEY_TOKENS);
  return { kind: "words", tokens: [...numeric, ...words].slice(0, MAX_KEY_TOKENS) };
}

/** Fraction of the result's key facts present in what was spoken (0 when it has none). */
export function spokenCoverage(result: string, spoken: string): number {
  const { kind, tokens } = keyTokens(result);
  if (tokens.length === 0) return 0;
  const said = new Set(
    kind === "numeric"
      ? numericTokens(spoken)
      : [...numericTokens(spoken), ...spoken.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []],
  );
  const hits = tokens.filter((token) => said.has(token)).length;
  return hits / tokens.length;
}

export function spokenCovers(result: string, spoken: string): boolean {
  return spokenCoverage(result, spoken) >= COVERAGE_THRESHOLD;
}
