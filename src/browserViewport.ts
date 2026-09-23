/** Pixel budget for the shared browser. Shape changes; this product stays put. */
export const VIEWPORT_AREA = 1024 * 768;

const MIN_RATIO = 0.45;
const MAX_RATIO = 2.2;

/**
 * Browser CSS size for a viewer box. Area stays near VIEWPORT_AREA so the
 * screencast stays cheap when the phone is tall or jWeb is wide.
 */
export function viewportForBox(
  boxWidth: number,
  boxHeight: number,
  area = VIEWPORT_AREA,
): { width: number; height: number } | null {
  if (!(boxWidth >= 40) || !(boxHeight >= 40) || !(area >= 160_000)) return null;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, boxWidth / boxHeight));
  let width = Math.round(Math.sqrt(area * ratio));
  width = Math.max(480, Math.min(1280, width));
  let height = Math.round(area / width);
  height = Math.max(480, Math.min(1600, height));
  width = Math.max(480, Math.min(1280, Math.round(area / height)));
  return { width, height };
}
