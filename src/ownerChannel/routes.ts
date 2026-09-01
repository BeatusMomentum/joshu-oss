import type { Request, Response, Router } from "express";
import { awaitOwnerApproval } from "../actionGuard/gate.js";
import { isActionGuardEnabled, loadActionGuardPolicy } from "../actionGuard/policy.js";
import { createPending, cleanupPending } from "../actionGuard/pending.js";
import {
  ownerChannelStatus,
  readOwnerChannelConfig,
  writeOwnerChannelConfig,
} from "./config.js";
import { notifyOwnerForApproval } from "./notify.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function handleAwaitRoute(req: Request, res: Response, projectRoot: string): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionId = readString(body.actionId);
  if (!actionId) {
    res.status(400).json({ error: "actionId is required" });
    return;
  }
  const summary =
    body.summary && typeof body.summary === "object" && !Array.isArray(body.summary)
      ? (body.summary as Record<string, unknown>)
      : {};
  const bypassGuard = body.bypassGuard === true;

  try {
    const result = await awaitOwnerApproval({ actionId, summary, bypassGuard }, projectRoot);
    if (result.decision === "unavailable") {
      res.status(503).json({
        ok: false,
        error: result.unavailableCode ?? "owner_channel_unavailable",
        message: result.unavailableReason,
        decision: result.decision,
      });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerOwnerChannelRoutes(router: Router, opts: { projectRoot: string }): void {
  const { projectRoot } = opts;

  router.get("/api/connectors/owner-channel/status", (_req: Request, res: Response) => {
    const status = ownerChannelStatus(projectRoot);
    const policy = loadActionGuardPolicy(projectRoot);
    res.json({
      ok: true,
      ...status,
      gateEnabled: isActionGuardEnabled(projectRoot),
      gateMode: status.gateMode ?? policy.gateMode,
    });
  });

  router.put("/api/connectors/owner-channel", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const existing = readOwnerChannelConfig(projectRoot);
    const gateModeRaw = readString(body.gateMode);
    const gateMode =
      gateModeRaw === "allowlist" || gateModeRaw === "external_writes"
        ? gateModeRaw
        : existing?.gateMode;

    writeOwnerChannelConfig(
      {
        provider: "sms",
        gateMode,
        updatedAt: new Date().toISOString(),
      },
      projectRoot,
    );
    res.json({ ok: true, ...ownerChannelStatus(projectRoot) });
  });

  router.post("/api/owner-channel/await", async (req, res) => handleAwaitRoute(req, res, projectRoot));

  // Legacy alias for MCP proxy during migration
  router.post("/api/action-guard/await", async (req, res) => handleAwaitRoute(req, res, projectRoot));

  router.post("/api/owner-channel/test", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const policy = loadActionGuardPolicy(projectRoot);
    const pending = createPending(
      "owner_channel:test",
      { note: readString(body.note) || "Test approval from Connectors" },
      policy.approvalTimeoutMs,
      projectRoot,
    );
    try {
      await notifyOwnerForApproval(
        pending.id,
        "owner_channel:test",
        { note: readString(body.note) || "Test approval from Connectors" },
        projectRoot,
      );
      res.json({
        ok: true,
        pendingId: pending.id,
        message: "Test sent — reply Y or N by SMS to approve or deny.",
      });
    } catch (err) {
      cleanupPending(pending.id, projectRoot);
      res.status(503).json({
        ok: false,
        error: err instanceof Error && "code" in err ? (err as { code: string }).code : "owner_channel_test_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
