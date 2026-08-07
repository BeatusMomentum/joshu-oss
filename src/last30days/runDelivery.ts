/**
 * Completion delivery for last30days runs — gbrain markdown export + Hermes session reply.
 */

import type { Last30DaysRunRecord } from "./runner.js";
import { persistRunRecord } from "./runner.js";
import { deliverResearchToHermesSession } from "./hermesSessionReply.js";
import { writeLast30DaysResearchReport, type ResearchExportResult } from "./researchExport.js";

/** Write gbrain markdown and persist paths — synchronous before SSE `done`. */
export function exportLast30DaysRunReport(
  projectRoot: string,
  run: Last30DaysRunRecord,
): ResearchExportResult | null {
  const exportResult = writeLast30DaysResearchReport(projectRoot, run);
  persistRunRecord(projectRoot, run);
  return exportResult;
}

/** Hermes session reply after export (async, out-of-app only). */
export async function notifyLast30DaysRunSession(
  projectRoot: string,
  run: Last30DaysRunRecord,
  exportResult: ResearchExportResult | null,
): Promise<void> {
  await deliverResearchToHermesSession(projectRoot, run, exportResult).catch(() => undefined);
}

/** Export report file and notify originating Hermes session when configured. */
export async function completeLast30DaysRunDelivery(
  projectRoot: string,
  run: Last30DaysRunRecord,
): Promise<void> {
  const exportResult = exportLast30DaysRunReport(projectRoot, run);
  await notifyLast30DaysRunSession(projectRoot, run, exportResult);
}
