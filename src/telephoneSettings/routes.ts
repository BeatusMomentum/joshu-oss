import type { Request, Response, Router } from "express";
import { normalizeE164, readTelephoneStatus } from "./resolve.js";
import { writeTelephoneSettingsFile } from "./store.js";

/** Two spoken English words (or a short phrase) — keep STT-friendly. */
function validateThinkPassword(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 3) {
    throw new Error("Passphrase must be at least 3 characters");
  }
  if (value.length > 64) {
    throw new Error("Passphrase must be 64 characters or fewer");
  }
  // Prefer words/spaces/apostrophes; reject control chars.
  if (!/^[\w\s'-]+$/u.test(value)) {
    throw new Error("Passphrase may only use letters, numbers, spaces, apostrophes, and hyphens");
  }
  return value;
}

export function registerTelephoneRoutes(
  router: Router,
  opts: { projectRoot: string },
): void {
  const { projectRoot } = opts;

  router.get("/api/telephone", (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, telephone: readTelephoneStatus(projectRoot) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/telephone", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      thinkPassword?: string;
      phoneNumber?: string;
    };
    try {
      const updates: { thinkPassword?: string; phoneNumber?: string } = {};
      if (typeof body.thinkPassword === "string") {
        updates.thinkPassword = validateThinkPassword(body.thinkPassword);
      }
      if (typeof body.phoneNumber === "string") {
        const n = normalizeE164(body.phoneNumber);
        if (body.phoneNumber.trim() && !n) {
          throw new Error("Phone number looks invalid");
        }
        updates.phoneNumber = n;
      }
      if (!Object.keys(updates).length) {
        res.status(400).json({ error: "Provide thinkPassword and/or phoneNumber" });
        return;
      }
      writeTelephoneSettingsFile(updates, projectRoot);
      res.json({
        ok: true,
        telephone: readTelephoneStatus(projectRoot),
        note:
          updates.thinkPassword !== undefined
            ? "Passphrase saved. New inbound calls will use it immediately."
            : "Saved.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
