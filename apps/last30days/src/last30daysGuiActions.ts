import type { MutableRefObject } from "react";
import type { JoshuGuiActionInput } from "@joshu/app-agent";

export type Last30DaysNavId =
  | "research"
  | "watchlist"
  | "store"
  | "briefings"
  | "doctor";

export type Last30DaysGuiAgentApi = {
  getGuiSnapshot: () => Record<string, unknown>;
  runResearch: (args: {
    topic?: string;
    days?: number;
    depth?: string;
    mock?: boolean;
  }) => Promise<string>;
  cancelRun: () => Promise<string>;
  openRun: (runId: string) => Promise<string>;
  openSettings: () => string;
  runDoctor: () => Promise<string>;
  refreshRuns: () => Promise<string>;
  openWatchlist: () => string;
};

export function createLast30DaysGuiActions(
  guiRef: MutableRefObject<Last30DaysGuiAgentApi | null>,
): JoshuGuiActionInput[] {
  return [
    {
      name: "runResearch",
      description:
        "Run topic research in the open app Results panel. Blocks until the run finishes, then returns a summary. You MUST call this tool to start research — never claim a run started without calling it.",
      parameters: [
        { name: "topic", type: "string", required: true },
        { name: "days", type: "number" },
        { name: "depth", type: "string" },
        { name: "mock", type: "boolean" },
      ],
      handler: async (args) => guiRef.current?.runResearch(args) ?? "App not ready.",
    },
    {
      name: "cancelRun",
      description: "Cancel the active research run",
      handler: async () => guiRef.current?.cancelRun() ?? "App not ready.",
    },
    {
      name: "openRun",
      description: "Open a saved run by id",
      parameters: [{ name: "runId", type: "string", required: true }],
      handler: async (args) =>
        guiRef.current?.openRun(String(args.runId ?? "")) ?? "App not ready.",
    },
    {
      name: "openSettings",
      description: "Open settings dialog",
      handler: async () => guiRef.current?.openSettings() ?? "App not ready.",
    },
    {
      name: "runDoctor",
      description: "Run doctor health check",
      handler: async () => guiRef.current?.runDoctor() ?? "App not ready.",
    },
    {
      name: "refreshRuns",
      description: "Refresh recent runs list",
      handler: async () => guiRef.current?.refreshRuns() ?? "App not ready.",
    },
    {
      name: "openWatchlist",
      description: "Switch to Watchlist screen",
      handler: async () => guiRef.current?.openWatchlist() ?? "App not ready.",
    },
  ];
}
