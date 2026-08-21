/**
 * Convention-based invoke handlers from joshu.app.json agent.actions[] → apiPrefix REST.
 * Explicit registerAppAction() handlers always win (jmail syncMirror, etc.).
 */

import type { JoshuAppManifest } from "@joshu/app-sdk";

import {
  getAppActionHandler,
  hasAppActionHandler,
  loadAppManifests,
  registerAppAction,
} from "./appRegistry.js";

const GET_ACTIONS = new Set([
  "doctor",
  "status",
  "preflight",
  "diagnose",
  "welcome",
  "config",
  "sources",
  "watchingList",
  "watchingReport",
]);

/** Long-running POST actions — default fire-and-forget unless args.wait === true. */
const ASYNC_POST_ACTIONS = new Set([
  "research",
  "discover",
  "drill",
  "verifyFreshness",
  "watchingRun",
  "watchingRunAll",
]);

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Forward Hermes session to research POST; strip from engine args. */
function stripSessionFieldsFromResearchBody(args: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...args };
  const hermesSessionKey = readString(payload.hermesSessionKey);
  const hermesSessionId = readString(payload.hermesSessionId);
  delete payload.hermesSessionKey;
  delete payload.hermesSessionId;
  delete payload.wait;
  delete payload.timeoutMs;
  if (hermesSessionKey) payload.hermesSessionKey = hermesSessionKey;
  if (hermesSessionId) payload.hermesSessionId = hermesSessionId;
  return payload;
}

function apiPathFromManifest(manifest: JoshuAppManifest, action: string): string {
  const prefix = readString(manifest.apiPrefix) || `/joshu/api/${manifest.id}`;
  const base = prefix.replace(/\/+$/, "");
  return `${base}/${action}`;
}

async function joshuFetch(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : `Request failed: ${res.status}`,
    );
  }
  return { status: res.status, body };
}

function summarizeStdout(stdout: unknown): string | undefined {
  if (typeof stdout !== "string" || !stdout.trim()) return undefined;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { query?: string; clusters?: unknown[]; results?: unknown[] };
      const clusters = Array.isArray(parsed.clusters) ? parsed.clusters.length : 0;
      const results = Array.isArray(parsed.results) ? parsed.results.length : 0;
      return `${parsed.query ?? "research"} — ${clusters} clusters, ${results} items`;
    } catch {
      /* fall through */
    }
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

async function pollRunUntilDone(
  apiPrefix: string,
  runId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const base = apiPrefix.replace(/\/+$/, "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await joshuFetch(`http://127.0.0.1:8788${base}/runs/${encodeURIComponent(runId)}`, {
      cache: "no-store",
    });
    const run = body.run as Record<string, unknown> | undefined;
    const status = readString(run?.status);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return {
        runId,
        status,
        exitCode: run?.exitCode ?? null,
        stdout: run?.stdout ?? "",
        stderrLines: run?.stderrLines ?? [],
        error: run?.error,
        summary: summarizeStdout(run?.stdout),
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}

function createProxyHandler(
  manifest: JoshuAppManifest,
  action: string,
  boxOrigin: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const url = `${boxOrigin}${apiPathFromManifest(manifest, action)}`;
  const isGet = GET_ACTIONS.has(action);
  const isAsync = ASYNC_POST_ACTIONS.has(action);

  return async (args) => {
    const wait = args.wait === true;
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 600_000;

    if (isGet) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (key === "wait" || key === "timeoutMs") continue;
        if (value != null && value !== "") query.set(key, String(value));
      }
      const qs = query.toString();
      const { body } = await joshuFetch(qs ? `${url}?${qs}` : url, { cache: "no-store" });
      return body;
    }

    const { status, body } = await joshuFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stripSessionFieldsFromResearchBody(args)),
    });

    if (isAsync && status === 202) {
      const runId = readString(body.runId);
      if (!wait) {
        return { ok: true, runId, status: readString(body.status) || "running", async: true };
      }
      if (!runId) throw new Error("Expected runId from async action");
      return pollRunUntilDone(readString(manifest.apiPrefix) || `/joshu/api/${manifest.id}`, runId, timeoutMs);
    }

    return body;
  };
}

/** Register default invoke proxies for manifests that declare agent.actions without explicit handlers. */
export async function registerManifestInvokeHandlers(
  projectRoot: string,
  boxOrigin = "http://127.0.0.1:8788",
): Promise<number> {
  await loadAppManifests(projectRoot);
  let registered = 0;

  for (const manifest of [...(await loadAppManifests(projectRoot)).values()]) {
    const actions = manifest.agent?.actions ?? [];
    if (!actions.length) continue;
    if (!readString(manifest.apiPrefix) && !manifest.id) continue;

    for (const actionDef of actions) {
      const action = readString(actionDef.name);
      if (!action) continue;
      if (hasAppActionHandler(manifest.id, action)) continue;

      registerAppAction(manifest.id, action, createProxyHandler(manifest, action, boxOrigin));
      registered += 1;
    }
  }

  return registered;
}

/** Test helper — resolve handler after manifest registration. */
export function resolveInvokeHandlerForTest(appId: string, action: string) {
  return getAppActionHandler(appId, action);
}
