/**
 * Write completed last30days runs to gbrain-friendly markdown under research/last30days/.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { requestBrainReindex } from "../brainApi.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { agentReportToMarkdown, tryParseAgentReport } from "./agentReportFormat.js";
import type { Last30DaysRunRecord } from "./runner.js";
import { topicFromRunArgv } from "./runner.js";

/** Relative to JOSHU_FILES_ROOT — path prefix drives gbrain "research" page type. */
export const LAST30DAYS_RESEARCH_SUBDIR = "research/last30days";

export type ResearchExportResult = {
  absolutePath: string;
  /** Path from JOSHU_FILES_ROOT (POSIX slashes). */
  relativePath: string;
  joshuUri: string;
};

function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "topic";
}

function formatDateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildResearchMarkdownBody(
  run: Last30DaysRunRecord,
  topic: string,
  report: ReturnType<typeof tryParseAgentReport>,
): string {
  const lines: string[] = [];

  if (run.status === "failed" || run.status === "cancelled") {
    lines.push(`# last30days — ${topic}`, "", `**Status:** ${run.status}`, "");
    if (run.error?.trim()) lines.push("## Error", "", run.error.trim(), "");
    const tail = run.stdout.trim();
    if (tail) lines.push("## Output", "", "```", tail.slice(0, 12_000), "```");
    return lines.join("\n");
  }

  if (report) {
    lines.push(agentReportToMarkdown(report).trimEnd());
  } else {
    const excerpt = run.stdout.trim();
    lines.push(`# ${topic}`, "");
    if (excerpt) {
      lines.push("## Raw output", "", "```json", excerpt.slice(0, 24_000), "```");
    }
  }

  lines.push(
    "",
    "## Metadata",
    "",
    `- Run id: \`${run.id}\``,
    `- Engine argv topic: \`${topic}\``,
  );

  return lines.join("\n");
}

export function buildResearchMarkdown(
  run: Last30DaysRunRecord,
  topic: string,
  relativePath: string,
): string {
  const report = tryParseAgentReport(run.stdout);
  const frontmatter: Record<string, unknown> = {
    type: "research",
    source: "last30days",
    topic,
    run_id: run.id,
    status: run.status,
    generated_at: new Date(run.updatedAt || run.createdAt).toISOString(),
    joshu_uri: `joshu://${relativePath.replace(/^\/+/, "")}`,
  };
  if (report?.query) frontmatter.query = report.query;
  if (report?.window_days != null) frontmatter.window_days = report.window_days;
  if (report?.clusters) frontmatter.clusters = report.clusters.length;
  if (report?.results) frontmatter.items = report.results.length;

  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trim();
  const body = buildResearchMarkdownBody(run, topic, report);
  return `---\n${yaml}\n---\n\n${body}\n`;
}

/** Persist report markdown and queue gbrain reindex. Mutates run.outputRelativePath on success. */
export function writeLast30DaysResearchReport(
  projectRoot: string,
  run: Last30DaysRunRecord,
): ResearchExportResult | null {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths) {
    console.warn("[last30days] research export skipped — JOSHU_FILES_ROOT unavailable");
    return null;
  }

  const topic = run.topic?.trim() || topicFromRunArgv(run.argv) || "research";
  const date = formatDateStamp(run.createdAt);
  const slug = slugifyTopic(topic);
  const shortId = run.id.slice(0, 8);
  const filename = `${date}-${slug}-${shortId}.md`;
  const relativePath = `${LAST30DAYS_RESEARCH_SUBDIR}/${filename}`.replace(/\\/g, "/");
  const absolutePath = path.join(paths.filesRoot, LAST30DAYS_RESEARCH_SUBDIR, filename);
  const joshuUri = `joshu://${relativePath}`;

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, buildResearchMarkdown(run, topic, relativePath), {
    mode: 0o600,
    encoding: "utf8",
  });

  run.outputRelativePath = relativePath;
  run.topic = topic;

  const reindex = requestBrainReindex();
  if (!reindex.ok) {
    console.warn(`[last30days] gbrain reindex touch failed: ${reindex.error}`);
  }

  return { absolutePath, relativePath, joshuUri };
}
