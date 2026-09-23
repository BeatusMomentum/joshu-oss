/**
 * Client for the browser-use sidecar (browser/chromium/agent-service.py).
 * One run at a time, attached to the Chromium Joshu already launched.
 */
import type { Request, Response as ExpressResponse, Router } from "express";
import { browserHandoffLockStub } from "./browserHandoff/lock.js";
import { isBrowserHandoffLocked } from "./browserHandoff/store.js";
import { isDirectLocalhostRequest } from "./httpLocalhost.js";

export type BrowserAgentPhase = "idle" | "running" | "paused" | "done" | "error" | "unreachable";

export type BrowserAgentStatus = {
  phase: BrowserAgentPhase;
  task?: string;
  result?: string;
  error?: string;
  url?: string;
};

const DEFAULT_AGENT_URL = "http://127.0.0.1:9378";

let phase: BrowserAgentPhase = "idle";

export function browserAgentUrl(): string {
  const raw = (process.env.BROWSER_AGENT_URL || DEFAULT_AGENT_URL).trim();
  return raw.replace(/\/+$/, "");
}

export function noteBrowserAgentPhase(next: BrowserAgentPhase): void {
  phase = next;
}

export function browserAgentPhase(): BrowserAgentPhase {
  return phase;
}

/** Owner can click the screencast during handoff or whenever the agent is not stepping. */
export function screencastInputAllowed(projectRoot: string): boolean {
  if (isBrowserHandoffLocked(projectRoot).locked) return true;
  return phase !== "running";
}

async function agentFetch(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  return fetch(`${browserAgentUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function readBrowserAgentStatus(): Promise<BrowserAgentStatus> {
  try {
    const res = await agentFetch("/status");
    if (!res.ok) {
      noteBrowserAgentPhase("unreachable");
      return { phase: "unreachable", error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as BrowserAgentStatus;
    if (data.phase) noteBrowserAgentPhase(data.phase);
    return data;
  } catch (err) {
    noteBrowserAgentPhase("unreachable");
    return { phase: "unreachable", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pauseBrowserAgent(): Promise<void> {
  noteBrowserAgentPhase("paused");
  await agentFetch("/pause", { method: "POST" }).catch(() => undefined);
}

export async function resumeBrowserAgent(): Promise<void> {
  await agentFetch("/resume", { method: "POST" }).catch(() => undefined);
  await readBrowserAgentStatus().catch(() => undefined);
}

export function registerBrowserAgentRoutes(router: Router, projectRoot: string): void {
  router.get("/api/browser-agent/status", async (req: Request, res: ExpressResponse) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-agent status is localhost-only" });
      return;
    }
    res.json({ ok: true, ...(await readBrowserAgentStatus()) });
  });

  router.post("/api/browser-agent/task", async (req: Request, res: ExpressResponse) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-agent task is localhost-only" });
      return;
    }
    const locked = browserHandoffLockStub(projectRoot);
    if (locked) {
      res.status(423).json(locked);
      return;
    }
    const task = String((req.body as { task?: unknown } | undefined)?.task ?? "").trim();
    if (!task) {
      res.status(400).json({ error: "task is required" });
      return;
    }
    const result = await runBrowserAgentTask(task);
    if (result.phase === "error") {
      res.status(502).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result });
  });
}

/** Blocks until the sidecar run finishes, including time spent paused for handoff. */
export async function runBrowserAgentTask(task: string): Promise<BrowserAgentStatus> {
  noteBrowserAgentPhase("running");
  try {
    const res = await agentFetch(
      "/task",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      },
      20 * 60_000,
    );
    const data = (await res.json().catch(() => ({}))) as BrowserAgentStatus & { error?: string };
    if (!res.ok) {
      noteBrowserAgentPhase("error");
      return { phase: "error", error: data.error || `HTTP ${res.status}`, task };
    }
    if (data.phase) noteBrowserAgentPhase(data.phase);
    return data;
  } catch (err) {
    noteBrowserAgentPhase("error");
    return { phase: "error", error: err instanceof Error ? err.message : String(err), task };
  }
}
