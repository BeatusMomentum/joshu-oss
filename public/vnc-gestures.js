/**
 * Local two-finger pinch-zoom + pan on the noVNC canvas.
 *
 * Stock noVNC 1.7 maps pinch → Ctrl+Scroll on the remote (Firefox page zoom)
 * and has no client-side magnification. trackpadMode (local zoom/pan) is still
 * an unmerged upstream PR, so Joshu owns this layer:
 *
 *   pinch            → CSS scale 1×–5× around the finger midpoint (remote untouched)
 *   two-finger drag  → pan while zoomed; Playwright scroll at 1×
 *   one-finger       → left alone for noVNC absolute pointer mapping
 *
 * iOS Safari ignores user-scalable=no; we cancel gesturestart/change on the
 * VNC host so the phone OS does not zoom the Joshu page.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const SCROLL_PX_PER_TICK = 80;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function touchPair(touches) {
  if (touches.length < 2) return null;
  const a = touches[0];
  const b = touches[1];
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  return {
    dist: Math.hypot(dx, dy) || 1,
    midX: (a.clientX + b.clientX) / 2,
    midY: (a.clientY + b.clientY) / 2,
  };
}

function layerFor(hostEl) {
  return hostEl.querySelector("canvas") || hostEl;
}

/**
 * @param {HTMLElement} hostEl
 * @param {{ onScroll?: (direction: "up" | "down", amount: number) => void }} [opts]
 * @returns {() => void}
 */
export function attachVncLocalGestures(hostEl, opts = {}) {
  if (!hostEl) return () => undefined;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let gesture = null; // { dist, originX, originY, lastMidY, startScale }

  const apply = () => {
    const layer = layerFor(hostEl);
    layer.style.transformOrigin = "0 0";
    layer.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const resetIfFit = () => {
    if (scale <= 1.02) {
      scale = 1;
      tx = 0;
      ty = 0;
    }
    apply();
  };

  const onTouchStart = (event) => {
    const pair = touchPair(event.touches);
    if (!pair) {
      gesture = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = hostEl.getBoundingClientRect();
    const mx = pair.midX - rect.left;
    const my = pair.midY - rect.top;
    gesture = {
      dist: pair.dist,
      originX: (mx - tx) / scale,
      originY: (my - ty) / scale,
      lastMidY: pair.midY,
      startScale: scale,
    };
  };

  const onTouchMove = (event) => {
    const pair = touchPair(event.touches);
    if (!pair || !gesture) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    const nextScale = clamp(gesture.startScale * (pair.dist / gesture.dist), MIN_SCALE, MAX_SCALE);
    const rect = hostEl.getBoundingClientRect();
    const mx = pair.midX - rect.left;
    const my = pair.midY - rect.top;

    if (nextScale > 1.02) {
      scale = nextScale;
      tx = mx - gesture.originX * scale;
      ty = my - gesture.originY * scale;
      apply();
      return;
    }

    // At fit: two-finger drag scrolls the remote via Playwright (VNC wheel drops).
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
    const dy = pair.midY - gesture.lastMidY;
    gesture.lastMidY = pair.midY;
    if (typeof opts.onScroll === "function" && Math.abs(dy) >= 8) {
      opts.onScroll(dy > 0 ? "up" : "down", Math.min(1600, Math.abs(Math.round(dy * 4)) || SCROLL_PX_PER_TICK));
      gesture.lastMidY = pair.midY;
    }
  };

  const onTouchEnd = (event) => {
    if (event.touches.length >= 2) return;
    gesture = null;
    resetIfFit();
  };

  const preventSafariPageZoom = (event) => {
    if (typeof event.scale === "number") {
      event.preventDefault();
    }
  };

  const optsCapture = { capture: true, passive: false };
  hostEl.addEventListener("touchstart", onTouchStart, optsCapture);
  hostEl.addEventListener("touchmove", onTouchMove, optsCapture);
  hostEl.addEventListener("touchend", onTouchEnd, optsCapture);
  hostEl.addEventListener("touchcancel", onTouchEnd, optsCapture);
  hostEl.addEventListener("gesturestart", preventSafariPageZoom, optsCapture);
  hostEl.addEventListener("gesturechange", preventSafariPageZoom, optsCapture);
  hostEl.style.touchAction = "none";

  return () => {
    hostEl.removeEventListener("touchstart", onTouchStart, true);
    hostEl.removeEventListener("touchmove", onTouchMove, true);
    hostEl.removeEventListener("touchend", onTouchEnd, true);
    hostEl.removeEventListener("touchcancel", onTouchEnd, true);
    hostEl.removeEventListener("gesturestart", preventSafariPageZoom, true);
    hostEl.removeEventListener("gesturechange", preventSafariPageZoom, true);
    const layer = layerFor(hostEl);
    layer.style.transform = "";
    layer.style.transformOrigin = "";
  };
}
