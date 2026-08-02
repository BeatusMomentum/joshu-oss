/**
 * Public Joshu API base for owner approval links, Share Chat, Teams/Slack bots, etc.
 *
 * Do **not** fall back to HERMES_DASHBOARD_PUBLIC_URL — that host only serves Hermes
 * Admin (no `/joshu` proxy). On VPS, CUSTOMER_DOMAIN + PUBLIC_BASE_PATH is correct.
 */
export function resolveJoshuPublicApiBase(): string {
  const explicit =
    process.env.JOSHU_OWNER_CHANNEL_PUBLIC_URL?.trim() ||
    process.env.JOSHU_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const domain = process.env.CUSTOMER_DOMAIN?.trim();
  if (domain) {
    const basePath = (process.env.PUBLIC_BASE_PATH ?? "/joshu").replace(/\/+$/, "") || "";
    return `https://${domain}${basePath}`.replace(/\/+$/, "");
  }

  const port = process.env.JOSHU_PORT?.trim() || process.env.PORT?.trim() || "8788";
  const basePath = (process.env.PUBLIC_BASE_PATH ?? "/joshu").replace(/\/+$/, "") || "/joshu";
  return `http://127.0.0.1:${port}${basePath}`.replace(/\/+$/, "");
}
