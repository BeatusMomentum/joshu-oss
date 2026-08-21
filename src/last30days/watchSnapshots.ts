/**
 * Comparable watch-run snapshots + vs-average trending.
 *
 * One-shot Research does not enter this series. Only explicit watches
 * (Watch this topic / Watching → Check now) write snapshots.
 */

import fs from "node:fs";
import path from "node:path";
import {
  aggregateNativeBySource,
  comparableEngagement,
  tryParseAgentReport,
  type AgentReport,
  type AgentResultItem,
} from "./agentReportFormat.js";
import { last30daysWatchSnapshotsPath, migrateLegacyLast30daysState } from "./statePaths.js";

/** Watch lookback — not the engine watchlist's hardcoded 90d --quick. */
export const WATCH_WINDOW_DAYS = 7;

/** Need this many completed snapshots before Trending/Steady/Quiet. */
export const BASELINE_MIN_SNAPSHOTS = 3;

/** Ignore 1→3 mention bumps. */
export const TREND_MENTION_FLOOR = 5;

const MAX_SNAPSHOTS_PER_TOPIC = 40;
const MEAN_WINDOW = 8;

export type WatchTrendKind = "building" | "trending" | "steady" | "quiet";

export type WatchSourceVolume = {
  itemCount: number;
  nativeTotal: number;
  unit: string;
};

export type WatchSnapshot = {
  topic: string;
  runId: string;
  generatedAt: string;
  windowDays: number;
  mentionCount: number;
  comparableEngagement: number;
  sources: Record<string, WatchSourceVolume>;
  urls: string[];
  clusterTitles: string[];
};

export type WatchTrend = {
  kind: WatchTrendKind;
  label: string;
  mentionRatio?: number;
  engagementRatio?: number;
  priorCount: number;
  meanMentions?: number;
  meanEngagement?: number;
};

export type UrlDelta = {
  newUrls: string[];
  continuedUrls: string[];
  droppedUrls: string[];
};

function snapshotsPath(projectRoot: string): string {
  migrateLegacyLast30daysState(projectRoot);
  return last30daysWatchSnapshotsPath(projectRoot);
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

function readAll(projectRoot: string): WatchSnapshot[] {
  const file = snapshotsPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is WatchSnapshot => {
      if (!row || typeof row !== "object") return false;
      const o = row as WatchSnapshot;
      return typeof o.topic === "string" && typeof o.runId === "string";
    });
  } catch {
    return [];
  }
}

function writeAll(projectRoot: string, rows: WatchSnapshot[]): void {
  const file = snapshotsPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
}

