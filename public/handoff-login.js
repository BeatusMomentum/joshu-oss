import { wrapPasswordInput } from "./handoff-password-toggle.js";

function readConfig() {
  const el = document.getElementById("handoff-config");
  if (!el?.textContent) throw new Error("missing handoff config");
  return JSON.parse(el.textContent);
}

function messageForError(code) {
  if (code === "invalid_credentials") return "Incorrect username or password.";
  if (code === "rate_limited") return "Too many attempts. Wait a few minutes and try again.";
  if (code === "box_login_unavailable") return "Box sign-in is unavailable. Try again in a moment.";
  return "Sign-in failed.";
}

async function main() {
  const cfg = readConfig();
  const form = document.getElementById("handoff-login-form");
  const user = document.getElementById("handoff-user");
  const pass = document.getElementById("handoff-pass");
  const err = document.getElementById("handoff-login-error");
  const submit = document.getElementById("handoff-login-submit");
  if (cfg.suggestedUser && user && !user.value) user.value = cfg.suggestedUser;
  if (pass?.type === "password" && pass.parentElement) {
    pass.parentElement.replaceChild(wrapPasswordInput(pass), pass);
  }
  user?.focus();

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    if (submit) submit.disabled = true;
    try {
      const params = `t=${encodeURIComponent(cfg.token)}&exp=${encodeURIComponent(cfg.exp)}`;
      const res = await fetch(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/login?${params}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: user?.value ?? "",
          password: pass?.value ?? "",
          t: cfg.token,
          exp: cfg.exp,
        }),
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) {
          err.textContent = messageForError(data.error);
          err.hidden = false;
        }
        return;
      }
      window.location.reload();
    } catch {
      if (err) {
        err.textContent = "Sign-in failed.";
        err.hidden = false;
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

main().catch((err) => {
  const root = document.querySelector(".handoff-gate");
  if (root) root.innerHTML = `<p class="handoff-gate-error">${String(err.message || err)}</p>`;
});
