"""app_gui_action handler — validate and enqueue for the embedded app browser shell."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from .schemas import APP_GUI_ACTION_SCHEMA
from .validate import normalize_app_gui_action

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def _joshu_session_key(kwargs: dict, app_id: str | None = None) -> str:
    """Map Hermes tool kwargs to the Joshu session key used by AG-UI / jChat drains."""
    gateway = kwargs.get("gateway_session_key")
    if gateway:
        return str(gateway)
    sid = str(kwargs.get("session_id") or kwargs.get("session_key") or "").strip()
    if not sid:
        return ""
    if sid.startswith("joshu-app:") or sid.startswith("joshu-hermes-chat:") or sid.startswith("voice-think:"):
        return sid
    # AG-UI embedded apps: match buildAppAgentSessionId(appId, threadId) on the Joshu server.
    if app_id:
        return f"joshu-app:{app_id}:{sid}"
    return f"joshu-hermes-chat:{sid}"


def _enqueue_action(session_key: str, action: dict) -> tuple[bool, str | None]:
    """POST to Joshu enqueue. Returns (ok, error_message)."""
    if not session_key:
        return False, "missing session key for GUI action enqueue"
    payload = json.dumps({"sessionKey": session_key, "action": action}).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}/api/app-gui-actions/enqueue",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
        return True, None
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8", errors="replace").strip()
        except Exception:
            detail = ""
        if detail:
            try:
                parsed = json.loads(detail)
                if isinstance(parsed, dict) and parsed.get("error"):
                    detail = str(parsed["error"])
            except Exception:
                pass
        return False, detail or f"enqueue HTTP {err.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        return False, f"enqueue failed: {err}"


def app_gui_action(args: dict, **kwargs) -> str:
    """Validate the action. Hermes does not pass session_id to tool handlers — only to hooks.

    Prefer returning a validated payload so AG-UI can apply the action from the tool result
    even when enqueue is deferred to post_tool_call.
    """
    action, error = normalize_app_gui_action(args)
    if error or not action:
        return json.dumps({"ok": False, "error": error or "invalid action"})

    # Best-effort enqueue when session is already present (some gateways pass it).
    session_key = _joshu_session_key(kwargs, app_id=action.get("appId"))
    if session_key:
        ok, enqueue_error = _enqueue_action(session_key, action)
        if not ok:
            return json.dumps(
                {
                    "ok": False,
                    "appId": action["appId"],
                    "action": action["action"],
                    "args": action.get("args") or {},
                    "error": enqueue_error or "failed to enqueue GUI action",
                }
            )
        return json.dumps(
            {
                "ok": True,
                "appId": action["appId"],
                "action": action["action"],
                "args": action.get("args") or {},
                "message": f"Queued GUI action {action['action']} for {action['appId']}.",
            }
        )

    # Session arrives in post_tool_call — return validated action for SSE fallback + hook enqueue.
    return json.dumps(
        {
            "ok": True,
            "appId": action["appId"],
            "action": action["action"],
            "args": action.get("args") or {},
            "message": (
                f"Validated GUI action {action['action']} for {action['appId']}; "
                "enqueue deferred to session hook."
            ),
        }
    )


def post_tool_call(tool_name: str, args: dict, result: str, session_id: str = "", **kwargs) -> None:
    """Hermes passes session_id to hooks, not tool handlers — enqueue here (same as joshu-desktop)."""
    if tool_name != "app_gui_action":
        return
    action, error = normalize_app_gui_action(args)
    if error or not action:
        return
    session_key = _joshu_session_key({"session_id": session_id, **kwargs}, app_id=action.get("appId"))
    ok, enqueue_error = _enqueue_action(session_key, action)
    if not ok:
        print(
            f"[joshu-app-gui] enqueue failed for {action.get('action')}: {enqueue_error}",
            file=sys.stderr,
        )


def register(ctx) -> None:
    ctx.register_tool(
        name="app_gui_action",
        toolset="joshu-app-gui",
        schema=APP_GUI_ACTION_SCHEMA,
        handler=app_gui_action,
        emoji="🎛️",
    )
    ctx.register_hook("post_tool_call", post_tool_call)