export function listSnapshotsForTopic(projectRoot: string, topic: string): WatchSnapshot[] {
  const key = normalizeTopic(topic);
  return readAll(projectRoot)
    .filter((row) => normalizeTopic(row.topic) === key)
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

export function appendWatchSnapshot(projectRoot: string, snapshot: WatchSnapshot): WatchSnapshot {
  const all = readAll(projectRoot);
  const key = normalizeTopic(snapshot.topic);
  const withoutDup = all.filter(
    (row) => !(normalizeTopic(row.topic) === key && row.runId === snapshot.runId),
  );
  withoutDup.push(snapshot);
  const byTopic = new Map<string, WatchSnapshot[]>();
  for (const row of withoutDup) {
    const t = normalizeTopic(row.topic);
    const list = byTopic.get(t) || [];
    list.push(row);
    byTopic.set(t, list);
  }
  const pruned: WatchSnapshot[] = [];
  for (const list of byTopic.values()) {
    list.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
    pruned.push(...list.slice(-MAX_SNAPSHOTS_PER_TOPIC));
  }
  writeAll(projectRoot, pruned);
  return snapshot;
}

export function snapshotFromReport(
  report: AgentReport,
  opts: { topic: string; runId: string; windowDays?: number },
): WatchSnapshot {
  const items = report.results || [];
  const sources: Record<string, WatchSourceVolume> = {};
  for (const agg of aggregateNativeBySource(items)) {
    sources[agg.name] = {
      itemCount: agg.count,
      nativeTotal: agg.nativeTotal,
      unit: agg.unit,
    };
  }
  const urls = items.map((item) => item.url).filter((u): u is string => Boolean(u));
  return {
    topic: (report.query || opts.topic).trim(),
    runId: opts.runId,
    generatedAt: report.generated_at || new Date().toISOString(),
    windowDays: report.window_days ?? opts.windowDays ?? WATCH_WINDOW_DAYS,
    mentionCount: items.length,
    comparableEngagement: comparableEngagement(items),
    sources,
    urls,
    clusterTitles: (report.clusters || [])
      .map((c) => c.title?.trim())
      .filter((t): t is string => Boolean(t)),
  };
}

export function snapshotFromStdout(
  stdout: string,
  opts: { topic: string; runId: string; windowDays?: number },
): WatchSnapshot | null {
  const report = tryParseAgentReport(stdout);
  if (!report) return null;
  return snapshotFromReport(report, opts);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const varSum = values.reduce((acc, v) => acc + (v - avg) ** 2, 0);
  return Math.sqrt(varSum / values.length);
}

export function computeWatchTrend(snapshots: WatchSnapshot[]): WatchTrend {
  const ordered = [...snapshots].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  if (ordered.length < BASELINE_MIN_SNAPSHOTS) {
    return {
      kind: "building",
      label: `Building baseline (${ordered.length}/${BASELINE_MIN_SNAPSHOTS})`,
      priorCount: Math.max(0, ordered.length - 1),
    };
  }
  const current = ordered[ordered.length - 1]!;
  const prior = ordered.slice(0, -1).slice(-MEAN_WINDOW);
  const mentionMean = mean(prior.map((s) => s.mentionCount));
  const engMean = mean(prior.map((s) => s.comparableEngagement));
  const mentionRatio = mentionMean > 0 ? current.mentionCount / mentionMean : 0;
  const engagementRatio = engMean > 0 ? current.comparableEngagement / engMean : 0;
  const mentionZ =
    stddev(prior.map((s) => s.mentionCount), mentionMean) > 0
      ? (current.mentionCount - mentionMean) /
        stddev(prior.map((s) => s.mentionCount), mentionMean)
      : 0;

  const aboveFloor = current.mentionCount >= TREND_MENTION_FLOOR;
  const spike =
    aboveFloor &&
    (mentionRatio >= 2 || engagementRatio >= 2 || mentionZ >= 2);

  if (spike) {
    const shown = mentionRatio >= engagementRatio ? mentionRatio : engagementRatio;
    const unit = mentionRatio >= engagementRatio ? "mentions" : "engagement";
    return {
      kind: "trending",
      label: `Trending · ${shown.toFixed(1)}× ${unit} vs ${prior.length}-run avg`,
      mentionRatio,
      engagementRatio,
      priorCount: prior.length,
      meanMentions: mentionMean,
      meanEngagement: engMean,
    };
  }

  if (mentionMean > 0 && mentionRatio <= 0.5 && current.mentionCount < mentionMean) {
    return {
      kind: "quiet",
      label: `Quiet · ${mentionRatio.toFixed(1)}× mentions vs ${prior.length}-run avg`,
      mentionRatio,
      engagementRatio,
      priorCount: prior.length,
      meanMentions: mentionMean,
      meanEngagement: engMean,
    };
  }

  return {
    kind: "steady",
    label: "Steady",
    mentionRatio,
    engagementRatio,
    priorCount: prior.length,
    meanMentions: mentionMean,
    meanEngagement: engMean,
  };
}

export function urlDeltaFromSnapshots(snapshots: WatchSnapshot[]): UrlDelta {
  const ordered = [...snapshots].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  if (ordered.length < 2) {
    return { newUrls: ordered[0]?.urls || [], continuedUrls: [], droppedUrls: [] };
  }
  const last = ordered[ordered.length - 1]!;
  const prev = ordered[ordered.length - 2]!;
  const current = new Set(last.urls);
  const previous = new Set(prev.urls);
  return {
    newUrls: [...current].filter((u) => !previous.has(u)),
    continuedUrls: [...current].filter((u) => previous.has(u)),
    droppedUrls: [...previous].filter((u) => !current.has(u)),
  };
}

export function sourceVolumeDelta(
  current?: WatchSnapshot,
  previous?: WatchSnapshot,
): {
  name: string;
  currentCount: number;
  previousCount: number;
  currentNative: number;
  previousNative: number;
  unit: string;
}[] {
  const names = new Set([
    ...Object.keys(current?.sources || {}),
    ...Object.keys(previous?.sources || {}),
  ]);
  return [...names].sort().map((name) => {
    const cur = current?.sources[name];
    const prev = previous?.sources[name];
    return {
      name,
      currentCount: cur?.itemCount || 0,
      previousCount: prev?.itemCount || 0,
      currentNative: cur?.nativeTotal || 0,
      previousNative: prev?.nativeTotal || 0,
      unit: cur?.unit || prev?.unit || "score",
    };
  });
}

/** Map result items to titles for URL lists in the watch report. */
export function titlesByUrl(items: AgentResultItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (!item.url) continue;
    map.set(item.url, item.title?.trim() || item.summary?.trim() || item.url);
  }
  return map;
}
