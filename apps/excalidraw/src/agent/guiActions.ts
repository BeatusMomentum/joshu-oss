import type { JoshuGuiActionDef, JoshuGuiActionInput } from "@joshu/app-agent";
import type { MutableRefObject } from "react";

import type { WhiteboardGuiAgentApi } from "./bridge";
import { WHITEBOARD_GUI_ACTIONS } from "./whiteboardAppManifest";

type GuiArgs = Record<string, unknown>;

const actionDefinition = (name: string): JoshuGuiActionDef => {
  const definition = WHITEBOARD_GUI_ACTIONS.find((action) => action.name === name);
  if (!definition) throw new Error(`Missing whiteboard action definition: ${name}`);
  return definition;
};

/**
 * GUI action handlers expose only the semantic bridge. Human review controls and Excalidraw's
 * raw scene API are intentionally unreachable.
 */
export function createWhiteboardGuiActions(
  guiRef: MutableRefObject<WhiteboardGuiAgentApi | null>,
): JoshuGuiActionInput[] {
  const action = (
    name: string,
    handler: (api: WhiteboardGuiAgentApi, args: GuiArgs) => Promise<string>,
  ): JoshuGuiActionInput => {
    const definition = actionDefinition(name);
    return {
      name: definition.name,
      description: definition.description ?? definition.name,
      parameters: definition.parameters?.map((parameter) => ({
        ...parameter,
        type: parameter.type ?? "string",
      })),
      handler: async (args) => {
        const api = guiRef.current;
        if (!api) throw new Error("Whiteboard agent bridge is not ready");
        return handler(api, args);
      },
    };
  };

  return [
    action("recallToBoard", (api, args) => {
      const parsedLimit =
        typeof args.limit === "number"
          ? args.limit
          : typeof args.limit === "string" && args.limit.trim()
            ? Number(args.limit)
            : undefined;
      return api.recallToBoard(
        String(args.query ?? ""),
        parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      );
    }),
    action("stageOpening", (api, args) => api.stageOpening(args)),
    action("proposeTransaction", (api, args) => api.proposeTransaction(args)),
    action("showFocus", (api, args) => api.showFocus(args.focus)),
    action("focusRegion", (api, args) => api.focusRegion(String(args.regionId ?? ""))),
    action("openBoard", (api, args) => api.openBoard(String(args.path ?? ""))),
  ];
}
