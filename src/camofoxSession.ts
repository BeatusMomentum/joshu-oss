import type { CatalogButton, CatalogField } from "./browserHandoff/formCatalog.js";

export interface CamofoxTab {
  tabId: string;
  targetId?: string;
  url: string;
  title?: string;
  listItemId?: string;
}

export interface CamofoxPageObservation {
  tab: CamofoxTab;
  url?: string;
  title?: string;
  snapshot: string;
  refsCount?: number;
}

/** about:blank / empty — safe to replace with a start URL without clobbering a live session. */
function isBlankBrowserUrl(url: string | undefined): boolean {
  const value = (url ?? "").trim().toLowerCase();
  return !value || value === "about:blank" || value === "about:home";
}

/** Google / GitHub / Microsoft / Apple OAuth windows. Must stay a separate page from the opener. */
export function isOauthPopupUrl(url: string | undefined): boolean {
  const value = (url ?? "").toLowerCase();
  if (!value) return false;
  return (
    value.includes("accounts.google.com") ||
    value.includes("accounts.youtube.com") ||
    value.includes("login.microsoftonline.com") ||
    value.includes("login.live.com") ||
    value.includes("github.com/login") ||
    value.includes("github.com/session") ||
    value.includes("appleid.apple.com")
  );
}

const HITL_TAB_SHIM = `
(() => {
  const SHIM_VERSION = 2;
  if (window.__hitlShimVersion === SHIM_VERSION) return 'already';
  window.__hitlShimInstalled = true;
  window.__hitlShimVersion = SHIM_VERSION;
  const fix = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('a[target], area[target]').forEach((a) => {
      const target = String(a.target || '').toLowerCase();
      if (target !== '_blank' && target !== '_new') return;
      a.target = '_self';
      a.removeAttribute('rel');
    });
    root.querySelectorAll('form[target]').forEach((f) => {
      const target = String(f.target || '').toLowerCase();
      if (target === '_blank' || target === '_new') f.target = '_self';
    });
  };
  const sameTabNavigate = (url) => {
    if (!url) return false;
    try { location.href = String(url); return true; } catch (_) { return false; }
  };
  fix(document);
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => fix(n)))).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    const target = String(anchor.target || '').toLowerCase();
    const wantsNewContext = target === '_blank' || target === '_new' || event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    if (!wantsNewContext) return;
    if (sameTabNavigate(anchor.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('auxclick', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    if (sameTabNavigate(anchor.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const origOpen = window.open;
  window.open = function(url, name, features) {
    try {
      if (url) location.href = String(url);
    } catch (e) {
      try { return origOpen.call(window, url, name, features); } catch (_) {}
    }
    return null;
  };
  return 'installed';
})()
`;

/** Shared with scripts/patch-camofox-single-tab.mjs HITL_INSERT_TEXT_ROUTE. */
const HITL_INSERT_INTO_FOCUSED = `function (text, selectAll) {
  var el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { ok: false, reason: 'no-field' };
  var tag = String(el.tagName || '').toUpperCase();
  var type = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  var skip = ['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset', 'hidden', 'color', 'range'];
  if (tag === 'INPUT' && skip.indexOf(type) !== -1) return { ok: false, reason: 'non-text-input' };
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (el.disabled || el.readOnly) return { ok: false, reason: 'readonly' };
    var value = String(el.value || '');
    var start = selectAll ? 0 : (el.selectionStart == null ? value.length : el.selectionStart);
    var end = selectAll ? value.length : (el.selectionEnd == null ? start : el.selectionEnd);
    var next = value.slice(0, start) + text + value.slice(end);
    var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, next);
    else el.value = next;
    try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, via: 'value', chars: text.length };
  }
  if (el.isContentEditable) {
    el.focus();
    if (selectAll) document.execCommand('selectAll', false, null);
    var okEdit = document.execCommand('insertText', false, text);
    return { ok: !!okEdit, via: 'execCommand', chars: text.length };
  }
  var okAny = document.execCommand('insertText', false, text);
  if (okAny) return { ok: true, via: 'execCommand-fallback', chars: text.length };
  return { ok: false, reason: 'not-a-field' };
}`;

const HITL_READ_FOCUSED_TEXT = `function () {
  var el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
    var start = el.selectionStart || 0;
    var end = el.selectionEnd || 0;
    if (end > start) return { text: String(el.value || '').slice(start, end) };
    return { text: String(el.value || '') };
  }
  if (el && el.isContentEditable) {
    var innerSel = String(window.getSelection ? window.getSelection() : '') || '';
    if (innerSel) return { text: innerSel };
    return { text: String(el.innerText || el.textContent || '') };
  }
  var sel = String(window.getSelection ? window.getSelection() : '') || '';
  return { text: sel };
}`;

