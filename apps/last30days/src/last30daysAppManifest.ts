import type { JoshuAppAgentManifest } from "@joshu/app-agent";

/** Browser mirror of arozos/subservice/last30days/joshu.app.json */
export const LAST30DAYS_MANIFEST = {
  id: "last30days",
  name: "last30days",
  version: "0.2.0",
  agent: {
    skill: "last30days-gui",
    usesSkills: ["joshu-browser"],
    headless: false,
    guiActions: [
      {
        name: "runResearch",
        description: "Run topic research in the open app",
        parameters: [
          { name: "topic", type: "string", required: true },
          { name: "days", type: "number" },
          { name: "depth", type: "string" },
          { name: "mock", type: "boolean" },
        ],
        voice: {
          shortcut: "research",
          phrases: ["research", "what are people saying about", "run research on"],
        },
      },
      { name: "cancelRun", description: "Cancel active run" },
      {
        name: "openRun",
        description: "Open historical run",
        parameters: [{ name: "runId", type: "string", required: true }],
      },
      { name: "openSettings", description: "Open settings" },
      { name: "runDoctor", description: "Run doctor" },
      { name: "refreshRuns", description: "Refresh runs list" },
      { name: "openWatching", description: "Open Watching" },
      {
        name: "watchThisTopic",
        description: "Watch the current topic",
        parameters: [{ name: "topic", type: "string" }],
      },
    ],
    actions: [
      { name: "research" },
      { name: "doctor" },
      { name: "watchingList" },
      { name: "watchingAdd" },
      { name: "watchingRemove" },
      { name: "watchingReport" },
      { name: "watchingRun" },
      { name: "watchingRunAll" },
      { name: "watchlistRunAll" },
      { name: "briefingGenerate" },
    ],
  },
} satisfies JoshuAppAgentManifest;
