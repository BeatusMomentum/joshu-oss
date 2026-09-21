/**
 * jWeb — Joshu identity bubble (Chat Head FAB).
 * Opens the docked jChat companion on the ArozOS desktop (same as the taskbar avatar).
 * No embedded iframe — jWeb and jChat are separate subservices.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function avatarHtml(name, portraitUrl) {
  const safeName = escapeHtml(name);
  if (portraitUrl) {
    return `<img src="${escapeHtml(portraitUrl)}" alt="${safeName}" decoding="async" />`;
  }
  const initial = escapeHtml((name.trim().charAt(0) || "?").toUpperCase());
  return `<span class="jchat-avatar-initials" aria-hidden="true">${initial}</span>`;
}

function identityUrls() {
  const urls = [];
  const configured =
    typeof window.JOSHU_PUBLIC_IDENTITY_URL === "string"
      ? window.JOSHU_PUBLIC_IDENTITY_URL.trim()
      : "";
  if (configured) urls.push(configured);
  urls.push("api/instance/identity");
  urls.push("/joshu/api/instance/identity");
  urls.push("/script/joshu-public-persona.json");
  return urls;
}

async function fetchIdentity() {
  let lastErr = null;
  for (const url of identityUrls()) {
    try {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("identity unavailable");
}

function canReachDesktop() {
  try {
    return Boolean(window.top && window.top !== window);
  } catch {
    return false;
  }
}

function postToDesktop(payload) {
  if (!canReachDesktop()) return false;
  try {
    window.top.postMessage(payload, "*");
    return true;
  } catch {
    return false;
  }
}

/**
 * Mount the identity bubble on document.body (head FAB only — closed by default).
 */
export function attachJChatBubble({ position = "right" } = {}) {
  const state = {
    name: "Companion",
    portraitUrl: "",
    dockedOpen: false,
  };

  const dock = document.createElement("div");
  dock.className = `jchat-bubble-dock jchat-bubble-dock--${position}`;
  dock.hidden = true;

  const headWrap = document.createElement("div");
  headWrap.className = "jchat-bubble-head-wrap";

  const headBtn = document.createElement("button");
  headBtn.type = "button";
  headBtn.className = "jchat-bubble-head";
  headBtn.setAttribute("aria-expanded", "false");
  headBtn.innerHTML =
    '<span class="jchat-avatar jchat-avatar--head" data-jchat-avatar></span><span class="jchat-bubble-head-ring" aria-hidden="true"></span>';

  headWrap.appendChild(headBtn);
  dock.appendChild(headWrap);
  document.body.appendChild(dock);

  const avatarEl = headBtn.querySelector("[data-jchat-avatar]");

  function renderIdentity() {
    headBtn.setAttribute(
      "aria-label",
      state.dockedOpen ? `Hide chat with ${state.name}` : `Open chat with ${state.name}`,
    );
    if (avatarEl) avatarEl.innerHTML = avatarHtml(state.name, state.portraitUrl);
  }

  function setDockedOpen(open) {
    state.dockedOpen = open === true;
    headBtn.classList.toggle("jchat-bubble-head--open", state.dockedOpen);
    headBtn.setAttribute("aria-expanded", state.dockedOpen ? "true" : "false");
    renderIdentity();
  }

  function toggleDesktopJChat() {
    if (!postToDesktop({ type: "joshu:toggle-jchat-docked", source: "jweb" })) {
      console.warn("[jweb] jChat launcher needs the ArozOS desktop (not standalone jWeb)");
    }
  }

  headBtn.addEventListener("click", toggleDesktopJChat);

  window.addEventListener("message", (evt) => {
    const data = evt.data;
    if (!data || data.type !== "joshu:jchat-docked-state") return;
    setDockedOpen(data.open === true);
  });

  void fetchIdentity()
    .then((data) => {
      state.name = String(data?.name || "").trim() || "Companion";
      state.portraitUrl =
        (data?.avatarUrl && String(data.avatarUrl).trim()) ||
        (data?.imageUrl && String(data.imageUrl).trim()) ||
        "";
      dock.hidden = false;
      renderIdentity();
    })
    .catch(() => {
      state.name = "Companion";
      dock.hidden = false;
      renderIdentity();
    });

  return {
    setDockedOpen,
    toggleDesktopJChat,
  };
}
