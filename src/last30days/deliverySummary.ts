/**
 * Delivery copy for Hermes session replies when a last30days run completes out-of-app.
 */

import type { Last30DaysRunRecord } from "./runner.js";
import { topicFromRunArgv } from "./runner.js";
import type { ResearchExportResult } from "./researchExport.js";
import { indexClustersForDisplay, tryParseAgentReport } from "./agentReportFormat.js";

/** Internal user message for proactive Hermes session turn after async research. */
export function buildLast30DaysSessionDeliveryPrompt(
  run: Last30DaysRunRecord,
  exportResult: ResearchExportResult | null,
): string {
  const topic = run.topic?.trim() || topicFromRunArgv(run.argv) || "research";
  const reportPath = exportResult?.joshuUri || run.outputRelativePath
    ? `joshu://${(run.outputRelativePath ?? exportResult?.relativePath ?? "").replace(/^\/+/, "")}`
    : undefined;

  if (run.status === "failed" || run.status === "cancelled") {
    return (
      `[last30days research ${run.status}] Topic: "${topic}".` +
      (run.error ? ` Error: ${run.error}` : "") +
      (reportPath ? ` Report file: ${reportPath}` : "")
    );
  }

  const report = tryParseAgentReport(run.stdout);
  if (report) {
    const nClusters = report.clusters?.length ?? 0;
    const nItems = report.results?.length ?? 0;
    const indexed = indexClustersForDisplay(report.clusters || [], report.results || []);
    const leading = indexed[0]?.cluster?.title?.trim();
    let stats = `${nClusters} clusters, ${nItems} items`;
    if (leading) stats += `; top theme: "${leading}"`;
    return (
      `[last30days research completed] Topic: "${report.query ?? topic}"` +
      (report.window_days ? ` (${report.window_days} days)` : "") +
      `. ${stats}.` +
      (reportPath
        ? ` Full report saved to ${reportPath} — readable via filesystem tools and openable on the Joshu desktop.`
        : "")
    );
  }

  const excerpt = run.stdout.trim().slice(0, 800);
  return (
    `[last30days research completed] Topic: "${topic}".` +
    (excerpt ? ` Output preview: ${excerpt}` : "") +
    (reportPath ? ` Report file: ${reportPath}` : "")
  );
}
