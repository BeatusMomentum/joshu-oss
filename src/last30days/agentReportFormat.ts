/**
 * Shared last30days agent JSON report parsing + display ordering.
 * Used by the Results panel (apps/last30days) and research markdown export.
 */

import {
  getAudienceRegister,
  sourceEmphasis,
  type AudienceRegister,
  type AudienceSection,
} from "./audienceRegister.js";

export type AgentCluster = {
  title?: string;
  summary?: string;
  sources?: string[];
  engagement_total?: number;
};

export type AgentResultItem = {
  candidate_id?: string;
  title?: string;
  summary?: string;
  url?: string;
  source?: string;
  published_at?: string;
  cluster?: number;
  engagement?: Record<string, number>;
  relevance_score?: number;
};

export type AgentReport = {
  query?: string;
  window_days?: number;
  generated_at?: string;
  clusters?: AgentCluster[];
  results?: AgentResultItem[];
  source_status?: Record<string, string>;
  schema_version?: string;
};

export type IndexedCluster = {
  cluster: AgentCluster;
  /** Original cluster index referenced by result items. */
  idx: number;
  memberCount: number;
  /** Max member relevance_score (0 when unscored). */
  relevanceScore: number;
  /** Sum of log1p(preferred native counter) — comparable across sources. */
  comparableScore: number;
  /** Per-source native units, e.g. "Reddit 4.2k upvotes · HN 800 pts". */
  nativeLabel: string;
};

export type NativeCounter = {
  value: number;
  unit: string;
};

export type SourceNativeAgg = {
  name: string;
  count: number;
  nativeTotal: number;
  unit: string;
  status?: string;
};

/**
 * Drop engine hits below this relevance_score when scores exist.
 * Tuned on LA Tech Week: on-topic ~0.55+, other-city / noise ~0.39–0.45.
 */
export const DEFAULT_RELEVANCE_FLOOR = 0.45;

export type ClusterDisplayOptions = {
  register?: AudienceRegister;
  /**
   * Drop items with relevance_score below this when any scores exist.
   * Pass `null` to disable. Default: DEFAULT_RELEVANCE_FLOOR.
   */
  relevanceFloor?: number | null;
  /** Original topic — enables event off-topic (other-city Tech Week) filter. */
  query?: string;
};

/** Compact 4200 → "4.2k", 1_200_000 → "1.2M". */
export function formatCompactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    const s = abs >= 10_000_000 ? v.toFixed(0) : v.toFixed(1);
    return `${s.replace(/\.0$/, "")}M`;
  }
  if (abs >= 1_000) {
    const v = n / 1_000;
    const s = abs >= 10_000 ? v.toFixed(0) : v.toFixed(1);
    return `${s.replace(/\.0$/, "")}k`;
  }
  return Math.round(n).toLocaleString();
}

