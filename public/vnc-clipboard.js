/**
 * jWeb clipboard: Mac ↔ Camofox page fields.
 *
 * x11vnc clipboard/keysyms mangle braces and drop Cmd+C. This bridge never uses
 * the RFB clipboard protocol. Paste/copy go through Joshu → Playwright
 * (pasteViaApi / copyViaApi).
 *
 * Stable paths:
 *   1. Cmd+V while the VNC page is focused — uses the paste event's clipboardData
 *      (no clipboard-read permission needed; works in ArozOS iframes).
 *   2. Paste into field — Mac clipboard, else the visible buffer textarea.
 *   3. Copy from browser — Playwright selection / focused field → Mac + textarea.
 */

function readHostClipboard() {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText().catch(() => "");
  }
  return Promise.resolve("");
}

async function writeLocalClipboard(text) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isEditableTarget(node) {
  if (!node || !(node instanceof Element)) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(node.isContentEditable);
}

/**
 * @param {object} rfb
 * @param {{
 *   targetEl?: HTMLElement,
 *   ui?: Record<string, HTMLElement | null>,
 *   pasteViaApi?: (text: string) => Promise<boolean>,
 *   copyViaApi?: () => Promise<string>,
 * }} options
 */
export function attachVncClipboard(rfb, options = {}) {
  const { targetEl, ui = {}, pasteViaApi, copyViaApi } = options;
  const cleanups = [];
  let vncEngaged = false;
  let busy = false;

  const setHint = (message) => {
    if (ui.hint) ui.hint.textContent = message;
  };

  const setBusy = (next) => {
    busy = next;
    for (const btn of [ui.pasteBtn, ui.copyBtn]) {
      if (btn) btn.disabled = next;
    }
  };

  const syncBuffer = (text) => {
    if (ui.textarea && typeof text === "string") ui.textarea.value = text;
  };

  const insertIntoPage = async (text) => {
    if (typeof pasteViaApi !== "function") {
      setHint("Paste API is not wired.");
      return false;
    }
    const trimmed = typeof text === "string" ? text : "";
    if (!trimmed.trim()) {
      setHint("Nothing to paste — Cmd+V into the box, then Paste into field.");
      return false;
    }
    syncBuffer(trimmed);
    setBusy(true);
    try {
      const ok = await pasteViaApi(trimmed);
      if (ok) {
        setHint("Pasted into the focused field.");
        return true;
      }
      setHint("Paste did not land — click a text field in the page, then try again.");
      return false;
    } catch (err) {
      setHint(err?.message || "Paste failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (ui.pasteBtn) {
    const onPasteClick = () => {
      if (busy) return;
      void (async () => {
        const buffer = ui.textarea?.value ?? "";
        let text = "";
        // Prefer the visible buffer when the user is editing it; otherwise Mac clipboard.
        if (document.activeElement === ui.textarea && String(buffer).trim()) {
          text = buffer;
        } else {
          try {
            text = await readHostClipboard();
          } catch {
            text = "";
          }
          if (!String(text).trim()) text = buffer;
        }
        if (!String(text).trim()) {
          ui.textarea?.focus?.();
          setHint("Mac clipboard was empty — Cmd+V into this box, then Paste into field.");
          return;
        }
        await insertIntoPage(text);
      })();
    };
    ui.pasteBtn.addEventListener("click", onPasteClick);
    cleanups.push(() => ui.pasteBtn.removeEventListener("click", onPasteClick));
  }

  if (ui.copyBtn) {
    const onCopyClick = () => {
      if (busy) return;
      void (async () => {
        if (typeof copyViaApi !== "function") {
          setHint("Copy API is not wired.");
          return;
        }
        setBusy(true);
        try {
          const text = await copyViaApi();
          if (!text?.trim()) {
            setHint("Nothing to copy — click a field or select text in the page first.");
            return;
          }
          syncBuffer(text);
          const ok = await writeLocalClipboard(text);
          setHint(ok
            ? "Copied from the page → Mac clipboard."
            : "Copied into the box — select it and Cmd+C if needed.");
        } catch (err) {
          setHint(err?.message || "Copy failed.");
        } finally {
          setBusy(false);
        }
      })();
    };
    ui.copyBtn.addEventListener("click", onCopyClick);
    cleanups.push(() => ui.copyBtn.removeEventListener("click", onCopyClick));
  }

  if (targetEl) {
    const onVncEngage = () => {
      vncEngaged = true;
    };
    const onVncDisengage = (event) => {
      const target = event.target;
      if (target instanceof Node && targetEl.contains(target)) return;
      vncEngaged = false;
    };
    const vncShouldTakeClipboard = (event) => {
      if (busy) return false;
      if (isEditableTarget(event.target)) return false;
      if (isEditableTarget(document.activeElement)) return false;
      if (vncEngaged) return true;
      const active = document.activeElement;
      if (active && (active === targetEl || targetEl.contains(active))) return true;
      const target = event.target;
      if (target instanceof Node && targetEl.contains(target)) return true;
      return false;
    };

    // Native paste event carries the Mac clipboard without a permissions prompt.
    const onPaste = (event) => {
      if (!vncShouldTakeClipboard(event)) return;
      const text = event.clipboardData?.getData("text/plain") || "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      void insertIntoPage(text);
    };

    const onCopy = (event) => {
      if (!vncShouldTakeClipboard(event)) return;
      if (typeof copyViaApi !== "function") return;
      event.preventDefault();
      event.stopPropagation();
      if (ui.copyBtn) ui.copyBtn.click();
    };

    targetEl.addEventListener("pointerdown", onVncEngage, true);
    targetEl.addEventListener("focusin", onVncEngage, true);
    document.addEventListener("pointerdown", onVncDisengage, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("copy", onCopy, true);
    cleanups.push(() => {
      targetEl.removeEventListener("pointerdown", onVncEngage, true);
      targetEl.removeEventListener("focusin", onVncEngage, true);
      document.removeEventListener("pointerdown", onVncDisengage, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("copy", onCopy, true);
    });
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}
