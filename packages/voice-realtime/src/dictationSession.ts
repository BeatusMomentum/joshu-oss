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
