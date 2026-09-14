import { attachVncClipboard } from "./vnc-clipboard.js";
import { attachVncScrollBridge } from "./vnc-scroll.js";

function readConfig() {
  const el = document.getElementById("handoff-config");
  if (!el?.textContent) throw new Error("missing handoff config");
  return JSON.parse(el.textContent);
}

function truncateUrl(url, max = 72) {
  if (!url || url.length <= max) return url || "";
  return `${url.slice(0, max - 1)}…`;
}

function renderShell(root, cfg) {
  root.innerHTML = `
    <header class="handoff-header">
      <h1>Finish in browser</h1>
      <p class="handoff-instructions"></p>
      <p class="handoff-meta"></p>
      <div class="handoff-actions">
        <button type="button" class="handoff-btn" id="handoff-scan">Scan fields</button>
        <button type="button" class="handoff-btn handoff-btn-primary" id="handoff-done">I'm done</button>
      </div>
    </header>
    <div id="vnc-frame">
      <div id="status">connecting…</div>
      <div id="vnc-screen" aria-label="Shared browser via noVNC"></div>
    </div>
    <section class="handoff-overlay" id="handoff-overlay">
      <p class="handoff-overlay-status" id="handoff-overlay-status">Scanning page fields…</p>
      <form class="handoff-fields" id="handoff-fields"></form>
      <div class="handoff-overlay-actions">
        <button type="button" class="handoff-btn handoff-btn-primary" id="handoff-fill" disabled>Fill fields</button>
      </div>
      <details class="handoff-clipboard-fallback">
        <summary>Paste into focused field</summary>
        <div class="vnc-clipboard-bar">
          <textarea id="vnc-clipboard-text" class="vnc-clipboard-text" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off"
            placeholder="Tap a field in the picture, type here, then Paste" aria-label="Fallback clipboard for missed fields"></textarea>
          <button type="button" id="vnc-paste-remote" class="vnc-clipboard-btn vnc-clipboard-btn-primary">Paste into field</button>
          <button type="button" id="vnc-copy-remote" class="vnc-clipboard-btn">Copy from browser</button>
          <p class="vnc-clipboard-hint">Fallback when a control is not in the list above (CAPTCHA, custom widgets).</p>
        </div>
      </details>
    </section>
  `;
  root.querySelector(".handoff-instructions").textContent = cfg.instructions || "Complete the staged checkout step.";
  root.querySelector(".handoff-meta").textContent = cfg.pageTitle
    ? `${cfg.pageTitle} — ${truncateUrl(cfg.pageUrl)}`
    : truncateUrl(cfg.pageUrl);
}

function wsUrl(path) {
  const u = new URL(path, document.baseURI || location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function camofoxBrowserReady(camofox) {
  const h = camofox?.health;
  return Boolean(h?.browserRunning || h?.browserConnected || (h?.activeTabs ?? 0) > 0);
}

function nativeInputType(overlayType) {
  if (overlayType === "email") return "email";
  if (overlayType === "password") return "password";
  if (overlayType === "tel") return "tel";
  if (overlayType === "number") return "number";
  return "text";
}

function collectOverlayValues(formEl) {
  const fields = [];
  for (const el of formEl.querySelectorAll("[data-field-id]")) {
    const id = el.getAttribute("data-field-id");
    if (!id) continue;
    if (el.type === "checkbox" || el.type === "radio") {
      fields.push({ id, value: el.checked });
      continue;
    }
    const value = typeof el.value === "string" ? el.value : "";
    if (value) fields.push({ id, value });
  }
  return fields;
}

function renderOverlayFields(formEl, scan) {
  formEl.innerHTML = "";
  for (const field of scan.fields || []) {
    const wrap = document.createElement("label");
    wrap.className = "handoff-field";
    const caption = document.createElement("span");
    caption.className = "handoff-field-label";
    caption.textContent = field.label || "Field";
    wrap.appendChild(caption);
    if (field.inputType === "select") {
      const sel = document.createElement("select");
      sel.dataset.fieldId = field.id;
      sel.setAttribute("autocomplete", "off");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Choose…";
      sel.appendChild(blank);
      for (const opt of field.options || []) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        sel.appendChild(o);
      }
      if (field.prefill) sel.value = field.prefill;
      wrap.appendChild(sel);
    } else if (field.inputType === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.fieldId = field.id;
      input.checked = field.checked === true;
      wrap.appendChild(input);
    } else if (field.inputType === "radio") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.fieldId = field.id;
      input.checked = field.checked === true;
      wrap.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.type = nativeInputType(field.inputType);
      input.dataset.fieldId = field.id;
      input.autocapitalize = "off";
      input.autocorrect = "off";
      input.spellcheck = false;
      if (field.inputType === "password") input.autocomplete = "off";
      if (field.prefill && field.inputType !== "password") input.value = field.prefill;
      wrap.appendChild(input);
    }
    formEl.appendChild(wrap);
  }
}

