/** Show/hide toggle for password inputs in handoff UI. */

const EYE_OPEN =
  '<svg class="handoff-password-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>';

const EYE_CLOSED =
  '<svg class="handoff-password-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 6.5c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.21-1.04 2.17-2.39 2.76-3.93-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.978 4.978 0 0 1 12 6.5zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55a2.978 2.978 0 0 0-.36 1.45c0 1.66 1.34 3 3 3 .5 0 .97-.12 1.38-.34l1.55 1.55A4.978 4.978 0 0 1 12 16.5c-2.76 0-5-2.24-5-5 0-.64.12-1.25.34-1.8L7.53 9.8zm3.84 3.84 2.52 2.52c-.08.01-.15.01-.23.01a2.5 2.5 0 0 1-2.27-3.53z"/></svg>';

/**
 * Wrap a password input with a show/hide toggle button.
 * Returns the wrapper element (caller appends it to the form).
 */
export function wrapPasswordInput(input) {
  const wrap = document.createElement("div");
  wrap.className = "handoff-password-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "handoff-password-toggle";
  btn.setAttribute("aria-label", "Show password");
  btn.setAttribute("aria-pressed", "false");
  btn.innerHTML = EYE_OPEN;

  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.setAttribute("aria-pressed", showing ? "false" : "true");
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    btn.innerHTML = showing ? EYE_OPEN : EYE_CLOSED;
  });

  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}
