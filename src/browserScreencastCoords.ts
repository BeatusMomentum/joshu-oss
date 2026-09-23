/**
 * Map a point on the screencast canvas (0–1 of the drawn frame) into the CSS
 * pixels Chrome reported for that frame. Input.dispatchMouseEvent uses those
 * CSS pixels, not the JPEG's bitmap size.
 */
export function normalizedPointToCss(
  nx: number,
  ny: number,
  deviceWidth: number,
  deviceHeight: number,
): { x: number; y: number } | null {
  if (!(deviceWidth > 0) || !(deviceHeight > 0)) return null;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const x = Math.min(1, Math.max(0, nx)) * deviceWidth;
  const y = Math.min(1, Math.max(0, ny)) * deviceHeight;
  return { x, y };
}
