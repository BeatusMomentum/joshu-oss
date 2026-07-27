import type { Request, Response } from "express";

/** Allow local ArozOS subservices (:8787) to call Joshu APIs on :8788. */
export function setLocalhostCors(
  req: Request,
  res: Response,
  options: { methods?: string; headers?: string } = {},
): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", options.headers ?? "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", options.methods ?? "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
  } catch {
    // Invalid Origin headers receive no CORS grant.
  }
}