async function main() {
  const cfg = readConfig();
  const root = document.getElementById("handoff-root");
  renderShell(root, cfg);

  const statusEl = document.getElementById("status");
  const frameEl = document.getElementById("vnc-frame");
  const screenEl = document.getElementById("vnc-screen");
  const doneBtn = document.getElementById("handoff-done");
  const scanBtn = document.getElementById("handoff-scan");
  const fillBtn = document.getElementById("handoff-fill");
  const fieldsForm = document.getElementById("handoff-fields");
  const overlayStatus = document.getElementById("handoff-overlay-status");
  const metaEl = root.querySelector(".handoff-meta");
  const fb = { width: 1024, height: 768 };
  let rfb = null;
  let heartbeatTimer = null;
  let lastWarmAt = 0;
  let lastScan = { fields: [], primaryButtonId: null, primaryButtonLabel: null };
  let lastPageKey = "";
  let scanInFlight = false;
  let fillInFlight = false;
  let quietUntil = 0;

  const tokenQuery = `t=${encodeURIComponent(cfg.token)}&exp=${encodeURIComponent(cfg.exp)}`;

  async function postJson(path, body = {}) {
    const res = await fetch(`${path}?${tokenQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, t: cfg.token, exp: cfg.exp }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function getJson(path) {
    const res = await fetch(`${path}?${tokenQuery}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function updateFillButton() {
    const label = lastScan.primaryButtonLabel;
    fillBtn.disabled = (lastScan.fields || []).length === 0 && !lastScan.primaryButtonId;
    fillBtn.textContent = label ? `Fill and continue (${label})` : "Fill fields";
  }

  function overlayBusy() {
    if (scanInFlight || fillInFlight) return true;
    if (Date.now() < quietUntil) return true;
    return false;
  }

  function applyPageMeta(pageTitle, pageUrl) {
    if (!metaEl || !pageUrl) return;
    metaEl.textContent = pageTitle ? `${pageTitle} — ${truncateUrl(pageUrl)}` : truncateUrl(pageUrl);
  }

  function rememberPageKey(data) {
    if (typeof data?.pageKey === "string") lastPageKey = data.pageKey;
    applyPageMeta(data?.pageTitle, data?.pageUrl);
  }

  async function scanFields() {
    if (scanInFlight) return;
    scanInFlight = true;
    scanBtn.disabled = true;
    overlayStatus.textContent = "Scanning page fields…";
    try {
      const data = await getJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/form-fields`);
      lastScan = {
        fields: Array.isArray(data.fields) ? data.fields : [],
        primaryButtonId: data.primaryButtonId || null,
        primaryButtonLabel: data.primaryButtonLabel || null,
      };
      rememberPageKey(data);
      renderOverlayFields(fieldsForm, lastScan);
      if (lastScan.fields.length === 0) {
        overlayStatus.textContent = "No fillable fields on this page — use paste into focused field. Overlay updates when the page changes.";
      } else {
        overlayStatus.textContent = lastScan.primaryButtonLabel
          ? `Type below, then fill. Will click “${lastScan.primaryButtonLabel}”.`
          : "Type below, then fill. No continue button detected — tap it in the picture after fill.";
      }
      updateFillButton();
    } catch (err) {
      overlayStatus.textContent = String(err.message || err);
    } finally {
      scanInFlight = false;
      scanBtn.disabled = false;
    }
  }

  async function maybeRescanIfPageChanged() {
    if (overlayBusy()) return;
    try {
      const data = await getJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/page-key`);
      const nextKey = typeof data.pageKey === "string" ? data.pageKey : "";
      const nextUrl = typeof data.pageUrl === "string" ? data.pageUrl : "";
      applyPageMeta(data.pageTitle, nextUrl);
      if (!nextKey || nextKey === lastPageKey) return;
      await scanFields();
    } catch {
      /* non-fatal */
    }
  }

  async function fillFields() {
    fillBtn.disabled = true;
    fillInFlight = true;
    overlayStatus.textContent = "Filling the remote page…";
    try {
      const fields = collectOverlayValues(fieldsForm);
      await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/fill-form`, {
        fields,
        clickPrimary: Boolean(lastScan.primaryButtonId),
        primaryButtonId: lastScan.primaryButtonId,
      });
      overlayStatus.textContent = "Filled — waiting for the next page…";
      quietUntil = Date.now() + 1500;
      lastPageKey = "";
    } catch (err) {
      overlayStatus.textContent = String(err.message || err);
      fillBtn.disabled = false;
    } finally {
      fillInFlight = false;
    }
  }

  async function heartbeat() {
    try {
      await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/heartbeat`);
    } catch {
      /* non-fatal */
    }
  }

  async function maybeWarm(data) {
    if (camofoxBrowserReady(data?.camofox)) return false;
    const now = Date.now();
    if (now - lastWarmAt < 15_000) return false;
    lastWarmAt = now;
    statusEl.textContent = "starting browser…";
    await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
    return true;
  }

  function layout() {
    const rect = frameEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    screenEl.style.flex = "1 1 auto";
    screenEl.style.width = `${w}px`;
    screenEl.style.height = `${h}px`;
    if (rfb?.scaleViewport) window.dispatchEvent(new Event("resize"));
    return { width: w, height: h };
  }

  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    try {
      await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/complete`);
      const banner = document.createElement("div");
      banner.className = "handoff-done-banner";
      banner.textContent = "Thanks — you can close this page. Your Joshu will continue.";
      root.insertBefore(banner, root.firstChild);
      doneBtn.textContent = "Done";
    } catch (err) {
      doneBtn.disabled = false;
      statusEl.textContent = String(err.message || err);
    }
  });
  scanBtn.addEventListener("click", () => {
    scanFields().catch(() => undefined);
  });
  fillBtn.addEventListener("click", () => {
    fillFields().catch(() => undefined);
  });
  fieldsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    fillFields().catch(() => undefined);
  });

  heartbeatTimer = window.setInterval(heartbeat, 20_000);
  heartbeat();
  window.setInterval(() => {
    maybeRescanIfPageChanged().catch(() => undefined);
  }, 1500);

  const res = await fetch("api/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  let data = await res.json();
  if (data.browserViewport?.width > 0) {
    fb.width = data.browserViewport.width;
    fb.height = data.browserViewport.height;
  }

  await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);

  const connectVnc = async () => {
    const base = data.novnc?.clientBaseUrl?.replace(/\/+$/, "");
    const path = data.novnc?.websocketPath;
    if (!base || !path) throw new Error("noVNC not configured");
    const { default: RFB } = await import(`${base}/core/rfb.js`);
    if (rfb) {
      rfb.disconnect();
      rfb = null;
    }
    rfb = new RFB(screenEl, wsUrl(path), { shared: false });
    rfb.viewOnly = false;
    rfb.focusOnClick = true;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    attachVncClipboard(rfb, {
      targetEl: screenEl,
      pasteViaApi: async (text) => {
        const pasteRes = await fetch("api/camofox/insert-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          cache: "no-store",
        });
        if (!pasteRes.ok) {
          const err = await pasteRes.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${pasteRes.status}`);
        }
        return true;
      },
      copyViaApi: async () => {
        const copyRes = await fetch("api/camofox/copy-selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        });
        if (!copyRes.ok) {
          const err = await copyRes.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${copyRes.status}`);
        }
        const copyData = await copyRes.json();
        return typeof copyData.text === "string" ? copyData.text : "";
      },
      ui: {
        pasteBtn: document.getElementById("vnc-paste-remote"),
        copyBtn: document.getElementById("vnc-copy-remote"),
        textarea: document.getElementById("vnc-clipboard-text"),
        hint: document.querySelector(".vnc-clipboard-hint"),
      },
    });
    attachVncScrollBridge(screenEl);
    rfb.addEventListener("connect", () => {
      statusEl.textContent = `connected ${fb.width}×${fb.height}`;
      layout();
    });
    rfb.addEventListener("disconnect", () => {
      statusEl.textContent = "disconnected — if jWeb is open on desktop, close it and reload";
    });
  };

  // Defer until flex layout assigns height to #vnc-frame (mobile Safari).
  requestAnimationFrame(() => {
    layout();
    requestAnimationFrame(() => layout());
  });
  await connectVnc();
  layout();
  scanFields().catch(() => undefined);

  window.setInterval(async () => {
    const statusRes = await fetch("api/status", { cache: "no-store" }).catch(() => undefined);
    if (!statusRes?.ok) return;
    data = await statusRes.json();
    if (await maybeWarm(data)) {
      await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
      if (!rfb) await connectVnc().catch(() => undefined);
    }
  }, 8000);

  new ResizeObserver(() => layout()).observe(frameEl);
  window.addEventListener("orientationchange", () => window.setTimeout(() => layout(), 100));
}

main().catch((err) => {
  const root = document.getElementById("handoff-root");
  if (root) root.innerHTML = `<p style="padding:1rem;color:#f88">${String(err.message || err)}</p>`;
});
