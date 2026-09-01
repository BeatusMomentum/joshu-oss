import type { Request, Response, Router } from "express";
import { handleBrowserGateRoute } from "./browserGate.js";
import { isActionGuardEnabled, loadActionGuardPolicy } from "./policy.js";
import { loadMcpToolPolicy } from "../mcpToolPolicy.js";
import { ownerChannelStatus } from "../ownerChannel/config.js";
import { twilioSmsGatewayEnabled } from "../twilioSmsSend.js";

export function registerActionGuardRoutes(router: Router, opts: { projectRoot: string }): void {
  const { projectRoot } = opts;

  router.get("/api/mcp-tool-policy", (_req: Request, res: Response) => {
    res.json({ ok: true, policy: loadMcpToolPolicy() });
  });

  router.get("/api/action-guard/status", (_req: Request, res: Response) => {
    const policy = loadActionGuardPolicy(projectRoot);
    const owner = ownerChannelStatus(projectRoot);
    res.json({
      ok: true,
      enabled: isActionGuardEnabled(projectRoot),
      policy,
      ownerChannel: owner,
      ownerChannelLinked: owner.linked,
      smsConfigured: twilioSmsGatewayEnabled(projectRoot),
    });
  });

  router.post("/api/action-guard/browser", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await handleBrowserGateRoute(body, projectRoot);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
