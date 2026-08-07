/**
 * Shared last30days agent JSON report parsing + display ordering.
 * Used by the Results panel (apps/last30days) and research markdown export.
 */

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
};

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

/** Display clusters by engagement; keep original idx for result membership. */
export function indexClustersForDisplay(
  clusters: AgentCluster[],
  items: AgentResultItem[],
): IndexedCluster[] {
  return clusters
    .map((cluster, idx) => ({
      cluster,
      idx,
      memberCount: items.filter((item) => item.cluster === idx).length,
    }))
    .sort((a, b) => {
      const engA = a.cluster.engagement_total ?? 0;
      const engB = b.cluster.engagement_total ?? 0;
      if (engB !== engA) return engB - engA;
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return a.idx - b.idx;
    });
}

export function membersForCluster(
  items: AgentResultItem[],
  clusterIdx: number,
  limit = 6,
): AgentResultItem[] {
  return items
    .filter((item) => item.cluster === clusterIdx)
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, limit);
}

export function sourceCounts(
  report: AgentReport,
): { name: string; count: number; status?: string }[] {
  const counts = new Map<string, number>();
  for (const item of report.results || []) {
    const src = (item.source || "unknown").toLowerCase();
    counts.set(src, (counts.get(src) || 0) + 1);
  }
  const names = new Set<string>([...counts.keys(), ...Object.keys(report.source_status || {})]);
  return [...names]
    .sort()
    .map((name) => ({
      name,
      count: counts.get(name) || 0,
      status: report.source_status?.[name],
    }));
}

/** Markdown body matching the in-app Results panel (engagement-sorted clusters + member links). */
export function agentReportToMarkdown(report: AgentReport): string {
  const clusters = report.clusters || [];
  const items = report.results || [];
  const indexed = indexClustersForDisplay(clusters, items);
  const groupedCount = indexed.filter((entry) => entry.memberCount > 1).length;
  const counts = sourceCounts(report);
  const issues = sourceIssuesFromStatus(report.source_status);

  const lines: string[] = [];
  lines.push(`# ${report.query?.trim() || "Research"}`, "");

  const metaParts: string[] = [];
  if (report.window_days != null) metaParts.push(`${report.window_days}d window`);
  if (report.generated_at) {
    try {
      metaParts.push(new Date(report.generated_at).toLocaleString());
    } catch {
      metaParts.push(report.generated_at);
    }
  }
  metaParts.push(`${clusters.length} clusters (${groupedCount} grouped)`);
  metaParts.push(`${items.length} items`);
  metaParts.push("sorted by engagement");
  lines.push(metaParts.join(" · "), "");

  for (const issue of issues) {
    lines.push("", `> ${issue}`);
  }

  if (counts.length) {
    lines.push("", counts.map((c) => `${c.name} **${c.count}**`).join(" · "));
  }

  for (const [displayRank, { cluster, idx, memberCount }] of indexed.entries()) {
    lines.push("");
    const title = cluster.title?.trim() || `Cluster ${displayRank + 1}`;
    lines.push(`## ${displayRank + 1}. ${title}`);

    if (cluster.summary?.trim() && cluster.summary !== cluster.title) {
      lines.push("", cluster.summary.trim());
    }

    const stats: string[] = [];
    if (memberCount > 1) stats.push(`${memberCount} items`);
    for (const source of cluster.sources || []) stats.push(source);
    if (typeof cluster.engagement_total === "number") {
      stats.push(`${cluster.engagement_total.toLocaleString()} eng`);
    }
    if (stats.length) lines.push("", stats.join(" · "));

    const members = membersForCluster(items, idx);
    if (members.length) {
      lines.push("");
      for (const item of members) {
        const label =
          item.title?.trim() || item.summary?.trim() || item.url || "Untitled";
        const meta = [item.source || "?", item.published_at].filter(Boolean).join(" · ");
        if (item.url) lines.push(`- [${label}](${item.url}) — ${meta}`);
        else lines.push(`- ${label} — ${meta}`);
      }
    }
  }

  return `${lines.join("\n").trim()}\n`;
}
