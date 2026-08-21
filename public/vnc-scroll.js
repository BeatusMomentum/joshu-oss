/**
 * Bridge host wheel + page-nav keys into Camofox Playwright APIs.
 * Scaled noVNC + x11vnc often drop wheel (buttons 4/5) and arrow keysyms —
 * this keeps jWeb scroll usable without hammering Camofox (rate-limited).
 */
export function attachVncScrollBridge(targetEl, opts = {}) {
  if (!targetEl) return () => undefined;

  const scrollUrl = opts.scrollUrl || "api/camofox/scroll";
  // Hard cap: Camofox scroll is ~300ms; flooding it OOMs the box / fails healthchecks.
  const MIN_INTERVAL_MS = 180;
  const WHEEL_FLUSH_MS = 80;
  const MAX_AMOUNT = 1600;

  let engaged = false;
  let wheelAcc = 0;
  let wheelTimer = 0;
  let inflight = false;
  let pending = null; // { kind:'wheel', direction, amount } | { kind:'key', key }
  let lastSentAt = 0;

  const engage = () => {
    engaged = true;
  };
  const disengage = (event) => {
    const t = event.target;
    if (t instanceof Node && targetEl.contains(t)) return;
    engaged = false;
  };
  const isEngaged = (event) => {
    if (engaged) return true;
    const active = document.activeElement;
    if (active && (active === targetEl || targetEl.contains(active))) return true;
    const t = event.target;
    return t instanceof Node && targetEl.contains(t);
  };

  const mergePending = (next) => {
    if (!pending) {
      pending = next;
      return;
    }
    if (pending.kind === "wheel" && next.kind === "wheel" && pending.direction === next.direction) {
      pending.amount = Math.min(MAX_AMOUNT, pending.amount + next.amount);
      return;
    }
    // Prefer the newest nav key; drop stale wheel when a key arrives.
    pending = next;
  };

  const sendBody = async (body) => {
    await fetch(scrollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }).catch(() => undefined);
  };

  const pump = async () => {
    if (inflight) return;
    inflight = true;
    try {
      while (pending) {
        const wait = MIN_INTERVAL_MS - (Date.now() - lastSentAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const job = pending;
        pending = null;
        lastSentAt = Date.now();
        if (job.kind === "key") {
          await sendBody({ key: job.key });
        } else {
          await sendBody({ direction: job.direction, amount: job.amount });
        }
      }
    } finally {
      inflight = false;
      if (pending) void pump();
    }
  };

  const enqueueWheel = (direction, amount) => {
    mergePending({ kind: "wheel", direction, amount: Math.min(MAX_AMOUNT, Math.max(60, amount)) });
    void pump();
  };

  const enqueueKey = (key) => {
    mergePending({ kind: "key", key });
    void pump();
  };

  const flushWheel = () => {
    wheelTimer = 0;
    const delta = wheelAcc;
    wheelAcc = 0;
    if (!delta) return;
    enqueueWheel(delta > 0 ? "down" : "up", Math.abs(Math.round(delta)));
  };

  const onWheel = (event) => {
    if (!isEngaged(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    if (event.deltaMode === 2) dy *= 400;
    // Ignore tiny trackpad jitter.
    if (Math.abs(dy) < 1) return;
    wheelAcc += dy;
    if (wheelTimer) window.clearTimeout(wheelTimer);
    if (Math.abs(wheelAcc) >= 160) {
      flushWheel();
      return;
    }
    wheelTimer = window.setTimeout(flushWheel, WHEEL_FLUSH_MS);
  };

  const NAV_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
    "Spacebar",
  ]);

  const onKeyDown = (event) => {
    if (!isEngaged(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.repeat) return; // key-repeat would flood like the wheel did
    const key = event.key;
    if (!NAV_KEYS.has(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (key === " " || key === "Spacebar") {
      enqueueKey(event.shiftKey ? "PageUp" : "PageDown");
      return;
    }
    enqueueKey(key);
  };

  targetEl.addEventListener("pointerdown", engage, true);
  targetEl.addEventListener("focusin", engage, true);
  targetEl.addEventListener("wheel", onWheel, { capture: true, passive: false });
  document.addEventListener("pointerdown", disengage, true);
  document.addEventListener("keydown", onKeyDown, true);
  targetEl.style.overscrollBehavior = "contain";

  return () => {
    if (wheelTimer) window.clearTimeout(wheelTimer);
    pending = null;
    targetEl.removeEventListener("pointerdown", engage, true);
    targetEl.removeEventListener("focusin", engage, true);
    targetEl.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("pointerdown", disengage, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