/** Read-only page fingerprint — does not stamp data-joshu-handoff (safe to poll). */
const HITL_FORM_SIGNATURE = `function () {
  function skipType(t) {
    return ['hidden', 'button', 'submit', 'file', 'image', 'reset', 'color', 'range'].indexOf(t) !== -1;
  }
  function usable(el) {
    if (!el || el.disabled) return false;
    try {
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    } catch (e) {}
    return true;
  }
  var parts = [];
  document.querySelectorAll('input, textarea, select').forEach(function (el) {
    var type = String(el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && skipType(type)) return;
    if (!usable(el)) return;
    parts.push(['f', el.tagName, type, el.name || '', el.id || '', el.getAttribute('placeholder') || ''].join(':'));
  });
  document.querySelectorAll('button, input[type=submit], [role=button]').forEach(function (el) {
    if (!usable(el)) return;
    var text = String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    parts.push(['b', text].join(':'));
  });
  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    key: parts.slice(0, 24).join('|')
  };
}`;

function explainInsertFailure(reason?: string): string {
  if (reason === "readonly") return "That field is read-only.";
  if (reason === "no-field" || reason === "not-a-field" || reason === "non-text-input") {
    return "Click a text field in the page first, then paste.";
  }
  return reason ? `Paste failed: ${reason}` : "Click a text field in the page first, then paste.";
}

export class CamofoxSessionCoordinator {
  constructor(
    private readonly opts: {
      camofoxUrl: string;
      userId: string;
      sessionKey: string;
      singleTab: boolean;
      viewportWidth?: number;
      viewportHeight?: number;
    },
  ) {}

  /** Resize Playwright viewport and Firefox outer window to match the VNC framebuffer. */
  async readViewportMetrics(tabId?: string): Promise<{ innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number } | undefined> {
    const tab = tabId ? { tabId } : await this.currentTab();
    if (!tab?.tabId) return undefined;
    const url = new URL(`/tabs/${tab.tabId}/evaluate`, this.opts.camofoxUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: this.opts.userId,
        expression: "JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height })",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { result?: string };
    if (!data.result) return undefined;
    try {
      const parsed = JSON.parse(data.result) as { innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number };
      return parsed;
    } catch {
      return undefined;
    }
  }

  async fitViewport(tabId?: string): Promise<void> {
    const width = this.opts.viewportWidth ?? 1024;
    const height = this.opts.viewportHeight ?? 768;
    const tab = tabId ? { tabId } : await this.currentTab();
    if (!tab?.tabId) return;
    const listed = (await this.listTabs()).find((item) => item.tabId === tab.tabId);
    if (isOauthPopupUrl(listed?.url)) return;
    const res = await fetch(new URL(`/tabs/${tab.tabId}/viewport`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, width, height }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Camofox viewport fit failed: ${res.status}`);
  }

  /**
   * Scroll the HITL page via Playwright mouse.wheel — used when VNC wheel/buttons
   * 4–5 do not reach Firefox (common with scaled noVNC + x11vnc).
   */
  async scrollPage(opts: { direction?: "up" | "down" | "left" | "right"; amount?: number } = {}): Promise<void> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const direction = opts.direction ?? "down";
    const amount = Math.max(1, Math.min(8000, Math.floor(Number(opts.amount ?? 400) || 400)));
    const res = await fetch(new URL(`/tabs/${tab.tabId}/scroll`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, direction, amount }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Camofox scroll failed: ${res.status}`);
  }

  /** Send a key via Playwright (PageDown / ArrowDown / etc.) — VNC keysyms are flaky for nav. */
  async pressKey(key: string): Promise<void> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const res = await fetch(new URL(`/tabs/${tab.tabId}/press`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, key }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Camofox press failed: ${res.status}`);
  }

  async listTabs(): Promise<CamofoxTab[]> {
    const url = new URL("/tabs", this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Camofox tabs failed: ${res.status}`);
    const data = await res.json() as { tabs?: CamofoxTab[] };
    return Array.isArray(data.tabs) ? data.tabs : [];
  }

  async currentTab(): Promise<CamofoxTab | undefined> {
    const tabs = await this.listTabs();
    const matching = tabs.filter((tab) => tab.listItemId === this.opts.sessionKey);
    return (matching.length > 0 ? matching : tabs).at(-1);
  }

