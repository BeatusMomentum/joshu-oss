/**
 * Public ArozOS login recovery. Fleet boxes email via the control plane;
 * standalone/OSS boxes stay SSH-only. Never returns owner email or instance id.
 */
import type { Request, Response, Router } from "express";
import { isStandaloneSelfHost } from "../boxSecrets/resolve.js";
import { provisionEnvTrim } from "../provisionInstanceEnv.js";
import { checkShareChatRateLimit } from "../shareChat/rateLimit.js";

function clientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

function recoveryMode(): "email" | "ssh" {
  return isStandaloneSelfHost() ? "ssh" : "email";
}

function controlPlaneBaseUrl(): string | undefined {
  return provisionEnvTrim("CONTROL_PLANE_URL")?.replace(/\/+$/, "");
}

function instanceAgentBearer(): string | undefined {
  const instanceId = provisionEnvTrim("JOSHU_INSTANCE_ID");
  const raw = provisionEnvTrim("INSTANCE_AGENT_TOKEN");
  if (!instanceId || !raw) return undefined;
  if (raw.startsWith(`${instanceId}.`)) return raw;
  return `${instanceId}.${raw}`;
}

async function notifyControlPlane(requestedFrom: string): Promise<void> {
  const base = controlPlaneBaseUrl();
  const bearer = instanceAgentBearer();
  if (!base || !bearer) {
    console.warn("[auth-recovery] skip CP notify: missing CONTROL_PLANE_URL or agent token");
    return;
  }
  const url = `${base}/api/instances/box-password-reset`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Forwarded-For": requestedFrom,
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[auth-recovery] CP ${res.status} ${text.slice(0, 200)}`);
  }
}

export function registerAuthRecoveryRoutes(router: Router): void {
  router.get("/api/auth/recovery", (_req: Request, res: Response) => {
    res.json({ mode: recoveryMode() });
  });

  router.post("/api/auth/recovery/request", (req: Request, res: Response) => {
    const ip = clientIp(req);
    const rate = checkShareChatRateLimit(`auth-recovery:${ip}`, {
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    // Always 200 — do not enumerate fleet vs rate-limit vs missing owner.
    if (recoveryMode() === "ssh") {
      res.json({ ok: true, mode: "ssh" });
      return;
    }
    if (!rate.allowed) {
      console.warn(`[auth-recovery] rate_limited ip=${ip}`);
      res.json({ ok: true, mode: "email" });
      return;
    }
    void notifyControlPlane(ip).catch((err) => {
      console.warn(
        "[auth-recovery] CP notify failed",
        err instanceof Error ? err.message : String(err),
      );
    });
    res.json({ ok: true, mode: "email" });
  });
}
