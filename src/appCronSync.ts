/**
 * Sync Hermes cron jobs from app manifests or imperative app events.
 */

import type { JoshuAppManifest } from "@joshu/app-sdk";

import { callCronBridge, type CronBridgeJobSummary } from "./hermesCronBridge.js";

export type AppCronJobDef = {
  id: string;
  name?: string;
  schedule: string;
  /** noAgent script under ~/.hermes/scripts/ */
  script?: string;
  noAgent?: boolean;
  prompt?: string;
  skills?: string[];
  deliver?: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

/** Upsert a Hermes cron job by stable display name. */
export async function registerAppCronJob(job: AppCronJobDef): Promise<"created" | "updated"> {
  const name = readString(job.name) || job.id;
  const existing = (await listJobs()).find((row) => row.name === name);
  const payload: Record<string, unknown> = {
    schedule: job.schedule,
    name,
    deliver: job.deliver ?? "local",
  };
  if (job.noAgent || job.script) {
    payload.no_agent = true;
    if (job.script) payload.script = job.script;
  }
  if (job.prompt) payload.prompt = job.prompt;
  if (job.skills?.length) payload.skills = job.skills;

  if (existing?.job_id) {
    const result = await callCronBridge({ action: "update", job_id: existing.job_id, ...payload });
    if (!result.success) {
      throw new Error(typeof result.error === "string" ? result.error : `cron update failed for ${name}`);
    }
    return "updated";
  }

  const result = await callCronBridge({ action: "create", ...payload });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : `cron create failed for ${name}`);
  }
  return "created";
}

type ManifestCronBlock = {
  jobs?: Array<{
    id?: string;
    name?: string;
    schedule?: string;
    noAgent?: boolean;
    script?: string;
    prompt?: string;
    skills?: string[];
    deliver?: string;
    invoke?: { action?: string; args?: Record<string, unknown> };
  }>;
};

/** Sync static cron.jobs[] from a multimodal manifest (best-effort). */
export async function syncManifestCronJobs(manifest: JoshuAppManifest & { cron?: ManifestCronBlock }): Promise<number> {
  const jobs = manifest.cron?.jobs ?? [];
  let synced = 0;
  for (const row of jobs) {
    const schedule = readString(row.schedule);
    const id = readString(row.id);
    if (!schedule || !id) continue;

    let script = readString(row.script);
    if (!script && row.invoke?.action) {
      script = `${manifest.id}-invoke-${row.invoke.action}.sh`;
    }

    await registerAppCronJob({
      id,
      name: readString(row.name) || `${manifest.name}: ${id}`,
      schedule,
      noAgent: row.noAgent ?? Boolean(script),
      script: script || undefined,
      prompt: readString(row.prompt) || undefined,
      skills: row.skills,
      deliver: readString(row.deliver) || "local",
    });
    synced += 1;
  }
  return synced;
}
