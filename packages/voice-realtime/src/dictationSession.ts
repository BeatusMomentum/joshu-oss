/**
 * Voice dictation sessions — buffer multi-turn speech, then one Hermes write.
 *
 * S2S alone fails on list/note dictation: each pause ends a turn, the model stays
 * organic, and nothing reaches the brain. Joshu owns the buffer while active.
 */

export type DictationFormat = "cleanup" | "reformulate" | "auto";

export type DictationSessionState = {
  active: boolean;
  /** Where to store — file name, path hint, or short label (Hermes resolves). */
  destination: string;
  format: DictationFormat;
  /** Optional title / document heading. */
  title?: string;
  /** Verbatim STT chunks in order (pauses between items are fine). */
  chunks: string[];
  startedAtMs: number;
};

/** User said they are done dictating (while a session is already open). */
const DICTATION_DONE_RE =
  /\b(that'?s\s+(it|all|everything)(\s+for\s+now)?|i'?m\s+done|all\s+done|end\s+of\s+(the\s+)?(list|notes?|dictation)|finish(ed)?\s+(dictat|the\s+list)|stop\s+dictat)\b/i;

/**
 * Explicit dump preamble — dictation starts only on this, never on inferred
 * task intent ("calendar reminders", "make a list of websites").
 * Example: "I am about to tell you a bunch of things so just wait for me to finish."
 */
const DICTATION_START_RE = new RegExp(
  [
    String.raw`\b(start|begin)\s+(a\s+)?dictation\b`,
    String.raw`\btake\s+(this|these|a)\s+(down|dictation)\b`,
    String.raw`\bbrain[\s-]?dump\b`,
    String.raw`\bdon'?t\s+interrupt\b`,
    String.raw`\bjust\s+listen\b`,
    String.raw`\bjust\s+wait(\s+(for\s+me|until|till|while))\b`,
    String.raw`\bwait\s+(until|till|for)\s+(i'?m\s+(done|finished)|i\s+finish|me\s+to\s+finish)\b`,
    String.raw`\bwait\s+for\s+me\s+to\s+finish\b`,
    String.raw`\blet\s+me\s+(finish|dump|rattle|list|get\s+(this|it)\s+out)\b`,
    String.raw`\bi('?m|\s+am)\s+(about\s+to|gonna|going\s+to)\s+(list|dump|rattle|dictate)\b`,
    String.raw`\bi('?m|\s+am)\s+(about\s+to|gonna|going\s+to)\s+(tell|give|read)\s+(you\s+)?(a\s+)?(bunch|list|several|lot)\b`,
    String.raw`\bwrite\s+(this|these|it)\s+down\s+(as\s+i|while\s+i)\b`,
    String.raw`\bhold\s+on\s+while\s+i\s+(list|give|tell|dump|rattle)\b`,
    String.raw`\bi'?ll\s+(give|list|tell|dump|rattle)\s+(you\s+)?(a\s+)?(bunch|list|several)\b`,
    String.raw`\ba\s+bunch\s+of\s+(things|items|reminders|notes|sites|urls)\b.{0,48}\b(wait|listen|finish|done|interrupt)\b`,
    String.raw`\b(wait|listen|finish|done|interrupt).{0,48}\ba\s+bunch\s+of\s+(things|items|reminders|notes)\b`,
  ].join("|"),
  "i",
);

/** Tool-output copy when start_dictation is rejected (model should think instead). */
export const DICTATION_NOT_EXPLICIT_MESSAGE =
  "The caller did not explicitly start a dictation dump. Do not buffer. Use think for this request (calendar, reminders, a single note, lookup). Only call start_dictation when they clearly ask you to wait/listen until they finish a bunch of items — e.g. \"I am about to tell you a bunch of things, just wait for me to finish.\"";

export function parseDictationFormat(raw: unknown): DictationFormat {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "cleanup" || s === "list" || s === "lists") return "cleanup";
  if (s === "reformulate" || s === "rewrite" || s === "notes" || s === "meeting") {
    return "reformulate";
  }
  return "auto";
}

export function createDictationSession(params: {
  destination: string;
  format?: unknown;
  title?: string;
}): DictationSessionState {
  const destination = params.destination.trim() || "Desktop note";
  return {
    active: true,
    destination,
    format: parseDictationFormat(params.format),
    title: params.title?.trim() || undefined,
    chunks: [],
    startedAtMs: Date.now(),
  };
}

export function appendDictationChunk(
  session: DictationSessionState,
  text: string,
): DictationSessionState {
  const t = text.trim();
  if (!t || !session.active) return session;
  // Skip pure done-phrases from the content buffer — they close the session.
  if (looksLikeDictationDone(t) && session.chunks.length > 0) return session;
  return { ...session, chunks: [...session.chunks, t] };
}

export function looksLikeDictationDone(text: string): boolean {
  return DICTATION_DONE_RE.test(text.trim());
}

/** True when the speaker asked Joshu to wait/listen through a multi-item dump. */
export function looksLikeExplicitDictationStart(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return DICTATION_START_RE.test(t);
}

/** STT-only gate: ignore model-invented user_quote; check recent user lines. */
export function recentUserSpeechLooksLikeDictationStart(
  texts: Array<string | undefined | null>,
): boolean {
  return looksLikeExplicitDictationStart(
    texts
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .join("\n"),
  );
}

export function formatGuidance(format: DictationFormat): string {
  switch (format) {
    case "cleanup":
      return [
        "Format style: CLEANUP.",
        "Light edit only — normalize spelling of URLs/names, dedupe, use a clean bullet or numbered list.",
        "Do not invent items. Do not add commentary. Preserve the speaker's order.",
      ].join(" ");
    case "reformulate":
      return [
        "Format style: REFORMULATE.",
        "Rewrite into clear prose or structured notes (headings/bullets as appropriate).",
        "Preserve meaning and specifics (names, numbers, decisions, action items).",
        "Cut filler and repetition; do not invent facts that were not spoken.",
      ].join(" ");
    default:
      return [
        "Format style: AUTO.",
        "If the speech is mostly discrete items (sites, names, tasks), use CLEANUP (list).",
        "If it is continuous thoughts, meeting notes, or rambling, use REFORMULATE.",
        "Never invent content.",
      ].join(" ");
  }
}

/**
 * Hermes user message for finish_dictation — full buffer + store instructions.
 * Prefer this over a single last utterance so nothing is lost across VAD turns.
 */
export function buildDictationThinkMessage(session: DictationSessionState): {
  intent: string;
  summary: string;
  userQuote: string;
} {
  const raw = session.chunks.join("\n");
  const titleLine = session.title ? `Title hint: ${session.title}\n` : "";
  const summary = [
    "Voice dictation session finished.",
    `Store the result on the user's desktop (or the path they named): ${session.destination}.`,
    titleLine.trimEnd(),
    formatGuidance(session.format),
    "Write a markdown file (create or update). Open/show it on the desktop when done.",
    `Captured ${session.chunks.length} spoken chunk(s).`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    intent: "finish_dictation",
    summary,
    userQuote: raw || "(no speech captured during dictation)",
  };
}

export function dictationStatusPayload(session: DictationSessionState | null): Record<string, unknown> {
  if (!session?.active) {
    return { status: "inactive", active: false };
  }
  return {
    status: "active",
    active: true,
    destination: session.destination,
    format: session.format,
    title: session.title ?? null,
    chunk_count: session.chunks.length,
    preview: session.chunks.slice(-3).join(" | ").slice(0, 200),
  };
}
