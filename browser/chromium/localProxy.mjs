/**
 * Local HTTP proxy that injects Proxy-Authorization for upstream Decodo.
 *
 * Playwright's proxy username/password only apply to Playwright-initiated
 * traffic. Hermes and Joshu attach via raw CDP, so Chrome must talk to a proxy
 * that does not require client-side auth — this process adds the header upstream.
 */
import http from "node:http";
import net from "node:net";

function basicAuthHeader(username, password) {
  const user = (username || "").trim();
  if (!user) return "";
  const token = Buffer.from(`${user}:${password || ""}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function relayEstablished(clientSocket, upstream, head, rest, queued = []) {
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head?.length) upstream.write(head);
  for (const buf of queued) upstream.write(buf);
  if (rest?.length) clientSocket.write(rest);
  upstream.resume();
  upstream.on("data", (chunk) => clientSocket.write(chunk));
  clientSocket.on("data", (chunk) => upstream.write(chunk));
  clientSocket.on("end", () => upstream.end());
  upstream.on("end", () => clientSocket.end());
  clientSocket.on("error", () => upstream.destroy());
  upstream.on("error", () => clientSocket.destroy());
}

/**
 * One CONNECT attempt. Does not write to the client — the caller retries
 * another upstream port before Chrome is told the tunnel failed.
 */
function attemptConnect(upstream, target, auth) {
  return new Promise((resolve) => {
    const socket = net.connect(upstream.port, upstream.host);
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("timeout");
      resolve(result);
    };
    socket.setTimeout(8000, () => {
      socket.destroy();
      finish({ ok: false, reason: "timeout" });
    });
    socket.on("error", (err) => {
      socket.destroy();
      finish({ ok: false, reason: err.code || err.message || "error" });
    });
    socket.on("connect", () => {
      let headers = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
      if (auth) headers += `Proxy-Authorization: ${auth}\r\n`;
      headers += "\r\n";
      socket.write(headers);
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const marker = buf.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const headerBlock = buf.subarray(0, marker + 4).toString("latin1");
      const rest = buf.subarray(marker + 4);
      const statusLine = headerBlock.split("\r\n")[0] || "";
      socket.pause();
      if (!/^HTTP\/1\.[01] 200/i.test(statusLine)) {
        socket.destroy();
        finish({ ok: false, reason: statusLine || "bad status" });
        return;
      }
      finish({ ok: true, socket, rest });
    });
  });
}

/**
 * @param {{
 *   listenHost?: string,
 *   listenPort: number,
 *   getUpstream: () => { host: string, port: number } | null,
 *   getAuthHeader: () => string,
 *   maxAttempts?: number,
 *   onUpstreamFailure?: (upstream: { host: string, port: number }, reason: string) => void,
 * }} options
 */
export function createAuthInjectProxy(options) {
  const listenHost = options.listenHost || "127.0.0.1";
  const listenPort = options.listenPort;

  const server = http.createServer((req, res) => {
    const upstream = options.getUpstream();
    if (!upstream) {
      res.writeHead(502);
      res.end("no upstream proxy");
      return;
    }

    const target = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const headers = { ...req.headers, host: target.host };
    const auth = options.getAuthHeader();
    if (auth) headers["proxy-authorization"] = auth;

    const proxyReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      options.onUpstreamFailure?.(upstream, "http error");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });

  server.on("connect", (req, clientSocket, head) => {
    const target = req.url || "";
    const queued = [];
    const onClientData = (chunk) => queued.push(chunk);
    clientSocket.on("data", onClientData);

    const fail = (statusLine) => {
      clientSocket.removeListener("data", onClientData);
      if (!clientSocket.destroyed) {
        clientSocket.write(statusLine || "HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
      }
    };

    const maxAttempts = Math.max(1, options.maxAttempts || 1);
    const tried = new Set();
    (async () => {
      let lastReason = "";
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (clientSocket.destroyed) return;
        const upstream = options.getUpstream();
        if (!upstream) break;
        const key = `${upstream.host}:${upstream.port}`;
        if (tried.has(key)) break;
        tried.add(key);
        const result = await attemptConnect(upstream, target, options.getAuthHeader());
        if (result.ok && result.socket) {
          clientSocket.removeListener("data", onClientData);
          relayEstablished(clientSocket, result.socket, head, result.rest, queued);
          return;
        }
        lastReason = result.reason || "connect failed";
        options.onUpstreamFailure?.(upstream, lastReason);
      }
      console.warn(`[local-proxy] CONNECT ${target} failed after ${tried.size} port(s): ${lastReason}`);
      fail("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    })().catch((err) => {
      console.warn(`[local-proxy] CONNECT ${target} error: ${err instanceof Error ? err.message : err}`);
      fail("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(listenPort, listenHost, () => {
      resolve({
        server,
        url: `http://${listenHost}:${listenPort}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on("error", reject);
  });
}

export { basicAuthHeader };
