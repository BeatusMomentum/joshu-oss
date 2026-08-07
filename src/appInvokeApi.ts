/**
 * POST /joshu/api/apps/:appId/invoke — unified app action entry (GUI, cron, MCP, AG-UI tools).
 */

import type { Request, Response, Router } from "express";
import {
  getAppActionHandler,
  getAppManifest,
  loadAppManifests,
  registerAppAction,
  type JoshuAppManifest,
} from "./appRegistry.js";
import { registerManifestInvokeHandlers } from "./appInvokeRegistry.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function joshuJson<T>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase.replace(/\/+$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed: ${res.status}`,
    );
  }
  return body as T;
}

export function registerBuiltInAppActions(apiBase: string): void {
  registerAppAction("jmail", "connectorsStatus", async () =>
    joshuJson(apiBase, "/connectors/status", { cache: "no-store" }),
  );

  registerAppAction("jmail", "syncMirror", async (args) => {
    const provider = readString(args.provider) || "nylas";
    return joshuJson(apiBase, `/connectors/mail/${provider}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: Number(args.limit) || 100,
        days: Number(args.days) || 7,
        ifEmpty: args.ifEmpty === true,
        connectedAccountId: readString(args.connectedAccountId) || undefined,
      }),
    });
  });

  registerAppAction("schedules", "listCronJobs", async () =>
    joshuJson(apiBase, "/cron/jobs", { cache: "no-store" }),
  );
}

export function registerAppInvokeRoutes(router: Router, projectRoot: string, apiBase: string): void {
  registerBuiltInAppActions(apiBase);
  const boxOrigin = process.env.JOSHU_BOX_ORIGIN?.trim() || "http://127.0.0.1:8788";
  let manifestHandlersReady: Promise<number> | null = null;
  const ensureManifestHandlers = () => {
    if (!manifestHandlersReady) {
      manifestHandlersReady = registerManifestInvokeHandlers(projectRoot, boxOrigin);
    }
    return manifestHandlersReady;
  };
  void ensureManifestHandlers().catch((err) => {
    console.warn("[app-invoke] manifest proxy registration failed:", err);
  });

  router.get("/api/apps", async (_req: Request, res: Response) => {
    await loadAppManifests(projectRoot);
    const apps = [...(await loadAppManifests(projectRoot)).values()].map((m: JoshuAppManifest) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      apiPrefix: m.apiPrefix,
      data: m.data,
      agent: m.agent
        ? { skill: m.agent.skill, usesSkills: m.agent.usesSkills, headless: m.agent.headless, actions: m.agent.actions }
        : undefined,
    }));
    res.json({ apps });
  });

  router.post("/api/apps/:appId/invoke", async (req: Request, res: Response) => {
    const appId = readString(req.params.appId);
    const action = readString((req.body as { action?: unknown })?.action);
    const args = ((req.body as { args?: unknown })?.args ?? {}) as Record<string, unknown>;

    if (!appId || !action) {
      return res.status(400).json({ error: "appId and action are required" });
    }

    await ensureManifestHandlers();
    await loadAppManifests(projectRoot);
    if (!getAppManifest(appId)) {
      return res.status(404).json({ error: `Unknown app: ${appId}` });
    }

    const handler = getAppActionHandler(appId, action);
    if (!handler) {
      return res.status(404).json({ error: `Unknown action ${action} for app ${appId}` });
    }

    try {
      const body = (req.body ?? {}) as {
        action?: unknown;
        args?: unknown;
        hermesSessionKey?: unknown;
        hermesSessionId?: unknown;
      };
      const sessionKey =
        readString(req.headers["x-hermes-session-key"]) || readString(body.hermesSessionKey);
      const sessionId =
        readString(req.headers["x-hermes-session-id"]) || readString(body.hermesSessionId);
      const enrichedArgs = {
        ...args,
        ...(sessionKey ? { hermesSessionKey: sessionKey } : {}),
        ...(sessionId ? { hermesSessionId: sessionId } : {}),
      };
      const result = await handler(enrichedArgs);
      res.json({ ok: true, appId, action, result });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        appId,
        action,
      });
    }
  });
}
