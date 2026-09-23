/**
 * CDP screencast viewer for jWeb and mobile handoff.
 * Frames are JPEGs from Page.startScreencast. Clicks and keys go back as
 * normalized canvas coordinates; the server maps them into CSS pixels.
 */

export function connectScreencast(screenEl, websocketPath, { onStatus, pasteViaApi, copyViaApi, ui } = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  canvas.style.zIndex = "0";
  canvas.style.display = "block";
  canvas.tabIndex = 0;
  screenEl.replaceChildren(canvas);
  const ctx = canvas.getContext("2d");
  let ws = null;
  let closed = false;
  let frame = null;
  let meta = null;

  const status = (text) => {
    if (typeof onStatus === "function") onStatus(text);
  };

  function draw() {
    if (!frame || !ctx) return;
    if (canvas.width !== frame.naturalWidth || canvas.height !== frame.naturalHeight) {
      canvas.width = frame.naturalWidth;
      canvas.height = frame.naturalHeight;
    }
    ctx.drawImage(frame, 0, 0);
  }

  function normalizedFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      nx: (event.clientX - rect.left) / rect.width,
      ny: (event.clientY - rect.top) / rect.height,
    };
  }

  function send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function pointer(phase, event) {
    const point = normalizedFromEvent(event);
    if (!point) return;
    send({ type: "pointer", phase, ...point, button: event.button || 0 });
  }

  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    pointer("down", event);
    event.preventDefault();
  });
  canvas.addEventListener("pointerup", (event) => {
    pointer("up", event);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons) pointer("move", event);
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      const point = normalizedFromEvent(event);
      if (!point) return;
      send({ type: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
      event.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener("keydown", (event) => {
    send({
      type: "key",
      phase: "down",
      key: event.key,
      code: event.code,
      text: event.key.length === 1 ? event.key : "",
    });
    if (event.key.length === 1 || event.key === "Backspace" || event.key === "Enter") event.preventDefault();
  });
  canvas.addEventListener("keyup", (event) => {
    send({ type: "key", phase: "up", key: event.key, code: event.code, text: "" });
  });

  if (ui?.pasteBtn && pasteViaApi) {
    ui.pasteBtn.addEventListener("click", () => {
      const text = ui.textarea?.value ?? "";
      if (!text) return;
      void pasteViaApi(text).catch((err) => status(err.message || "paste failed"));
    });
  }
  if (ui?.copyBtn && copyViaApi) {
    ui.copyBtn.addEventListener("click", () => {
      void copyViaApi()
        .then((text) => {
          if (ui.textarea) ui.textarea.value = text || "";
        })
        .catch((err) => status(err.message || "copy failed"));
    });
  }

  let viewportTimer = 0;
  function reportViewerBox() {
    const rect = screenEl.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    send({ type: "viewport", width: Math.round(rect.width), height: Math.round(rect.height) });
  }
  const viewportObserver = new ResizeObserver(() => {
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(reportViewerBox, 350);
  });
  viewportObserver.observe(screenEl);

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = websocketPath.startsWith("/") ? websocketPath : `/${websocketPath}`;
  ws = new WebSocket(`${protocol}//${window.location.host}${path}`);
  ws.onopen = () => {
    status("connected");
    reportViewerBox();
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "rejected") {
      status("view only — the agent is working");
      return;
    }
    if (msg.type !== "frame" || typeof msg.data !== "string") return;
    meta = msg.metadata || null;
    const img = new Image();
    img.onload = () => {
      frame = img;
      draw();
      if (meta?.deviceWidth && meta?.deviceHeight) {
        status(`connected ${meta.deviceWidth}×${meta.deviceHeight}`);
      }
    };
    img.src = `data:image/jpeg;base64,${msg.data}`;
  };
  ws.onclose = () => {
    if (!closed) status("disconnected");
  };

  return {
    close() {
      closed = true;
      viewportObserver.disconnect();
      window.clearTimeout(viewportTimer);
      ws?.close();
      ws = null;
    },
    meta: () => meta,
  };
}
