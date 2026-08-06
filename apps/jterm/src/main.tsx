import "@joshu/design-system/tokens.css";
import "./styles.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

function resolveWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Float window is typically /jterm/ or /jterm/index.html — ArozOS proxies /jterm/* → subservice.
  const base = window.location.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "");
  return `${proto}//${window.location.host}${base}/ws`;
}

function JTermApp() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnState>("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      // Keep false — PTY already sends CR/LF; convertEol doubles lines and breaks TUI redraws.
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: {
        background: "#0a0a0a",
        foreground: "#5fdd8c",
        cursor: "#5fdd8c",
        selectionBackground: "rgba(95, 221, 140, 0.3)",
        black: "#0a0a0a",
        red: "#ff7b72",
        green: "#5fdd8c",
        yellow: "#f6e3a5",
        blue: "#79b8ff",
        magenta: "#c8a2a6",
        cyan: "#b7c0e0",
        white: "#f5f0eb",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    let closedByUs = false;
    let retryTimer: number | undefined;
    let resizeTimer: number | undefined;
    let lastCols = 0;
    let lastRows = 0;
    // Outer host size (CSS px) — ignore sub-cell ResizeObserver noise from scrollbar chrome.
    let lastHostW = 0;
    let lastHostH = 0;
    let ws: WebSocket | null = null;

    const hostSizeChangedEnough = (force: boolean): boolean => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!force && Math.abs(w - lastHostW) < 2 && Math.abs(h - lastHostH) < 2) {
        return false;
      }
      lastHostW = w;
      lastHostH = h;
      return true;
    };

    const sendResizeIfChanged = (force = false) => {
      if (!hostSizeChangedEnough(force)) return;
      fit.fit();
      const cols = term.cols;
      const rows = term.rows;
      if (!force && cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    const scheduleResize = () => {
      window.clearTimeout(resizeTimer);
      // Debounce — ArozOS float drag fires many events; Hermes redraws on every SIGWINCH.
      resizeTimer = window.setTimeout(() => sendResizeIfChanged(false), 120);
    };

    const connect = () => {
      setState((prev) => (prev === "connected" ? "reconnecting" : "connecting"));
      const url = resolveWsUrl();
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setState("connected");
        // Size PTY before the shell paints; do not write local banner into the buffer —
        // TUI apps (Hermes) clear/redraw the alternate screen and that looked "funky".
        lastCols = 0;
        lastRows = 0;
        sendResizeIfChanged(true);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
          return;
        }
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      };

      ws.onerror = () => {
        setState("error");
      };

      ws.onclose = () => {
        ws = null;
        if (closedByUs) {
          setState("disconnected");
          return;
        }
        setState("reconnecting");
        term.writeln("\r\n\x1b[33m[jTerm] disconnected — reconnecting…\x1b[0m");
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, 1200);
      };
    };

    const onData = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Raw text frames keep special keys / paste simple; server treats non-JSON as PTY bytes.
        ws.send(data);
      }
    });

    const onBinary = term.onBinary((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // onBinary gives a binary string; encode to bytes for the PTY.
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
        ws.send(bytes);
      }
    });

    window.addEventListener("resize", scheduleResize);
    const ro = new ResizeObserver(() => scheduleResize());
    ro.observe(host);

    connect();

    return () => {
      closedByUs = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", scheduleResize);
      ro.disconnect();
      onData.dispose();
      onBinary.dispose();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, []);

  return (
    <div className="jterm-app">
      <div className="jterm-banner">
        <div>
          <strong>jTerm</strong>{" "}
          <span className="muted">
            owner shell — Hermes CLI uses the same /root/.hermes as the gateway
          </span>
        </div>
        <div className="jterm-status" data-state={state}>
          {state}
        </div>
      </div>
      <div className="jterm-term" ref={hostRef} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <JTermApp />
    </React.StrictMode>,
  );
}
