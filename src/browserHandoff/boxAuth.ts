import type { Request, Response } from "express";

import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import {
  HANDOFF_AUTH_COOKIE,
  mintHandoffAuthToken,
  readCookieValue,
  verifyHandoffAuthToken,
} from "./token.js";

/**
 * Same-origin return path helper (legacy ArozOS login.html?redirect=).
 * The handoff gate is now Joshu-hosted so this is only used as a lock against
 * open redirects if something still builds that URL.
 */
export function sanitizeHandoffReturnPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/joshu/handoff/")) return "";
  if (trimmed.startsWith("//") || trimmed.includes("\\") || /[\r\n]/.test(trimmed)) return "";
  const pathOnly = trimmed.split("?")[0] ?? "";
  if (!/^\/joshu\/handoff\/[0-9a-fA-F-]{8,}$/.test(pathOnly)) return "";
  return trimmed;
}

export function boxLoginRedirectLocation(originalUrl: string): string {
  const safe = sanitizeHandoffReturnPath(originalUrl);
  const target = safe || "/joshu/";
  return `/login.html?redirect=${encodeURIComponent(target)}`;
}

export type HandoffAccess =
  | { ok: true }
  | { ok: false; status: number; error: string; loginRedirect?: string };

function cookiePath(): string {
  const base = (process.env.PUBLIC_BASE_PATH ?? "/joshu").trim().replace(/\/+$/, "");
  return base || "/";
}

function requestIsHttps(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  return proto === "https";
}

/**
 * An existing ArozOS desktop session is NOT enough. Handoff always requires
 * a fresh username/password check, minted into this cookie.
 * Direct localhost (tests / Hermes) skips the prompt.
 */
export function verifyOwnerHandoffSession(req: Request, handoffId: string, expRaw: string): HandoffAccess {
  if (isDirectLocalhostRequest(req)) return { ok: true };
  const token = readCookieValue(String(req.headers.cookie ?? ""), HANDOFF_AUTH_COOKIE);
  const verified = verifyHandoffAuthToken(handoffId, expRaw, token);
  if (verified.ok) return { ok: true };
  return { ok: false, status: 401, error: "box_login_required" };
}

export function setHandoffAuthCookie(
  req: Request,
  res: Response,
  handoffId: string,
  hmacExpiresAtMs: number,
  cookieExpiresAtMs: number,
): void {
  const token = mintHandoffAuthToken(handoffId, hmacExpiresAtMs);
  const maxAge = Math.max(60, Math.floor((cookieExpiresAtMs - Date.now()) / 1000));
  const parts = [
    `${HANDOFF_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${cookiePath()}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (requestIsHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function arozosLoginUrl(): string {
  const port = (process.env.PUBLIC_AROZ_PORT ?? "8787").trim() || "8787";
  return `http://127.0.0.1:${port}/system/auth/login`;
}

/** Check box username/password against ArozOS. Never log the password. */
export async function verifyArozosPassword(username: string, password: string): Promise<"ok" | "invalid" | "unavailable"> {
  const user = username.trim();
  if (!user || !password) return "invalid";
  try {
    const body = new URLSearchParams({ username: user, password, rmbme: "false" });
    const res = await fetch(arozosLoginUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (data && typeof data.error === "string" && data.error.trim()) return "invalid";
    if (!res.ok) return "unavailable";
    return "ok";
  } catch {
    return "unavailable";
  }
}
