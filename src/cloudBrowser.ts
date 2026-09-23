/**
 * Shared browser hosted by Browser Use Cloud.
 * The box asks the control plane with its instance-agent token.
 * cdpUrl stays in this process (Playwright, Hermes, the sidecar).
 * liveUrl is only returned from the gated live-frame route.
 */
import { cloudBrowserEnabled as isCloudBrowserBackend } from "./browserBackend.js";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { instanceAgentBearerToken } from "./meteredProviders/config.js";

/** Standard 4:3 landscape — matches local Camofox/Chromium screencast. */
export const CLOUD_BROWSER_SCREEN = { width: 1024, height: 768 };
const RENEW_BEFORE_MS = 10 * 60 * 1000;

type CloudSession = {
  browserId: string;
  cdpUrl: string;
  liveUrl: string;
  timeoutAt: number;
};

type Lifecycle = {
  idleMs: number;
  busy: () => boolean;
  onCdp: (cdpUrl: string) => Promise<void>;
};

let session: CloudSession | null = null;
let lastTouch = 0;
let chain: Promise<unknown> = Promise.resolve();
let lifecycle: Lifecycle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function cloudBrowserEnabled(projectRoot = process.cwd()): boolean {
  return isCloudBrowserBackend(projectRoot);
}

/** True when Browser Use Cloud could be provisioned (control plane + instance agent token). */
export function cloudBrowserConfigured(): boolean {
  const base = controlPlaneBase();
  const token = bearer();
  return Boolean(base && token);
}

function controlPlaneBase(): string {
  return (provisionEnvTrim("CONTROL_PLANE_URL") || process.env.CONTROL_PLANE_URL || "").replace(/\/+$/, "");
}

function bearer(): string | null {
  try {
    return instanceAgentBearerToken();
  } catch {
    return null;
  }
}

export function touchCloudBrowser(): void {
  lastTouch = Date.now();
}

export function cloudBrowserSessionActive(): boolean {
  return session !== null;
}

/** Stable id for the Browser Use session — use this to decide when to reload the live iframe. */
export function cloudBrowserId(): string {
  return session?.browserId || "";
}

/** Ignore one-shot page loads (ArozOS window restore). Require a second poll ~8s later. */
let liveFrameStreak = 0;
let lastLiveFramePollAt = 0;

export function noteLiveFramePoll(): { shouldEnsure: boolean } {
  const now = Date.now();
  if (lastLiveFramePollAt > 0 && now - lastLiveFramePollAt > 60_000) liveFrameStreak = 0;
  liveFrameStreak += 1;
  lastLiveFramePollAt = now;
  return { shouldEnsure: liveFrameStreak >= 2 };
}

export function cloudCdpUrl(): string {
  return session?.cdpUrl || "";
}

/** Viewer URL with the Browser Use toolbar hidden. Empty when no session is up. */
export function cloudLiveFrameUrl(): string {
  if (!session?.liveUrl) return "";
  try {
    const url = new URL(session.liveUrl);
    url.searchParams.set("ui", "false");
    return url.toString();
  } catch {
    return "";
  }
}

async function postAction(action: "ensure" | "stop"): Promise<CloudSession | null> {
  const base = controlPlaneBase();
  const token = bearer();
  if (!base || !token) throw new Error("cloud browser is not configured");
  const res = await fetch(`${base}/api/instances/browser-use/browsers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(45_000),
  });
  if (action === "stop") {
    if (!res.ok) throw new Error(`cloud browser stop ${res.status}`);
    return null;
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `cloud browser ensure ${res.status}`);
  }
  const body = (await res.json()) as {
    browserId?: string;
    cdpUrl?: string;
    liveUrl?: string;
    timeoutAt?: string;
  };
  if (!body.browserId || !body.cdpUrl || !body.liveUrl) throw new Error("cloud browser response incomplete");
  const timeoutAt = Date.parse(body.timeoutAt || "");
  return {
    browserId: body.browserId,
    cdpUrl: body.cdpUrl,
    liveUrl: body.liveUrl,
    timeoutAt: Number.isFinite(timeoutAt) ? timeoutAt : Date.now() + 4 * 60 * 60 * 1000,
  };
}

async function ensureOnce(): Promise<CloudSession> {
  touchCloudBrowser();
  const next = await postAction("ensure");
  if (!next) throw new Error("cloud browser ensure returned nothing");
  const changed = session?.cdpUrl !== next.cdpUrl;
  session = next;
  if (changed && lifecycle) await lifecycle.onCdp(next.cdpUrl);
  if (changed) console.log(`[cloud-browser] session ${next.browserId}`);
  return next;
}

export function ensureCloudBrowser(): Promise<CloudSession> {
  const run = chain.then(ensureOnce, ensureOnce);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function stopCloudBrowser(): Promise<void> {
  const run = chain.then(async () => {
    if (!session) return;
    await postAction("stop");
    session = null;
    console.log("[cloud-browser] stopped");
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

/** Stretch the window to the screen so the live view has no empty band. */
export async function fillCloudBrowserWindow(cdpUrl: string): Promise<void> {
  const base = cdpUrl.replace(/\/$/, "");
  const version = (await fetch(`${base}/json/version`).then((res) => res.json())) as {
    webSocketDebuggerUrl?: string;
  };
  const list = (await fetch(`${base}/json/list`).then((res) => res.json())) as Array<{
    id?: string;
    type?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = list.find((target) => target.type === "page" && target.id);
  if (!version.webSocketDebuggerUrl || !page?.id) return;
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 8_000);
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(message.error.message || method));
        else resolve(message.result ?? {});
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  try {
    const win = (await send("Browser.getWindowForTarget", { targetId: page.id })) as {
      windowId?: number;
    };
    if (!win.windowId) return;
    await send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: {
        left: 0,
        top: 0,
        width: CLOUD_BROWSER_SCREEN.width,
        height: CLOUD_BROWSER_SCREEN.height,
        windowState: "normal",
      },
    });
  } finally {
    socket.close();
  }
}

export function startCloudBrowserLifecycle(opts: Lifecycle): void {
  lifecycle = opts;
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((err) => {
      console.warn("[cloud-browser]", err instanceof Error ? err.message : err);
    });
  }, 30_000);
  timer.unref?.();
}

async function tick(): Promise<void> {
  if (!lifecycle || !session) return;
  const idleMs = lifecycle.idleMs;
  const idle = idleMs > 0 && lastTouch > 0 && Date.now() - lastTouch >= idleMs;
  if (idle && !lifecycle.busy()) {
    await stopCloudBrowser();
    return;
  }
  if (session.timeoutAt - Date.now() < RENEW_BEFORE_MS) {
    await ensureCloudBrowser();
  }
}