  /**
   * Ensure a HITL tab exists. By default, never navigates an already-active
   * non-blank page (status/fit-viewport bootstrap used to clobber logins by
   * re-opening CAMOFOX_START_URL). Pass navigateExisting when a caller
   * explicitly wants to load `url` (e.g. run initialUrl).
   */
  async ensureTab(url?: string, opts?: { navigateExisting?: boolean }): Promise<CamofoxTab> {
    const existing = await this.currentTab();
    if (!existing) {
      const created = await this.createTab(url);
      await this.installShim(created.tabId);
      return created;
    }
    if (this.opts.singleTab) await this.closeOtherTabs(existing.tabId).catch(() => undefined);
    const existingBlank = isBlankBrowserUrl(existing.url);
    const shouldNavigate =
      Boolean(url) &&
      existing.url !== url &&
      (opts?.navigateExisting === true || existingBlank);
    const tab = shouldNavigate ? await this.navigate(existing.tabId, url!) : existing;
    await this.installShim(tab.tabId);
    return tab;
  }

  async enforceSingleTab(): Promise<CamofoxTab | undefined> {
    const tab = await this.currentTab();
    if (!tab) return undefined;
    if (this.opts.singleTab) await this.closeOtherTabs(tab.tabId).catch(() => undefined);
    await this.installShim(tab.tabId);
    return tab;
  }

  async closeAllTabs(): Promise<void> {
    const tabs = await this.listTabs();
    await Promise.allSettled(tabs.map((tab) => this.closeTab(tab.tabId)));
  }

  async observe(tab: CamofoxTab): Promise<CamofoxPageObservation> {
    await this.installShim(tab.tabId);
    const url = new URL(`/tabs/${tab.tabId}/snapshot`, this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Camofox snapshot failed: ${res.status}`);
    const data = await res.json() as { snapshot?: string; refsCount?: number; url?: string; title?: string };
    return {
      tab,
      url: data.url ?? tab.url,
      title: data.title ?? tab.title,
      snapshot: data.snapshot ?? "",
      refsCount: data.refsCount,
    };
  }

  /**
   * Insert text into the focused page control (not VNC keysyms).
   *
   * Camofox `/type` needs a snapshot ref and used to no-op for jWeb paste.
   * Prefer the HITL `/insert-text` route (patched Camofox); fall back to `/evaluate`.
   * Native paste semantics: insert at the caret / replace the current selection.
   * Pass selectAll only when the caller wants to replace the whole field.
   */
  async insertText(text: string, opts?: { selectAll?: boolean }): Promise<void> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const selectAll = opts?.selectAll === true;

    const insertUrl = new URL(`/tabs/${tab.tabId}/insert-text`, this.opts.camofoxUrl);
    const insertRes = await fetch(insertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, text, selectAll }),
      signal: AbortSignal.timeout(30_000),
    });
    if (insertRes.ok) {
      const data = (await insertRes.json()) as { ok?: boolean; reason?: string; error?: string };
      if (data.ok) return;
      throw new Error(explainInsertFailure(data.reason || data.error));
    }
    if (insertRes.status !== 404 && insertRes.status !== 405) {
      const err = (await insertRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `Camofox insert-text failed: ${insertRes.status}`);
    }

    // Unpatched Camofox: same DOM insert via evaluate (64KB expression cap).
    const result = await this.evaluateJson<{ ok?: boolean; reason?: string }>(
      tab.tabId,
      `JSON.stringify((${HITL_INSERT_INTO_FOCUSED})(${JSON.stringify(text)}, ${selectAll}))`,
    );
    if (result?.ok) return;
    throw new Error(explainInsertFailure(result?.reason));
  }

  async listFormFields(): Promise<{ fields: CatalogField[]; buttons: CatalogButton[] }> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const url = new URL(`/tabs/${tab.tabId}/form-fields`, this.opts.camofoxUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 404 || res.status === 405
          ? "Camofox form overlay patch missing (HITL_FORM_FIELDS_ROUTE)."
          : `Camofox form-fields failed: ${res.status}`,
      );
    }
    const data = (await res.json()) as { fields?: unknown; buttons?: unknown };
    return {
      fields: Array.isArray(data.fields) ? (data.fields as CatalogField[]) : [],
      buttons: Array.isArray(data.buttons) ? (data.buttons as CatalogButton[]) : [],
    };
  }

  /** URL + control shape for auto-rescan. Does not stamp locators or send values. */
  async readFormSignature(): Promise<{ url: string; title: string; key: string }> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const keyUrl = new URL(`/tabs/${tab.tabId}/form-page-key`, this.opts.camofoxUrl);
    const res = await fetch(keyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { url?: unknown; title?: unknown; key?: unknown };
      return {
        url: typeof data.url === "string" && data.url ? data.url : tab.url,
        title: typeof data.title === "string" ? data.title : tab.title ?? "",
        key: typeof data.key === "string" ? data.key : "",
      };
    }
    // Unpatched Camofox: HTTP /evaluate is often 403 on login pages — last resort only.
    const evaluated = await this.evaluateJson<{ url?: string; title?: string; key?: string }>(
      tab.tabId,
      `JSON.stringify((${HITL_FORM_SIGNATURE})())`,
    );
    return {
      url: typeof evaluated?.url === "string" && evaluated.url ? evaluated.url : tab.url,
      title: typeof evaluated?.title === "string" ? evaluated.title : tab.title ?? "",
      key: typeof evaluated?.key === "string" ? evaluated.key : "",
    };
  }

  /**
   * Fill stamped overlay controls then click a catalog button id.
   * Owner-typed values stay on this path — never pass them to an LLM.
   */
  async fillForm(opts: {
    fields: Array<{ id: string; value: string | boolean }>;
    buttonId?: string | null;
  }): Promise<{ ok: boolean; filled: number; missing: string[]; clicked: string | null }> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");
    const url = new URL(`/tabs/${tab.tabId}/fill-form`, this.opts.camofoxUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: this.opts.userId,
        fields: opts.fields,
        buttonId: opts.buttonId || "",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 404 || res.status === 405
          ? "Camofox form overlay patch missing (HITL_FILL_FORM_ROUTE)."
          : `Camofox fill-form failed: ${res.status}`,
      );
    }
    const data = (await res.json()) as {
      ok?: boolean;
      filled?: unknown;
      missing?: unknown;
      clicked?: unknown;
    };
    const missing = Array.isArray(data.missing) ? data.missing.map((id) => String(id)) : [];
    const filled = Array.isArray(data.filled) ? data.filled.length : 0;
    return {
      ok: data.ok === true,
      filled,
      missing,
      clicked: typeof data.clicked === "string" && data.clicked ? data.clicked : null,
    };
  }

  /** Read selection, or the whole focused field when nothing is selected. */
  async readSelection(): Promise<string> {
    const tab = await this.currentTab();
    if (!tab?.tabId) throw new Error("No Camofox tab");

    const evaluated = await this.evaluateJson<{ text?: string }>(
      tab.tabId,
      `JSON.stringify((${HITL_READ_FOCUSED_TEXT})())`,
    );
    if (typeof evaluated?.text === "string" && evaluated.text.length > 0) return evaluated.text;

    const res = await fetch(new URL(`/tabs/${tab.tabId}/selection`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Camofox selection failed: ${res.status}`);
    const data = (await res.json()) as { text?: string };
    return typeof data.text === "string" ? data.text : "";
  }

