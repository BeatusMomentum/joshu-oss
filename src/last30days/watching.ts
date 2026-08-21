/**
 * JSON facade over watchlist.py + Joshu watch snapshots.
 * The GUI never dumps companion CLI stdout as the product.
 */

import {
  parseCompanionJson,
  runCompanion,
} from "./companions.js";
import {
  computeWatchTrend,
  listSnapshotsForTopic,
  sourceVolumeDelta,
  urlDeltaFromSnapshots,
  type WatchSnapshot,
  type WatchTrend,
} from "./watchSnapshots.js";

export type WatchCadence = "daily" | "weekly";

export type WatchingTopic = {
  name: string;
  cadence: WatchCadence;
  enabled: boolean;
  lastCheckedAt: string | null;
  snapshotCount: number;
  status: WatchTrend;
};

function cadenceFromSchedule(schedule: string | undefined): WatchCadence {
  const s = (schedule || "").trim();
  // Upstream --weekly → "0 8 * * 1" (Mondays).
  if (s === "0 8 * * 1" || s.includes("* * 1") || /weekly/i.test(s)) return "weekly";
  return "daily";
}

/** Daily/weekly Hermes crons pass cadence; Check all now omits it (all enabled). */
export function filterWatchingForCadence<T extends { cadence: WatchCadence; enabled: boolean }>(
  topics: T[],
  cadence?: WatchCadence,
): T[] {
  const enabled = topics.filter((row) => row.enabled);
  if (cadence !== "daily" && cadence !== "weekly") return enabled;
  return enabled.filter((row) => row.cadence === cadence);
}

type WatchlistTopicRow = {
  name?: string;
  schedule?: string;
  enabled?: number | boolean;
  updated_at?: string;
};

type WatchlistListPayload = {
  topics?: WatchlistTopicRow[];
};

export async function listWatching(projectRoot: string): Promise<WatchingTopic[]> {
  const result = await runCompanion(projectRoot, "watchlist.py", ["list"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "watchlist list failed");
  }
  const parsed = parseCompanionJson<WatchlistListPayload>(result.stdout);
  const rows = parsed?.topics || [];
  return rows
    .map((row) => {
      const name = String(row.name || "").trim();
      const snapshots = listSnapshotsForTopic(projectRoot, name);
      const last = snapshots[snapshots.length - 1];
      return {
        name,
        cadence: cadenceFromSchedule(row.schedule),
        enabled: row.enabled !== 0 && row.enabled !== false,
        lastCheckedAt: last?.generatedAt || row.updated_at || null,
        snapshotCount: snapshots.length,
        status: computeWatchTrend(snapshots),
      };
    })
    .filter((row) => row.name);
}

export async function addWatch(
  projectRoot: string,
  topic: string,
  cadence: WatchCadence = "daily",
): Promise<{ ok: boolean; topic: string; message?: string }> {
  const args = ["add", topic.trim()];
  if (cadence === "weekly") args.push("--weekly");
  const result = await runCompanion(projectRoot, "watchlist.py", args);
  const parsed = parseCompanionJson<{ topic?: string; message?: string; action?: string }>(
    result.stdout,
  );
  if (result.exitCode !== 0) {
    throw new Error(parsed?.message || result.stderr.trim() || "watchlist add failed");
  }
  return {
    ok: true,
    topic: parsed?.topic || topic.trim(),
    message: parsed?.message,
  };
}

export async function removeWatch(
  projectRoot: string,
  topic: string,
): Promise<{ ok: boolean; topic: string }> {
  const result = await runCompanion(projectRoot, "watchlist.py", ["remove", topic.trim()]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "watchlist remove failed");
  }
  return { ok: true, topic: topic.trim() };
}

export type WatchReportPayload = {
  topic: string;
  trend: WatchTrend;
  snapshots: WatchSnapshot[];
  delta: {
    newUrls: string[];
    continuedUrls: string[];
    droppedUrls: string[];
  };
  volume: ReturnType<typeof sourceVolumeDelta>;
  quietEmpty: boolean;
};

export function buildWatchReport(projectRoot: string, topic: string): WatchReportPayload {
  const snapshots = listSnapshotsForTopic(projectRoot, topic);
  const trend = computeWatchTrend(snapshots);
  const delta = urlDeltaFromSnapshots(snapshots);
  const current = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];
  const volume = sourceVolumeDelta(current, previous);
  const quietEmpty =
    trend.kind === "steady" &&
    delta.newUrls.length === 0 &&
    delta.droppedUrls.length === 0;
  return {
    topic,
    trend,
    snapshots,
    delta,
    volume,
    quietEmpty,
  };
}
