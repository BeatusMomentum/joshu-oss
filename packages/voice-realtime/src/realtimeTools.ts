/** OpenAI Realtime session tools — invoke the brain for personal / file / memory work. */

export const REALTIME_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "open_desktop",
    description:
      "Open a Joshu desktop app immediately (browser/jWeb, email/jMail, chat, whiteboard, files, connectors, schedules, memory). Use for simple app-open requests with no file lookup. Do NOT use for opening a specific file path or searching files — use think instead.",
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "App alias or name: browser, jWeb, mail, jMail, email, chat, whiteboard, files, connectors, schedules, memory, welcome, settings, trash",
        },
      },
      required: ["app"],
    },
  },
  {
    type: "function" as const,
    name: "start_dictation",
    description:
      "Begin a multi-turn voice dictation session ONLY when the user explicitly asks you to wait/listen until they finish a dump — e.g. \"I am about to tell you a bunch of things, just wait for me to finish\", \"don't interrupt\", \"start dictation\", \"take this down\". Do NOT infer dictation from a task (calendar reminders, make a list, add notes) — use think for those. Joshu buffers every subsequent utterance until finish_dictation. Call with zero spoken preamble.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description:
            "Where to store when finished — e.g. Websites.md on Desktop, meeting notes, journal entry",
        },
        format: {
          type: "string",
          description:
            "cleanup = light edit / lists; reformulate = rewrite clear notes from rambling; auto = choose from content (default)",
        },
        title: {
          type: "string",
          description: "Optional document title or heading",
        },
      },
      required: ["destination"],
    },
  },
  {
    type: "function" as const,
    name: "finish_dictation",
    description:
      "End the active dictation session and hand the full buffered speech to Hermes to format and save. Call when the user says they are done, finished, that's all, or similar — even if some chunks already arrived. Do NOT call if no start_dictation is active.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Optional one-line context for Hermes (e.g. user wants bullets)",
        },
      },
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "cancel_dictation",
    description: "Abort the active dictation session without saving. Discard the buffer.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "think",
    description:
      "Use your full brain (Hermes, files, memory, tools) for anything about THIS user: saved files, journals, notes, desktop, past conversations, or tasks that read/write/browse. Call this tool FIRST with zero spoken preamble — do not say you lack access; this tool IS your access. Returns immediately; speak the result when ready. Do NOT use for general world knowledge you already know. Do NOT use for simple app opens — use open_desktop instead. Do NOT use think for mid-dictation chunks — use start_dictation / finish_dictation instead.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "Short label, e.g. read_journal, save_note, browse",
        },
        summary: {
          type: "string",
          description: "Brief summary of the voice conversation relevant to the request",
        },
        user_quote: {
          type: "string",
          description:
            "Verbatim latest user utterance (required whenever you heard them speak). Prefer exact words over paraphrase — Joshu logs this into Hermes/Langfuse.",
        },
      },
      required: ["intent", "summary", "user_quote"],
    },
  },
];

/**
 * Tools a surface actually implements. Declaring a tool the handler cannot execute makes the
 * model call it and narrate fake success ("I've opened the Welcome app"), so surfaces opt in.
 * PSTN: think + dictation (no open_desktop — desktop opens are browser/desktop-session work).
 */
export const PHONE_TOOL_NAMES = [
  "think",
  "start_dictation",
  "finish_dictation",
  "cancel_dictation",
] as const;

/** Base tool definitions filtered to `names` (all when omitted), plus app-specific extras. */
export function selectRealtimeTools(
  names?: readonly string[],
  extraTools: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const base = names
    ? REALTIME_TOOL_DEFINITIONS.filter((tool) => names.includes(tool.name))
    : REALTIME_TOOL_DEFINITIONS;
  return [...base, ...extraTools];
}

/** Legacy tool names from older Realtime sessions / prompts. */
export const LEGACY_THINK_TOOL_NAMES = new Set(["ask_joshu", "delegate_to_joshu"]);

export function normalizeThinkToolName(name: string): string {
  if (LEGACY_THINK_TOOL_NAMES.has(name)) return "think";
  return name;
}

/** Gemini Live API tool declarations (function calling). */
export function geminiToolDefinitions(
  extraTools: Array<Record<string, unknown>> = [],
  toolNames?: readonly string[],
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  const allTools = selectRealtimeTools(toolNames, extraTools);
  return [
    {
      functionDeclarations: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}
