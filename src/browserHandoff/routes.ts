import type { Request, Response, Router } from "express";
import type { CamofoxSessionCoordinator } from "../camofoxSession.js";
import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import { browserHandoffLockStub, publicHandoffView } from "./lock.js";
import {
  cancelHandoff,
  completeHandoff,
  createHandoff,
  extendHandoffExpiry,
  getHandoffRecord,
  getPendingHandoffPinUrl,
  handoffUrlForRecord,
  isBrowserHandoffLocked,
  setHandoffLastScan,
} from "./store.js";
import { verifyHandoffToken } from "./token.js";
import { scanCatalogWithLlm } from "./formScan.js";
import { deliverSmsHandoffContinuation } from "./smsContinue.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function handoffTokenFromRequest(req: Request): { t: string; exp: string } | null {
  const t = readString(req.query.t) || readString((req.body as Record<string, unknown>)?.t);
  const exp = readString(req.query.exp) || readString((req.body as Record<string, unknown>)?.exp);
  if (!t || !exp) return null;
  return { t, exp };
}

function verifyHandoffAccess(req: Request, id: string): { ok: true } | { ok: false; status: number; error: string } {
  const tokenParts = handoffTokenFromRequest(req);
  if (!tokenParts) {
    return { ok: false, status: 401, error: "handoff_token_required" };
  }
  const verified = verifyHandoffToken(id, tokenParts.exp, tokenParts.t);
  if (!verified.ok) {
    return { ok: false, status: 401, error: verified.reason };
  }
  return { ok: true };
}

async function touchCamofoxKeepalive(camofoxSession: CamofoxSessionCoordinator): Promise<void> {
  await camofoxSession.listTabs().catch(() => undefined);
}

function isHandoffLocatorId(value: string): boolean {
  return /^f\d+-[eb]\d+$/.test(value);
}

function pendingHandoffOrError(
  projectRoot: string,
  id: string,
): { record: ReturnType<typeof getHandoffRecord> } | { error: string; status: number } {
  const record = getHandoffRecord(projectRoot, id);
  if (!record) return { error: "handoff_not_found", status: 404 };
  if (record.status !== "pending") return { error: "handoff_not_pending", status: 409 };
  return { record };
}