  private async evaluateJson<T>(tabId: string, expression: string): Promise<T | undefined> {
    const url = new URL(`/tabs/${tabId}/evaluate`, this.opts.camofoxUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, expression }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { result?: unknown };
    const raw = data.result;
    if (raw == null) return undefined;
    if (typeof raw === "object") return raw as T;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async installShim(tabId: string): Promise<void> {
    const url = new URL(`/tabs/${tabId}/evaluate`, this.opts.camofoxUrl);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, expression: HITL_TAB_SHIM }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  private async createTab(url?: string): Promise<CamofoxTab> {
    // Camofox rejects about:* on POST /tabs when url is set — omit for blank start
    // (same as deploy/scripts/vps-start.sh warm_camofox_browser).
    const payload: { userId: string; sessionKey: string; url?: string } = {
      userId: this.opts.userId,
      sessionKey: this.opts.sessionKey,
    };
    if (url && !isBlankBrowserUrl(url)) payload.url = url;
    const res = await fetch(new URL("/tabs", this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Camofox create tab failed: ${res.status}`);
    const data = await res.json() as { tabId: string; url?: string; title?: string };
    return { tabId: data.tabId, targetId: data.tabId, url: data.url ?? url ?? "about:blank", title: data.title, listItemId: this.opts.sessionKey };
  }

  private async navigate(tabId: string, url: string): Promise<CamofoxTab> {
    const res = await fetch(new URL(`/tabs/${tabId}/navigate`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, url }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Camofox navigate failed: ${res.status}`);
    const data = await res.json() as { url?: string; title?: string };
    return { tabId, targetId: tabId, url: data.url ?? url, title: data.title, listItemId: this.opts.sessionKey };
  }

  private async closeOtherTabs(keepTabId: string): Promise<void> {
    const tabs = await this.listTabs();
    // OAuth popups must keep their opener. Pruning the RapidAPI tab while Google
    // GIS is on gsi/transform leaves a hung Sign In page with no window.opener.
    if (tabs.some((tab) => isOauthPopupUrl(tab.url))) return;
    await Promise.allSettled(tabs.filter((tab) => tab.tabId !== keepTabId).map((tab) => this.closeTab(tab.tabId)));
  }

  private async closeTab(tabId: string): Promise<void> {
    const url = new URL(`/tabs/${tabId}`, this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  }
}
