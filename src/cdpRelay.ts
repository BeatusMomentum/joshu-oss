/**
 * Stable local CDP endpoint in front of Browser Use Cloud.
 *
 * Every Browser Use session has its own CDP URL. Hermes had that URL in its
 * config, so each new session rewrote the config and restarted the gateway —
 * five times on 2026-09-26, under live voice turns and Kanban workers. Hermes
 * now points at this relay for good; the relay forwards to whichever session is
 * current and bumps `generation` when the browser behind it changes (Hermes
 * then drops sessions bound to the old browser — see
 * scripts/patch-hermes-browser-cdp-guards.mjs).
 *
 * Localhost only. The relay adds no capability: any local process that could
 * read the cloud CDP URL could already drive the browser.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

export const DEFAULT_CDP_RELAY_PORT = 9333;

export function cdpRelayPort(): number {
  const raw = Number.parseInt(process.env.JOSHU_CDP_RELAY_PORT?.trim() ?? "", 10);
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_CDP_RELAY_PORT;
}

export type CdpRelayOptions = {
  port: number;
  host?: string;
  /** Current upstream CDP URL (http(s) or ws(s)); wakes the browser when needed. */
  resolveUpstream: () => Promise<string>;
};

function httpBase(upstream: string): string {
  return upstream
    .trim()
    .replace(/^ws(s?):\/\//i, "http$1://")
    .replace(/\/+$/, "");
}

function wsBase(upstream: string): string {
  return httpBase(upstream).replace(/^http(s?):\/\//i, "ws$1://");
}

export class CdpRelay {
  private server: http.Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly clients = new Set<WebSocket>();
  private generationValue = 0;
  private readonly host: string;

  constructor(private readonly options: CdpRelayOptions) {
    this.host = options.host ?? "127.0.0.1";
  }

  /** What Hermes is configured with (never changes). */
  get url(): string {
    return `http://${this.host}:${this.options.port}`;
  }

  get generation(): number {
    return this.generationValue;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    console.log(`[cdp-relay] listening ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * The browser behind the relay changed: bump the generation and close every
   * client socket so the next command reconnects to the new browser.
   */
  rotate(): number {
    this.generationValue += 1;
    for (const client of this.clients) {
      try {
        client.close(1012, "cdp upstream rotated");
      } catch {
        client.terminate();
      }
    }
    this.clients.clear();
    console.log(`[cdp-relay] upstream browser changed — generation ${this.generationValue}`);
    return this.generationValue;
  }

  /** Rewrite upstream WebSocket URLs in /json responses to point at the relay. */
  private rewrite(body: string, upstreamHost: string): string {
    const relayHost = `${this.host}:${this.options.port}`;
    return body
      .split(`wss://${upstreamHost}`)
      .join(`ws://${relayHost}`)
      .split(`ws://${upstreamHost}`)
      .join(`ws://${relayHost}`)
      .split(`wss=${upstreamHost}`)
      .join(`ws=${relayHost}`)
      .split(`ws=${upstreamHost}`)
      .join(`ws=${relayHost}`);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const upstream = httpBase(await this.options.resolveUpstream());
      const upstreamHost = new URL(upstream).host;
      const response = await fetch(`${upstream}${req.url ?? "/"}`, {
        method: req.method === "PUT" ? "PUT" : "GET",
        signal: AbortSignal.timeout(15_000),
      });
      const body = this.rewrite(await response.text(), upstreamHost);
      res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "cdp_upstream_unavailable", message: (error as Error).message }));
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = req.url ?? "/";
    if (!path.startsWith("/devtools/")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    let upstreamUrl: string;
    try {
      upstreamUrl = `${wsBase(await this.options.resolveUpstream())}${path}`;
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
      return;
    }
    const generation = this.generationValue;
    const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false });
    upstream.once("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
    upstream.once("open", () => {
      if (generation !== this.generationValue) {
        // The browser changed while we were connecting.
        upstream.terminate();
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      upstream.removeAllListeners("error");
      this.wss.handleUpgrade(req, socket, head, (client) => this.pipe(client, upstream));
    });
  }

  private pipe(client: WebSocket, upstream: WebSocket): void {
    this.clients.add(client);
    const closeBoth = (code?: number, reason?: string) => {
      this.clients.delete(client);
      const safeCode = code && code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000;
      if (client.readyState === WebSocket.OPEN) client.close(safeCode, reason);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(safeCode, reason);
    };
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    client.on("error", () => closeBoth(1011));
    upstream.on("error", () => closeBoth(1011));
  }
}