export function registerBrowserHandoffRoutes(
  router: Router,
  opts: {
    projectRoot: string;
    camofoxSession: CamofoxSessionCoordinator;
  },
): void {
  const { projectRoot, camofoxSession } = opts;

  router.get("/api/browser-handoff/lock", (_req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(_req)) {
      res.status(403).json({ error: "browser-handoff lock is localhost-only" });
      return;
    }
    const lock = isBrowserHandoffLocked(projectRoot);
    res.json({ ok: true, ...lock });
  });

  router.post("/api/browser-handoff/request", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff request is localhost-only" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const instructions = readString(body.instructions);
    if (!instructions) {
      res.status(400).json({ error: "instructions is required" });
      return;
    }

    try {
      const tab = await camofoxSession.currentTab();
      if (!tab?.url || tab.url === "about:blank") {
        res.status(409).json({ error: "no_active_browser_tab", message: "Navigate to checkout before requesting handoff." });
        return;
      }

      let observation;
      try {
        observation = await camofoxSession.observe(tab);
      } catch {
        observation = undefined;
      }

      const record = createHandoff(projectRoot, {
        pageUrl: observation?.url ?? tab.url,
        pageTitle: observation?.title ?? tab.title ?? "",
        instructions,
        kanbanTaskId: readString(body.kanbanTaskId) || undefined,
        hermesSessionKey: readString(body.hermesSessionKey) || undefined,
      });

      res.json({
        ok: true,
        handoffId: record.id,
        status: record.status,
        url: handoffUrlForRecord(record),
        pageUrl: record.pageUrl,
        pageTitle: record.pageTitle,
        expiresAt: record.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("browser_handoff_already_pending:")) {
        const existingId = message.split(":")[1] ?? "";
        res.status(409).json({ error: "browser_handoff_already_pending", handoffId: existingId });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  router.get("/api/browser-handoff/status/:id", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff status is localhost-only" });
      return;
    }
    const id = readString(req.params.id);
    const record = getHandoffRecord(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    res.json({ ok: true, handoff: record });
  });

  router.post("/api/browser-handoff/:id/cancel", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff cancel is localhost-only" });
      return;
    }
    const id = readString(req.params.id);
    const record = cancelHandoff(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    res.json({ ok: true, handoff: record });
  });

  router.post("/api/browser-handoff/:id/heartbeat", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const record = extendHandoffExpiry(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    if (record.status !== "pending") {
      res.status(409).json({ error: "handoff_not_pending", status: record.status });
      return;
    }
    await touchCamofoxKeepalive(camofoxSession);
    res.json({ ok: true, handoff: publicHandoffView(record) });
  });

  router.post("/api/browser-handoff/:id/complete", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const record = completeHandoff(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    await touchCamofoxKeepalive(camofoxSession);
    res.json({ ok: true, handoff: publicHandoffView(record) });
    void deliverSmsHandoffContinuation(projectRoot, record).catch((err) => {
      console.warn("[browser-handoff] SMS continuation error:", err);
    });
  });

  /** Cheap URL + control-shape key for auto-rescan. No LLM, no owner values, no locator stamps. */
  router.get("/api/browser-handoff/:id/page-key", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    try {
      const signature = await camofoxSession.readFormSignature();
      res.json({ ok: true, pageUrl: signature.url, pageTitle: signature.title, pageKey: signature.key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  /** Scan remote controls (AI labels only). Never includes owner-typed overlay values. */
  router.get("/api/browser-handoff/:id/form-fields", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    try {
      const catalog = await camofoxSession.listFormFields();
      const overlay = await scanCatalogWithLlm(catalog);
      setHandoffLastScan(projectRoot, id, {
        fieldIds: overlay.fields.map((field) => field.id),
        primaryButtonId: overlay.primaryButtonId,
        scannedAt: new Date().toISOString(),
      });
      await touchCamofoxKeepalive(camofoxSession);
      const signature = await camofoxSession.readFormSignature().catch(() => undefined);
      res.json({
        ok: true,
        fields: overlay.fields,
        primaryButtonId: overlay.primaryButtonId,
        primaryButtonLabel: overlay.primaryButtonLabel,
        source: overlay.source,
        pageUrl: signature?.url,
        pageTitle: signature?.title,
        pageKey: signature?.key,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  /**
   * Fill stamped controls from the overlay. Owner values go Joshu → Camofox only.
   * Do not log req.body — it may contain passwords / OTPs / cards.
   */
  router.post("/api/browser-handoff/:id/fill-form", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    const record = pending.record;
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const allowed = new Set(record.lastScan?.fieldIds ?? []);
    const fields: Array<{ id: string; value: string | boolean }> = [];
    for (const row of rawFields) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const fieldId = readString(rec.id);
      if (!isHandoffLocatorId(fieldId)) continue;
      if (allowed.size > 0 && !allowed.has(fieldId)) continue;
      if (typeof rec.value === "boolean") {
        fields.push({ id: fieldId, value: rec.value });
        continue;
      }
      if (typeof rec.value === "string" && rec.value.length > 0) {
        fields.push({ id: fieldId, value: rec.value });
      }
    }
    const clickPrimary = body.clickPrimary === true;
    const fromScan = record.lastScan?.primaryButtonId ?? null;
    const buttonId =
      clickPrimary && fromScan && isHandoffLocatorId(fromScan) ? fromScan : null;
    if (fields.length === 0 && !buttonId) {
      res.status(400).json({ error: "nothing_to_fill" });
      return;
    }
    try {
      const result = await camofoxSession.fillForm({ fields, buttonId });
      await touchCamofoxKeepalive(camofoxSession);
      res.json({
        ok: result.ok,
        filled: result.filled,
        missing: result.missing,
        clicked: result.clicked,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  router.get("/handoff/:id", (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).type("text/plain").send(`Handoff link invalid or expired (${access.error}).`);
      return;
    }
    const record = getHandoffRecord(projectRoot, id);
    if (!record) {
      res.status(404).type("text/plain").send("Handoff not found.");
      return;
    }
    if (record.status !== "pending") {
      res.status(409).type("text/plain").send(`Handoff is ${record.status}.`);
      return;
    }

    const t = readString(req.query.t);
    const exp = readString(req.query.exp);
    const config = JSON.stringify({
      handoffId: record.id,
      token: t,
      exp,
      instructions: record.instructions,
      pageUrl: record.pageUrl,
      pageTitle: record.pageTitle,
      expiresAt: record.expiresAt,
    })
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Joshu browser handoff</title>
  <base href="../" />
  <link rel="stylesheet" href="handoff-shell.css" />
</head>
<body>
  <div id="handoff-root"></div>
  <script id="handoff-config" type="application/json">${config}</script>
  <script type="module" src="handoff.js"></script>
</body>
</html>`);
  });
}

export { browserHandoffLockStub, getPendingHandoffPinUrl };
