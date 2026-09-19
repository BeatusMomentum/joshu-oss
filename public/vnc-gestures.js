/**
 * Local two-finger pinch-zoom + pan on the noVNC canvas.
 *
 * Stock noVNC 1.7 maps pinch → Ctrl+Scroll on the remote (Firefox page zoom)
 * and has no client-side magnification. trackpadMode (local zoom/pan) is still
 * an unmerged upstream PR, so Joshu owns this layer:
 *
 *   pinch            → CSS scale 1×–5× around the finger midpoint (remote untouched)
 *   two-finger drag  → pan while zoomed; Playwright scroll at 1× (dominance classifier)
 *   one-finger       → left alone for noVNC absolute pointer mapping
 *
 * Two-finger moves lock one mode per gesture: scroll vs pinch at 1×, pan vs pinch
 * when zoomed. Midpoint travel vs finger-separation change decides; a 2% pinch
 * threshold alone misclassified vertical scroll drags as zoom.
 *
 * When zoomed, pointer coords are inverse-mapped before noVNC sends VNC clicks.
 *
 * iOS Safari ignores user-scalable=no; we cancel gesturestart/change on the
 * VNC host so the phone OS does not zoom the Joshu page.
 */

import { clientToElement } from "./vendor/novnc/core/util/element.js";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const SCROLL_PX_PER_TICK = 80;
const ZOOM_EPS = 1.02;
const MODE_LOCK_MIN_PX = 10;
const SCROLL_STEP_PX = 8;
/** Midpoint must dominate finger separation by this factor to lock scroll/pan. */
const DOMINANCE = 1.35;

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
 * Lock scroll vs pinch (1×) or pan vs pinch (zoomed) for one two-finger gesture.
 * @returns {"scroll" | "pinch" | "pan" | null}
 */
export function classifyTwoFingerMode(pair, gesture, currentScale) {
  if (gesture.mode) return gesture.mode;

  const distDelta = Math.abs(pair.dist - gesture.startDist);
  const midDx = pair.midX - gesture.startMidX;
  const midDy = pair.midY - gesture.startMidY;
  const midMove = Math.hypot(midDx, midDy);
  const midYMove = Math.abs(midDy);
  const distRatio = pair.dist / gesture.startDist;

  if (midMove < MODE_LOCK_MIN_PX && distDelta < 6) return null;

  const zoomed = currentScale > ZOOM_EPS || gesture.startScale > ZOOM_EPS;
  if (zoomed) {
    if (distDelta > DOMINANCE * midMove) return "pinch";
    if (midMove >= MODE_LOCK_MIN_PX) return "pan";
    return null;
  }

  if (midYMove >= MODE_LOCK_MIN_PX && midYMove > DOMINANCE * distDelta && midYMove > midMove * 0.55) {
    return "scroll";
  }
  if (
    (distRatio > ZOOM_EPS || distRatio < 1 / ZOOM_EPS) &&
    distDelta > DOMINANCE * Math.max(midYMove, 4)
  ) {
    return "pinch";
  }
  if (midYMove >= MODE_LOCK_MIN_PX && midYMove >= midMove * 0.65) return "scroll";
  return null;
}

/** Map screen coords → noVNC canvas layout coords (undo local CSS zoom). */
export function mapClientToCanvasLocal(clientX, clientY, canvas, scale) {
  if (scale <= ZOOM_EPS) {
    return clientToElement(clientX, clientY, canvas);
  }
  const t = canvas.getBoundingClientRect();
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  let x = (clientX - t.left) / scale;
  let y = (clientY - t.top) / scale;
  x = clamp(x, 0, Math.max(0, w - 1));
  y = clamp(y, 0, Math.max(0, h - 1));
  return { x, y };
}

/**
 * noVNC calls clientToElement on the canvas; CSS transform breaks that when
 * zoomed. Intercept gestures/clicks and remap before events reach RFB handlers.
 */
