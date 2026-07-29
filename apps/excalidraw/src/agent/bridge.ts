import type { CwmWorkspaceController } from "../cwm/useCwmWorkspace";
import { reliableCwmBoardPath } from "../cwm/useCwmWorkspace";
import {
  coerceAgentFocus,
  coerceAgentTransaction,
  coerceStageOpening,
} from "./cwmCoercion";

export type WhiteboardGuiAgentApi = {
  getGuiSnapshot: () => Record<string, unknown>;
  recallToBoard: (query: string, limit?: number) => Promise<string>;
  stageOpening: (args: Record<string, unknown>) => Promise<string>;
  proposeTransaction: (args: Record<string, unknown>) => Promise<string>;
  showFocus: (focus: unknown) => Promise<string>;
  focusRegion: (regionId: string) => Promise<string>;
  openBoard: (path: string) => Promise<string>;
};

export type OpenWhiteboardPath = (path: string) => Promise<boolean>;

function summarizeApplyResult(
  operations: readonly { readonly type: string; readonly object?: { readonly kind?: string } }[],
): string {
  const count = operations.filter((operation) => operation.type === "UPSERT_OBJECT").length;
  const removals = operations.filter((operation) => operation.type === "REMOVE_OBJECT").length;
  const parts: string[] = [];
  if (count > 0) parts.push(`${count} item(s) applied on the board with a small action note`);
  if (removals > 0) parts.push(`${removals} removal(s) applied`);
  return parts.join("; ") || "Semantic operations applied.";
}

/** Bind semantic agent commands to the CWM controller and the existing board loader. */
export function createWhiteboardAgentBridge(
  cwm: CwmWorkspaceController,
  openWhiteboardPath: OpenWhiteboardPath,
): WhiteboardGuiAgentApi {
  const requireReady = () => {
    if (cwm.status.kind !== "ready" || !cwm.workspace) {
      throw new Error("Curatorial Whiteboard is not ready");
    }
    return cwm.workspace;
  };

  return {
    getGuiSnapshot: cwm.getGuiSnapshot,

    async recallToBoard(query, limit) {
      requireReady();
      const count = await cwm.recallToBoard(query, limit);
      return `${count} retrieved note(s) applied to the board.`;
    },

    async stageOpening(args) {
      requireReady();
      const operations = coerceStageOpening(args);
      await cwm.proposeOperations(operations, "AI-staged opening session", { actor: "AI" });
      return `Opening brief and ${Math.max(0, operations.length - 1)} source note(s) applied to the board.`;
    },

    async proposeTransaction(args) {
      const workspace = requireReady();
      const transaction = coerceAgentTransaction(args, new Date().toISOString(), workspace);
      await cwm.proposeOperations(transaction.operations, transaction.rationale, { actor: "AI" });
      return summarizeApplyResult(transaction.operations);
    },

    async showFocus(value) {
      const workspace = requireReady();
      const focus = coerceAgentFocus(value, workspace);
      await cwm.showFocus(focus, "AI");
      return "Focus shown ephemerally.";
    },

    async focusRegion(regionId) {
      const workspace = requireReady();
      const region = workspace.regions[regionId.trim()];
      if (!region) throw new Error(`Unknown CWM region: ${regionId}`);
      await cwm.focusRegion(region, "AI");
      return `Focused region "${region.title}".`;
    },

    async openBoard(path) {
      const eligiblePath = reliableCwmBoardPath(path.trim());
      if (!eligiblePath) {
        throw new Error("Board path must be a relative .excalidraw path without traversal");
      }
      if (!(await openWhiteboardPath(eligiblePath))) {
        throw new Error(`Could not open board: ${eligiblePath}`);
      }
      return `Opened board ${eligiblePath}.`;
    },
  };
}
