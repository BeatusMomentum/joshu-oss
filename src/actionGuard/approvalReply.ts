/** Map owner reply text to an approval decision. */
export function parseApprovalReply(text: string): "approved" | "denied" | null {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!normalized) return null;

  const approve = new Set(["y", "yes", "approve", "approved", "ok", "okay"]);
  const deny = new Set(["n", "no", "deny", "denied", "reject", "rejected"]);

  if (approve.has(normalized)) return "approved";
  if (deny.has(normalized)) return "denied";

  const first = normalized.split(/\s+/)[0] ?? "";
  if (approve.has(first)) return "approved";
  if (deny.has(first)) return "denied";

  return null;
}
