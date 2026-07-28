/**
 * Nylas transport mode:
 * - direct: box holds NYLAS_API_KEY (OSS / self-host default when key is set)
 * - relay: box has no key; ops go through control-plane proxy
 * - off: Nylas disabled
 *
 * Resolution:
 * 1. Explicit JOSHU_NYLAS_MODE wins when set to relay|direct|off
 * 2. Else if NYLAS_API_KEY present → direct (preserves OSS with no env change)
 * 3. Else → off (do not auto-relay without explicit mode)
 */

export type NylasMode = "relay" | "direct" | "off";

export function nylasApiKey(): string | null {
  const key = process.env.NYLAS_API_KEY?.trim();
  return key || null;
}

export function nylasApiUri(): string {
  return (process.env.NYLAS_API_URI?.trim() || "https://api.us.nylas.com").replace(/\/+$/, "");
}

/** Parse explicit mode env; returns null when unset / invalid. */
export function parseNylasModeEnv(raw: string | undefined | null): NylasMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "relay" || value === "direct" || value === "off") return value;
  return null;
}

export function resolveNylasMode(
  env: NodeJS.ProcessEnv = process.env,
): NylasMode {
  const explicit = parseNylasModeEnv(env.JOSHU_NYLAS_MODE);
  if (explicit) return explicit;
  if (env.NYLAS_API_KEY?.trim()) return "direct";
  return "off";
}

/** True when direct has a key, or relay has CP URL + instance agent creds. */
export function isNylasConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolveNylasMode(env);
  if (mode === "off") return false;
  if (mode === "direct") return Boolean(env.NYLAS_API_KEY?.trim());
  // relay
  const cpUrl = env.CONTROL_PLANE_URL?.trim();
  const instanceId = env.JOSHU_INSTANCE_ID?.trim();
  const token = env.INSTANCE_AGENT_TOKEN?.trim();
  return Boolean(cpUrl && instanceId && token);
}