function num(engagement: Record<string, number> | undefined, keys: string[]): number {
  if (!engagement) return 0;
  for (const key of keys) {
    const v = engagement[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function maxEngagement(engagement: Record<string, number> | undefined): number {
  if (!engagement) return 0;
  let max = 0;
  for (const v of Object.values(engagement)) {
    if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/**
 * Pick the native counter that is meaningful for this source.
 * Never mix views + upvotes into one number.
 */
export function preferredNativeCounter(
  source: string,
  engagement?: Record<string, number>,
): NativeCounter {
  const src = (source || "unknown").toLowerCase();
  if (src.includes("reddit")) {
    return { value: num(engagement, ["score", "upvotes", "ups"]), unit: "upvotes" };
  }
  if (src.includes("hacker") || src === "hn" || src.includes("hackernews")) {
    return { value: num(engagement, ["points", "score"]), unit: "pts" };
  }
  if (src.includes("github")) {
    return { value: num(engagement, ["stars", "score"]), unit: "stars" };
  }
  if (src.includes("polymarket")) {
    return { value: num(engagement, ["volume", "liquidity", "score"]), unit: "volume" };
  }
  if (src === "x" || src.includes("twitter") || src.includes("xquik")) {
    const views = num(engagement, ["views"]);
    if (views > 0) return { value: views, unit: "views" };
    return { value: num(engagement, ["likes", "reposts", "score"]), unit: "likes" };
  }
  if (
    src.includes("youtube") ||
    src.includes("tiktok") ||
    src.includes("instagram") ||
    src.includes("threads")
  ) {
    const views = num(engagement, ["views"]);
    if (views > 0) return { value: views, unit: "views" };
    return { value: num(engagement, ["likes", "score"]), unit: "likes" };
  }
  const fallback = maxEngagement(engagement);
  return { value: fallback, unit: "score" };
}

export function log1pPreferred(item: AgentResultItem): number {
  return Math.log1p(preferredNativeCounter(item.source || "", item.engagement).value);
}

export function comparableEngagement(items: AgentResultItem[]): number {
  let sum = 0;
  for (const item of items) sum += log1pPreferred(item);
  return sum;
}

export function aggregateNativeBySource(items: AgentResultItem[]): SourceNativeAgg[] {
  const by = new Map<string, SourceNativeAgg>();
  for (const item of items) {
    const name = (item.source || "unknown").toLowerCase();
    const native = preferredNativeCounter(name, item.engagement);
    const cur = by.get(name) || { name, count: 0, nativeTotal: 0, unit: native.unit };
    cur.count += 1;
    cur.nativeTotal += native.value;
    cur.unit = native.unit;
    by.set(name, cur);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Human label for a cluster: native units + mention count. */
export function nativeStatsLabel(items: AgentResultItem[]): string {
  const aggs = aggregateNativeBySource(items);
  const parts: string[] = [];
  for (const agg of aggs) {
    if (agg.nativeTotal > 0) {
      parts.push(`${agg.name} ${formatCompactCount(agg.nativeTotal)} ${agg.unit}`);
    } else {
      parts.push(`${agg.name} ${agg.count}`);
    }
  }
  const n = items.length;
  if (n > 0) parts.push(`${n} mention${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function tryParseAgentReport(text: string): AgentReport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as AgentReport;
    if (!Array.isArray(obj.clusters) && !Array.isArray(obj.results)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function sourceIssuesFromStatus(status?: Record<string, string>): string[] {
  if (!status) return [];
  return Object.entries(status)
    .filter(([, value]) => value && value !== "ok")
    .map(([name, value]) => `${name}: ${value}`);
}

function clusterEmphasis(cluster: AgentCluster, members: AgentResultItem[], register: AudienceRegister): number {
  const sources = [
    ...(cluster.sources || []),
    ...members.map((item) => item.source || ""),
  ].filter(Boolean);
  if (!sources.length) return 1;
  return Math.max(...sources.map((src) => sourceEmphasis(src, register.emphasis)));
}

function isAudienceRegister(value: unknown): value is AudienceRegister {
  return (
    !!value &&
    typeof value === "object" &&
    "sectionOrder" in value &&
    "emphasis" in value &&
    "name" in value
  );
}

function normalizeDisplayOptions(
  registerOrOpts?: AudienceRegister | ClusterDisplayOptions,
): ClusterDisplayOptions {
  if (!registerOrOpts) return {};
  if (isAudienceRegister(registerOrOpts)) return { register: registerOrOpts };
  return registerOrOpts;
}

/** Max relevance among members (0 if none scored). */
export function clusterRelevance(items: AgentResultItem[]): number {
  let max = 0;
  for (const item of items) {
    const s = item.relevance_score;
    if (typeof s === "number" && Number.isFinite(s) && s > max) max = s;
  }
  return max;
}

function anyRelevanceScores(items: AgentResultItem[]): boolean {
  return items.some(
    (item) => typeof item.relevance_score === "number" && Number.isFinite(item.relevance_score),
  );
}

/**
 * Place tokens for Tech Week–style events. When the topic pins a city, other
 * cities' "Tech Week" hits are treated as off-topic even if engagement is high.
 */
const EVENT_PLACE_HINTS: Array<{ id: string; match: RegExp }> = [
  { id: "la", match: /\b(los\s*angeles|socal|weho|west\s*hollywood|\bla\b)/i },
  { id: "sf", match: /\b(san\s*francisco|bay\s*area|\bsf\b)/i },
  { id: "nyc", match: /\b(new\s*york|\bnyc\b|\bny\b)/i },
  { id: "austin", match: /\baustin\b/i },
  { id: "atlanta", match: /\batlanta\b|\batl\b/i },
  { id: "seattle", match: /\bseattle\b/i },
  { id: "chicago", match: /\bchicago\b/i },
  { id: "miami", match: /\bmiami\b/i },
  { id: "boston", match: /\bboston\b/i },
  { id: "denver", match: /\bdenver\b/i },
  { id: "toronto", match: /\btoronto\b/i },
  { id: "london", match: /\blondon\b/i },
  { id: "berlin", match: /\bberlin\b/i },
  { id: "paris", match: /\bparis\b/i },
  { id: "singapore", match: /\bsingapore\b/i },
  { id: "tokyo", match: /\btokyo\b/i },
  { id: "waterloo", match: /\bwaterloo\b/i },
  { id: "colombia", match: /\bcolombia\b|\bbogot[aá]\b/i },
];

function detectEventPlace(text: string): string | null {
  for (const place of EVENT_PLACE_HINTS) {
    if (place.match.test(text)) return place.id;
  }
  return null;
}

/** True when this hit is another city's Tech Week / summit while the topic pinned a place. */
export function isOffTopicEventItem(item: AgentResultItem, query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (!/\b(tech\s*weeks?|summit|conference)\b/i.test(q)) return false;
  const target = detectEventPlace(q);
  if (!target) return false;

  const blob = `${item.title || ""} ${item.summary || ""}`;
  if (!/\btech\s*weeks?\b|\btechweek\b/i.test(blob)) return false;
  // Keep anything that also names the topic's place.
  if (detectEventPlace(blob) === target) return false;
  const mentioned = detectEventPlace(blob);
  return mentioned != null && mentioned !== target;
}

/** Filter low-relevance + off-topic event noise before Results / brief rendering. */
export function filterItemsForDisplay(
  items: AgentResultItem[],
  opts?: ClusterDisplayOptions,
): AgentResultItem[] {
  const floor =
    opts?.relevanceFloor === null
      ? null
      : opts?.relevanceFloor === undefined
        ? DEFAULT_RELEVANCE_FLOOR
        : opts.relevanceFloor;
  const query = (opts?.query || "").trim();
  const enforceFloor = floor != null && anyRelevanceScores(items);

  return items.filter((item) => {
    if (query && isOffTopicEventItem(item, query)) return false;
    if (enforceFloor) {
      const s = item.relevance_score;
      if (typeof s === "number" && Number.isFinite(s) && s < floor!) return false;
    }
    return true;
  });
}

/**
 * Display clusters by relevance (then engagement). Applies relevance floor +
 * event off-topic filter when opts/query provided.
 * Third arg may be an AudienceRegister (legacy) or ClusterDisplayOptions.
 */
export function indexClustersForDisplay(
  clusters: AgentCluster[],
  items: AgentResultItem[],
  registerOrOpts?: AudienceRegister | ClusterDisplayOptions,
): IndexedCluster[] {
  const opts = normalizeDisplayOptions(registerOrOpts);
  const preset = opts.register || getAudienceRegister("default");
  const filtered = filterItemsForDisplay(items, {
    ...opts,
    // Prefer explicit query; fall back unused here — callers should pass query.
    query: opts.query,
  });

  const indexed = clusters
    .map((cluster, idx) => {
      const members = filtered.filter((item) => item.cluster === idx);
      const base = comparableEngagement(members);
      const weight = clusterEmphasis(cluster, members, preset);
      return {
        cluster,
        idx,
        memberCount: members.length,
        relevanceScore: clusterRelevance(members),
        comparableScore: base * weight,
        nativeLabel: nativeStatsLabel(members),
      };
    })
    .filter((entry) => entry.memberCount > 0);

  indexed.sort((a, b) => {
    // Relevance first when scores exist on either side.
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    if (b.comparableScore !== a.comparableScore) return b.comparableScore - a.comparableScore;
    if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
    return a.idx - b.idx;
  });
  if (preset.clusterBudget != null) return indexed.slice(0, preset.clusterBudget);
  return indexed;
}

export function membersForCluster(
  items: AgentResultItem[],
  clusterIdx: number,
  limit = 6,
  opts?: ClusterDisplayOptions,
): AgentResultItem[] {
  const filtered = filterItemsForDisplay(items, opts);
  return filtered
    .filter((item) => item.cluster === clusterIdx)
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, limit);
}

export function sourceCounts(report: AgentReport): SourceNativeAgg[] {
  const aggs = aggregateNativeBySource(report.results || []);
  const byName = new Map(aggs.map((a) => [a.name, a]));
  const names = new Set<string>([...byName.keys(), ...Object.keys(report.source_status || {})]);
  return [...names]
    .sort()
    .map((name) => {
      const agg = byName.get(name);
      return {
        name,
        count: agg?.count || 0,
        nativeTotal: agg?.nativeTotal || 0,
        unit: agg?.unit || "score",
        status: report.source_status?.[name],
      };
    });
}

function formatItemLink(item: AgentResultItem): string {
  const label = item.title?.trim() || item.summary?.trim() || item.url || "Untitled";
  const meta = [item.source || "?", item.published_at].filter(Boolean).join(" · ");
  if (item.url) return `- [${label}](${item.url}) — ${meta}`;
  return `- ${label} — ${meta}`;
}

function rankItems(
  items: AgentResultItem[],
  register: AudienceRegister,
  predicate: (item: AgentResultItem) => boolean,
  limit: number,
): AgentResultItem[] {
  if (limit <= 0) return [];
  return items
    .filter(predicate)
    .map((item) => ({
      item,
      score: log1pPreferred(item) * sourceEmphasis(item.source || "", register.emphasis),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.item);
}

function isCommentItem(item: AgentResultItem): boolean {
  const src = (item.source || "").toLowerCase();
  return src.includes("comment");
}

function renderClusterSection(
  indexed: IndexedCluster[],
  items: AgentResultItem[],
): string[] {
  const lines: string[] = [];
  for (const [displayRank, { cluster, idx, memberCount, nativeLabel }] of indexed.entries()) {
    lines.push("");
    const title = cluster.title?.trim() || `Cluster ${displayRank + 1}`;
    lines.push(`## ${displayRank + 1}. ${title}`);

    if (cluster.summary?.trim() && cluster.summary !== cluster.title) {
      lines.push("", cluster.summary.trim());
    }

    const stats: string[] = [];
    if (memberCount > 1) stats.push(`${memberCount} items`);
    for (const source of cluster.sources || []) stats.push(source);
    if (nativeLabel) stats.push(nativeLabel);
    if (stats.length) lines.push("", stats.join(" · "));

    const members = membersForCluster(items, idx);
    if (members.length) {
      lines.push("");
      for (const item of members) lines.push(formatItemLink(item));
    }
  }
  return lines;
}

function renderNamedList(heading: string, items: AgentResultItem[]): string[] {
  if (!items.length) return [];
  const lines = ["", `## ${heading}`, ""];
  for (const item of items) lines.push(formatItemLink(item));
  return lines;
}

function renderStatsLine(counts: SourceNativeAgg[]): string[] {
  if (!counts.length) return [];
  return [
    "",
    counts
      .map((c) =>
        c.nativeTotal > 0
          ? `${c.name} **${c.count}** (${formatCompactCount(c.nativeTotal)} ${c.unit})`
          : `${c.name} **${c.count}**`,
      )
      .join(" · "),
  ];
}

function renderIssues(issues: string[]): string[] {
  const lines: string[] = [];
  for (const issue of issues) lines.push("", `> ${issue}`);
  return lines;
}

function renderSection(
  section: AudienceSection,
  ctx: {
    indexed: IndexedCluster[];
    items: AgentResultItem[];
    counts: SourceNativeAgg[];
    issues: string[];
    register: AudienceRegister;
  },
): string[] {
  switch (section) {
    case "clusters":
      return renderClusterSection(ctx.indexed, ctx.items);
    case "stats":
      return renderStatsLine(ctx.counts);
    case "source_coverage":
      return ctx.register.name === "default" ? [] : renderStatsLine(ctx.counts);
    case "source_outcomes":
      return renderIssues(ctx.issues);
    case "best_takes":
      return renderNamedList(
        "Best takes",
        rankItems(ctx.items, ctx.register, (item) => !isCommentItem(item), ctx.register.bestTakes),
      );
    case "top_comments":
      return renderNamedList(
        "Top comments",
        rankItems(ctx.items, ctx.register, isCommentItem, ctx.register.topComments),
      );
    case "hiring_signals":
      return [];
    default:
      return [];
  }
}

/** Markdown body for the saved brief. Results UI uses JSON; register only shapes this file. */
export function agentReportToMarkdown(
  report: AgentReport,
  options?: { register?: string },
): string {
  const register = getAudienceRegister(options?.register);
  const clusters = report.clusters || [];
  const items = report.results || [];
  const displayOpts: ClusterDisplayOptions = {
    register,
    query: report.query,
  };
  const filtered = filterItemsForDisplay(items, displayOpts);
  const indexed = indexClustersForDisplay(clusters, items, displayOpts);
  const groupedCount = indexed.filter((entry) => entry.memberCount > 1).length;
  const counts = sourceCounts({ ...report, results: filtered });
  const issues = sourceIssuesFromStatus(report.source_status);
  const dropped = Math.max(0, items.length - filtered.length);

  const lines: string[] = [];
  lines.push(`# ${report.query?.trim() || "Research"}`, "");

  if (register.blurb) {
    lines.push(`*${register.blurb}*`, "");
  }

  const metaParts: string[] = [];
  if (report.window_days != null) metaParts.push(`${report.window_days}d window`);
  if (report.generated_at) {
    try {
      metaParts.push(new Date(report.generated_at).toLocaleString());
    } catch {
      metaParts.push(report.generated_at);
    }
  }
  metaParts.push(`${indexed.length} clusters (${groupedCount} grouped)`);
  metaParts.push(`${filtered.length} items`);
  if (dropped > 0) metaParts.push(`${dropped} filtered`);
  if (register.name === "default") {
    metaParts.push("sorted by relevance");
  } else {
    metaParts.push(`${register.label} style`);
  }
  lines.push(metaParts.join(" · "), "");

  const ctx = { indexed, items: filtered, counts, issues, register };
  // Default matches the historical Results-shaped brief (issues + stats + clusters).
  const order: AudienceSection[] =
    register.name === "default"
      ? ["source_outcomes", "stats", "clusters"]
      : [...register.sectionOrder];

  const seenStats = { stats: false, coverage: false };
  for (const section of order) {
    if (section === "stats") {
      if (seenStats.stats) continue;
      seenStats.stats = true;
    }
    if (section === "source_coverage") {
      if (seenStats.coverage || seenStats.stats) continue;
      seenStats.coverage = true;
    }
    lines.push(...renderSection(section, ctx));
  }

  return `${lines.join("\n").trim()}\n`;
}
