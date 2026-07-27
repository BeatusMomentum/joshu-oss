import type { JoshuAppAgentManifest, JoshuGuiActionDef } from "@joshu/app-agent";

/** Semantic-only whiteboard actions. Review decisions remain human UI controls. */
export const WHITEBOARD_GUI_ACTIONS = [
  {
    name: "recallToBoard",
    description:
      "Retrieve a bounded, diverse packet from File Brain and Hindsight and stage source cards for visible human review",
    parameters: [
      {
        name: "query",
        type: "string",
        required: true,
        description: "Specific retrieval query grounded in the current whiteboard task",
      },
      {
        name: "limit",
        type: "number",
        description: "Optional total source-card limit; clamped to 1-6",
      },
    ],
  },
  {
    name: "stageOpening",
    description:
      "Stage a proposed opening brief and source cards from what changed, tensions, open questions, and 2-3 possible starts",
    parameters: [
      {
        name: "brief",
        type: "object",
        required: true,
        description:
          "Object with summary, whatChanged[], tensions[], openQuestions[], and starts[]",
      },
      {
        name: "sources",
        type: "object",
        description:
          "Optional source cards keyed by id; each has title, excerpt/body, sourceUri/sourceId, and kind",
      },
    ],
  },
  {
    name: "proposeTransaction",
    description:
      "Stage safe semantic CWM upserts as an AI proposal; commitment, deletion, confirmation, and raw scene operations are forbidden",
    parameters: [
      {
        name: "transaction",
        type: "object",
        required: true,
        description: "Object containing rationale and semantic operations[]",
      },
    ],
  },
  {
    name: "showFocus",
    description: "Ephemerally highlight semantic object and region ids without changing canvas content",
    parameters: [
      {
        name: "focus",
        type: "object",
        required: true,
        description: "Object with objectIds[], regionIds[], and optional reason",
      },
    ],
  },
  {
    name: "focusRegion",
    description: "Move the viewport to an existing semantic region by id",
    parameters: [{ name: "regionId", type: "string", required: true }],
    voice: {
      shortcut: "focus_region",
      phrases: ["focus region", "show region", "go to region"],
      description: "Navigate to a known whiteboard region by id without changing board content",
    },
  },
  {
    name: "openBoard",
    description: "Open an eligible relative .excalidraw board path through jWhiteboard's loader",
    parameters: [{ name: "path", type: "string", required: true }],
    voice: {
      shortcut: "open_board",
      phrases: ["open whiteboard", "open board", "switch board"],
      description: "Open an eligible whiteboard path without editing its content",
    },
  },
] as const satisfies readonly JoshuGuiActionDef[];

/** Frontend agent slice; keep action names aligned with the subservice manifest. */
export const WHITEBOARD_MANIFEST: JoshuAppAgentManifest = {
  id: "excalidraw",
  name: "jWhiteboard",
  agent: {
    skill: "whiteboard-gui",
    usesSkills: ["joshu-brain", "ea-time-block"],
    headless: false,
    guiActions: [...WHITEBOARD_GUI_ACTIONS],
  },
};
