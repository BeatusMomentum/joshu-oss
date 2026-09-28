#!/usr/bin/env npx tsx
/**
 * CDP relay: Hermes keeps one local endpoint while the Browser Use session
 * behind it changes (no config rewrite, no gateway restart).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { WebSocket, WebSocketServer } from "ws";

import { CdpRelay } from "../src/cdpRelay.ts";

/** A fake Browser Use CDP endpoint: /json/version + an echo WebSocket tagged with its name. */
async function fakeBrowser(name) {
  const server = http.createServer((req, res) => {
    const { port } = server.address();
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: name, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${name}` }));
      return;
    }
    if (req.url === "/json/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: "page1",
            type: "page",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page1`,
            devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/page1`,
          },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  const paths = [];
  wss.on("connection", (socket, req) => {
    paths.push(req.url);
    socket.on("message", (data) => socket.send(`${name}:${data.toString()}`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    name,
    url: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}

const a = await fakeBrowser("a");
const b = await fakeBrowser("b");
let current = a.url;
let resolveCalls = 0;
const relay = new CdpRelay({
  port: await freePort(),
  resolveUpstream: async () => {
    resolveCalls += 1;
    return current;
  },
});

try {
  await relay.start();
  relay.rotate();
  assert.equal(relay.generation, 1);

  // Discovery goes through the relay and points back at it.
  const version = await (await fetch(`${relay.url}/json/version`)).json();
  assert.equal(version.Browser, "a");
  assert.equal(version.webSocketDebuggerUrl, `${relay.url.replace("http:", "ws:")}/devtools/browser/a`);
  const list = await (await fetch(`${relay.url}/json/list`)).json();
  assert.equal(list[0].webSocketDebuggerUrl, `${relay.url.replace("http:", "ws:")}/devtools/page/page1`);
  assert.ok(list[0].devtoolsFrontendUrl.includes(`ws=${relay.url.replace("http://", "")}/devtools/page/page1`));

  // Commands are piped both ways, path preserved.
  const first = new WebSocket(version.webSocketDebuggerUrl);
  await once(first, "open");
  first.send("Target.getTargets");
  assert.equal(await nextMessage(first), "a:Target.getTargets");
  assert.deepEqual(a.paths, ["/devtools/browser/a"]);

  // The browser is replaced: clients are told (1012) and reconnect to the new one.
  current = b.url;
  const closed = once(first, "close");
  assert.equal(relay.rotate(), 2);
  const [code] = await closed;
  assert.equal(code, 1012);
  const second = new WebSocket(`${relay.url.replace("http:", "ws:")}/devtools/browser/b`);
  await once(second, "open");
  second.send("Page.navigate");
  assert.equal(await nextMessage(second), "b:Page.navigate");
  second.close();

  // Browser down → 502 on discovery, upgrade refused; the relay keeps serving.
  current = "http://127.0.0.1:1";
  assert.equal((await fetch(`${relay.url}/json/version`)).status, 502);
  const refused = new WebSocket(`${relay.url.replace("http:", "ws:")}/devtools/browser/x`);
  const [error] = await once(refused, "error");
  assert.match(String(error.message), /502/);
  assert.ok(resolveCalls >= 5, "every request asks for the live upstream");

  // Non-devtools upgrades are refused.
  current = a.url;
  const stray = new WebSocket(`${relay.url.replace("http:", "ws:")}/other`);
  const [strayError] = await once(stray, "error");
  assert.match(String(strayError.message), /404/);

  console.log("test-cdp-relay: ok");
} finally {
  await relay.stop();
  await a.close();
  await b.close();
}
