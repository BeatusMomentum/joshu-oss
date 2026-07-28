/**
 * Box → control-plane Nylas proxy transport.
 * Auth: Bearer `instanceId.rawToken` (same as Langfuse relay).
 */

export type NylasProxyOp =
  | "createAgentAccount"
  | "sendMessage"
  | "listMessages"
  | "listThreads"
  | "fetchMessagesInThread"
  | "getMessage"
  | "updateMessage"
  | "listEvents"
  | "getEvent"
  | "createEvent"
  | "updateEvent"
  | "destroyEvent";

export type NylasProxyRequest = {
  op: NylasProxyOp;
  grantId?: string;
  args?: Record<string, unknown>;
};

function controlPlaneBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.JOSHU_NYLAS_RELAY_URL?.trim();
  if (explicit) {
    // Allow full proxy URL or base; strip trailing /proxy if callers pass full path.
    return explicit.replace(/\/+$/, "").replace(/\/api\/instances\/nylas\/proxy$/i, "");
  }
  const base = env.CONTROL_PLANE_URL?.trim();
  if (!base) throw new Error("CONTROL_PLANE_URL is not set (Nylas relay mode)");
  return base.replace(/\/+$/, "");
}

export function nylasProxyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${controlPlaneBaseUrl(env)}/api/instances/nylas/proxy`;
}

export function nylasProxyBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const instanceId = env.JOSHU_INSTANCE_ID?.trim();
  const raw = env.INSTANCE_AGENT_TOKEN?.trim();
  if (!instanceId || !raw) {
    throw new Error("JOSHU_INSTANCE_ID / INSTANCE_AGENT_TOKEN required for Nylas relay");
  }
  if (raw.startsWith(`${instanceId}.`)) return raw;
  return `${instanceId}.${raw}`;
}

/**
 * POST one whitelisted Nylas op to the control plane.
 * Returns the JSON `result` field from a successful response.
 */
export async function nylasProxyCall<T = unknown>(
  request: NylasProxyRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = nylasProxyUrl(env);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nylasProxyBearerToken(env)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      op: request.op,
      ...(request.grantId ? { grantId: request.grantId } : {}),
      ...(request.args ? { args: request.args } : {}),
    }),
  });

  const json = (await res.json().catch(() => null)) as {
    result?: T;
    error?: string;
    message?: string;
  } | null;

  if (!res.ok) {
    const msg =
      json?.message ||
      json?.error ||
      `Nylas relay failed (${res.status})`;
    throw new Error(msg);
  }

  return json?.result as T;
}
