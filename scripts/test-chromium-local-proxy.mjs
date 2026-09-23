#!/usr/bin/env node
/**
 * Proves localProxy injects Proxy-Authorization for CONNECT without client auth.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { basicAuthHeader, createAuthInjectProxy } from "../browser/chromium/localProxy.mjs";

const USER = "testuser";
const PASS = "testpass";
const AUTH = basicAuthHeader(USER, PASS);
const LISTEN = 18777;

/** Fake Decodo: 407 without Proxy-Authorization, 200 with it. */
const upstream = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("latin1");
    if (!buf.includes("\r\n\r\n")) return;
    const lines = buf.split("\r\n");
    const hasAuth = lines.some((line) => line.toLowerCase().startsWith("proxy-authorization:"));
    if (!hasAuth) {
      socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      socket.end();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.write("tunnel-ok");
    socket.end();
  });
});

await new Promise((resolve, reject) => {
  upstream.listen(0, "127.0.0.1", resolve);
  upstream.on("error", reject);
});
const upstreamPort = upstream.address().port;

const local = await createAuthInjectProxy({
  listenHost: "127.0.0.1",
  listenPort: LISTEN,
  getUpstream: () => ({ host: "127.0.0.1", port: upstreamPort }),
  getAuthHeader: () => AUTH,
});

try {
  const body = await new Promise((resolve, reject) => {
    const socket = net.connect(LISTEN, "127.0.0.1");
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("tunnel-ok")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    });
    setTimeout(() => reject(new Error(`timeout: ${response}`)), 5000);
  });

  assert.match(body, /200 Connection Established/i);
  assert.match(body, /tunnel-ok/);
  console.log("local auth proxy: ok");
} finally {
  await local.close();
  await new Promise((resolve) => upstream.close(resolve));
}

/** First port refuses the tunnel; the proxy must rotate and complete on the next. */
{
  const dead = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.end();
    });
  });
  const live = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.write("rotated-ok");
      socket.end();
    });
  });
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => live.listen(0, "127.0.0.1", resolve));
  const deadPort = dead.address().port;
  const livePort = live.address().port;
  let current = deadPort;
  const failures = [];
  const rotating = await createAuthInjectProxy({
    listenHost: "127.0.0.1",
    listenPort: LISTEN + 1,
    getUpstream: () => ({ host: "127.0.0.1", port: current }),
    getAuthHeader: () => AUTH,
    maxAttempts: 2,
    onUpstreamFailure: (_upstream, reason) => {
      failures.push(reason);
      current = livePort;
    },
  });
  try {
    const body = await new Promise((resolve, reject) => {
      const socket = net.connect(LISTEN + 1, "127.0.0.1");
      let response = "";
      socket.on("data", (chunk) => {
        response += chunk.toString("latin1");
        if (response.includes("rotated-ok")) {
          socket.destroy();
          resolve(response);
        }
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("CONNECT alaskaair.com:443 HTTP/1.1\r\nHost: alaskaair.com:443\r\n\r\n");
      });
      setTimeout(() => reject(new Error(`timeout: ${response}`)), 5000);
    });
    assert.match(body, /200 Connection Established/i);
    assert.match(body, /rotated-ok/);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /502/);
    console.log("local auth proxy rotate: ok");
  } finally {
    await rotating.close();
    await new Promise((resolve) => dead.close(resolve));
    await new Promise((resolve) => live.close(resolve));
  }
}
