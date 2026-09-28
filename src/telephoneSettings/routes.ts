import type { Request, Response, Router } from "express";
import { normalizeE164, normalizeOwnerMobile, readTelephoneStatus } from "./resolve.js";
import { writeTelephoneSettingsFile, type TelephoneSettingsUpdate } from "./store.js";

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

/** Weak PINs are the first thing anyone tries. */
const WEAK_PINS = /^(\d)\1+$|^(0123|1234|2345|3456|4567|5678|6789|123456|234567|345678|456789|12345678|0000|1111|4321|654321|87654321)$/;

function validatePin(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (!/^\d{4,8}$/.test(value)) throw new Error("PIN must be 4 to 8 digits");
  if (WEAK_PINS.test(value)) throw new Error("That PIN is too easy to guess — avoid repeated or sequential digits");
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
      ownerCaller?: string;
      pin?: string;
      trustVerifiedCallerId?: boolean;
    };
    try {
      const updates: TelephoneSettingsUpdate = {};
      if (typeof body.pin === "string") updates.pin = validatePin(body.pin);
      if (typeof body.trustVerifiedCallerId === "boolean") {
        updates.trustVerifiedCallerId = body.trustVerifiedCallerId;
      }
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
      if (typeof body.ownerCaller === "string") {
        const n = normalizeOwnerMobile(body.ownerCaller);
        if (body.ownerCaller.trim() && !n) {
          throw new Error("Owner mobile looks invalid — use a full number with country code (e.g. +1…)");
        }
        updates.ownerCaller = n;
      }
      if (!Object.keys(updates).length) {
        res.status(400).json({
          error: "Provide thinkPassword, phoneNumber, ownerCaller, pin, and/or trustVerifiedCallerId",
        });
        return;
      }
      writeTelephoneSettingsFile(updates, projectRoot);
      if (updates.ownerCaller !== undefined) {
        void import("../onboarding/reconcileOnboardingBoard.js")
          .then(({ reconcileOnboardingBoard }) => reconcileOnboardingBoard(projectRoot))
          .catch((err) => {
            console.warn(`[onboarding] reconcile after telephone save: ${(err as Error).message}`);
          });
      }
      const notes: string[] = [];
      if (updates.thinkPassword !== undefined) {
        notes.push("Passphrase saved. New inbound calls will use it immediately.");
      }
      if (updates.pin !== undefined) {
        notes.push(updates.pin ? "PIN saved. Callers can key it in instead of saying the passphrase." : "PIN removed.");
      }
      if (updates.trustVerifiedCallerId !== undefined) {
        notes.push(
          updates.trustVerifiedCallerId
            ? "Calls from your verified mobile number skip the passphrase."
            : "Every call asks for the passphrase again.",
        );
      }
      if (updates.ownerCaller !== undefined) {
        notes.push(
          updates.ownerCaller
            ? "Owner mobile saved. SMS approvals and the owner voice greeting use it immediately."
            : "Owner mobile cleared. SMS approvals stay off until a number is set again.",
        );
      }
      res.json({
        ok: true,
        telephone: readTelephoneStatus(projectRoot),
        note: notes.join(" ") || "Saved.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
