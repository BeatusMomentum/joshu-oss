import type { Response } from "express";

/** Keep SSE idle gaps under typical edge idle timeouts (Cloudflare HTTP ~100s). */
export const SSE_HEARTBEAT_MS = 15_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function flush(res: Response): void {
  const maybeFlush = (res as Response & { flush?: () => void }).flush;
  maybeFlush?.();
}

/** Named SSE event (`event:` + `data:`). */
export function sseSend(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  flush(res);
}

/** Comment frame (`:`). Clients ignore these; proxies treat them as activity. */
export function sseHeartbeat(res: Response): void {
  if (res.writableEnded) return;
  res.write(":\n\n");
  flush(res);
}

/** Data-only SSE (AG-UI / some clients). */
export function sseData(res: Response, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  flush(res);
}

export function startSseHeartbeat(res: Response, intervalMs = SSE_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => sseHeartbeat(res), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