function attachRfbLocalZoomPointers(rfb, getScale) {
  const canvas = rfb._canvas;
  if (!canvas) return () => undefined;

  const mapPos = (clientX, clientY) =>
    mapClientToCanvasLocal(clientX, clientY, canvas, getScale());

  const tapAt = (ev, bmask) => {
    const pos = mapPos(ev.detail.clientX, ev.detail.clientY);
    rfb._fakeMouseMove(ev, pos.x, pos.y);
    rfb._handleMouseButton(pos.x, pos.y, bmask);
    rfb._handleMouseButton(pos.x, pos.y, 0x0);
  };

  const onGesture = (ev) => {
    if (getScale() <= ZOOM_EPS) return;
    const kind = ev.detail?.type;
    const pos = mapPos(ev.detail.clientX, ev.detail.clientY);

    if (ev.type === "gesturestart") {
      if (kind === "onetap" || kind === "twotap" || kind === "threetap") {
        ev.stopImmediatePropagation();
        const mask = kind === "twotap" ? 0x4 : kind === "threetap" ? 0x2 : 0x1;
        tapAt(ev, mask);
        return;
      }
      if ((kind === "drag" || kind === "longpress") && !rfb.dragViewport) {
        ev.stopImmediatePropagation();
        rfb._fakeMouseMove(ev, pos.x, pos.y);
        if (kind === "longpress") rfb._handleMouseButton(pos.x, pos.y, 0x4);
        else rfb._handleMouseButton(pos.x, pos.y, 0x1);
      }
      return;
    }

    if (ev.type === "gesturemove" && (kind === "drag" || kind === "longpress") && !rfb.dragViewport) {
      ev.stopImmediatePropagation();
      rfb._fakeMouseMove(ev, pos.x, pos.y);
      return;
    }

    if (ev.type === "gestureend" && kind === "drag" && !rfb.dragViewport) {
      ev.stopImmediatePropagation();
      rfb._fakeMouseMove(ev, pos.x, pos.y);
      rfb._handleMouseButton(pos.x, pos.y, 0x0);
      return;
    }

    if (ev.type === "gestureend" && kind === "longpress" && !rfb.dragViewport) {
      ev.stopImmediatePropagation();
      rfb._fakeMouseMove(ev, pos.x, pos.y);
      rfb._handleMouseButton(pos.x, pos.y, 0x0);
    }
  };

  const origHandleMouse = rfb._handleMouse.bind(rfb);
  rfb._handleMouse = function handleMouseWithLocalZoom(ev) {
    if (getScale() <= ZOOM_EPS) {
      return origHandleMouse(ev);
    }
    if (ev.type === "click") {
      if (ev.target !== canvas) return;
    }
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.type === "click" || ev.type === "contextmenu") return;

    const pos = mapPos(ev.clientX, ev.clientY);
    const bmask = rfb.constructor._convertButtonMask(ev.buttons);
    const down = ev.type === "mousedown";

    switch (ev.type) {
      case "mousedown":
      case "mouseup":
        if (down) {
          canvas.setPointerCapture?.(ev.pointerId);
        }
        rfb._handleMouseButton(pos.x, pos.y, bmask);
        break;
      case "mousemove":
        rfb._handleMouseMove(pos.x, pos.y);
        break;
      default:
        break;
    }
  };

  const cap = { capture: true };
  canvas.addEventListener("gesturestart", onGesture, cap);
  canvas.addEventListener("gesturemove", onGesture, cap);
  canvas.addEventListener("gestureend", onGesture, cap);

  return () => {
    canvas.removeEventListener("gesturestart", onGesture, true);
    canvas.removeEventListener("gesturemove", onGesture, true);
    canvas.removeEventListener("gestureend", onGesture, true);
    rfb._handleMouse = origHandleMouse;
  };
}

/**
 * @param {HTMLElement} hostEl
 * @param {{ onScroll?: (direction: "up" | "down", amount: number) => void, rfb?: object }} [opts]
 * @returns {() => void}
 */
export function attachVncLocalGestures(hostEl, opts = {}) {
  if (!hostEl) return () => undefined;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let gesture = null;
  const getScale = () => scale;

  let rfbUnpatch = null;
  if (opts.rfb) {
    rfbUnpatch = attachRfbLocalZoomPointers(opts.rfb, getScale);
  }

  const apply = () => {
    const layer = layerFor(hostEl);
    layer.style.transformOrigin = "0 0";
    layer.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const resetIfFit = () => {
    if (scale <= ZOOM_EPS) {
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
      mode: null,
      startDist: pair.dist,
      startMidX: pair.midX,
      startMidY: pair.midY,
      originX: (mx - tx) / scale,
      originY: (my - ty) / scale,
      lastMidX: pair.midX,
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

    const mode = classifyTwoFingerMode(pair, gesture, scale);
    if (mode) gesture.mode = mode;
    if (!gesture.mode) return;

    const rect = hostEl.getBoundingClientRect();
    const mx = pair.midX - rect.left;
    const my = pair.midY - rect.top;

    if (gesture.mode === "scroll") {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
      const dy = pair.midY - gesture.lastMidY;
      gesture.lastMidY = pair.midY;
      if (typeof opts.onScroll === "function" && Math.abs(dy) >= SCROLL_STEP_PX) {
        opts.onScroll(
          dy > 0 ? "up" : "down",
          Math.min(1600, Math.abs(Math.round(dy * 4)) || SCROLL_PX_PER_TICK),
        );
      }
      return;
    }

    if (gesture.mode === "pan") {
      tx += pair.midX - gesture.lastMidX;
      ty += pair.midY - gesture.lastMidY;
      gesture.lastMidX = pair.midX;
      gesture.lastMidY = pair.midY;
      apply();
      return;
    }

    const nextScale = clamp(gesture.startScale * (pair.dist / gesture.startDist), MIN_SCALE, MAX_SCALE);
    scale = nextScale;
    tx = mx - gesture.originX * scale;
    ty = my - gesture.originY * scale;
    apply();
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
    if (rfbUnpatch) rfbUnpatch();
    const layer = layerFor(hostEl);
    layer.style.transform = "";
    layer.style.transformOrigin = "";
  };
}
