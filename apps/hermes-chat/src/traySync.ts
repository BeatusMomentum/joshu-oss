/** Notify ArozOS shell overlay (aroz-jchat-tray.js) about persona + gateway notifications. */
export type JChatTrayPayload = {
  assistantName: string;
  portraitUrl: string;
  /** Set only when the gateway delivers a new assistant message to show as a tray toast. */
  notification?: string | null;
  voiceInputOn?: boolean;
  voiceAvailable?: boolean;
  /** Normalized audio level 0–1 for the Winamp-style meter. */
  audioLevel?: number;
  /** Live Hermes gateway health for the tray online dot. */
  gatewayRunning?: boolean;
};

export function syncJChatTray(payload: JChatTrayPayload): void {
  try {
    const portraitUrl = payload.portraitUrl.startsWith("http")
      ? payload.portraitUrl
      : new URL(payload.portraitUrl, window.location.href).href;
    window.parent.postMessage({ type: "jchat:tray", ...payload, portraitUrl }, "*");
  } catch {
    /* cross-origin or standalone dev */
  }
}

/** True when this iframe lives in the taskbar-docked ArozOS float window. */
export function readJChatDockedFromFrame(): boolean {
  try {
    const frame = window.frameElement;
    if (!frame || !(frame instanceof Element)) return false;
    const fw = frame.closest(".floatWindow");
    return Boolean(fw && fw.classList.contains("jp-jchat-docked"));
  } catch {
    return false;
  }
}

/** Ask the ArozOS shell to pop this docked window into a free-floating one. */
export function requestJChatUndock(): void {
  try {
    window.parent.postMessage({ type: "jchat:undock" }, "*");
  } catch {
    /* standalone */
  }
}
