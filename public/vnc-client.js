/**
 * Shared noVNC RFB loader + defaults for jWeb, the standalone viewer, and
 * mobile handoff. Library files live in public/vendor/novnc (pin in VERSION).
 * The WebSocket is a separate path (Camofox websockify).
 */

export const NOVNC_LIBRARY_VERSION = "1.7.0";

export function novncRfbModuleUrl(clientBaseUrl) {
  const base = String(clientBaseUrl || "").replace(/\/+$/, "");
  return `${base}/core/rfb.js?v=${NOVNC_LIBRARY_VERSION}`;
}

export async function loadNovncRfb(clientBaseUrl) {
  const mod = await import(novncRfbModuleUrl(clientBaseUrl));
  return mod.default;
}

/** Phones/tablets: local pinch-zoom/pan instead of mapping pinch to Ctrl+Scroll. */
export function preferVncLocalGestures() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function configureNovncRfb(rfb) {
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  // clip/dragViewport are noVNC's built-in pan; Joshu owns pan via vnc-gestures.js.
  rfb.clipViewport = false;
  rfb.dragViewport = false;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  // Still present on 1.7.0 (removed in some later notes). Guard for forward compat.
  if ("showDotCursor" in rfb) rfb.showDotCursor = true;
  return rfb;
}
