"""last30days_research — async research with session capture for completion replies."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")

LAST30DAYS_RESEARCH_SCHEMA = {
    "name": "last30days_research",
    "description": (
        "Start last30days topic research (async). Returns runId immediately; "
        "Joshu replies in this chat when the report is ready."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "description": "Research topic or query"},
            "days": {"type": "integer", "description": "Lookback window (default 30)"},
            "depth": {
                "type": "string",
                "enum": ["quick", "default", "deep"],
                "description": "Research depth",
            },
            "mock": {"type": "boolean", "description": "Mock run for smoke tests"},
        },
        "required": ["topic"],
    },
}


def _joshu_session_key(kwargs: dict) -> str:
    gateway = kwargs.get("gateway_session_key")
    if gateway:
        return str(gateway)
    sid = str(kwargs.get("session_id") or kwargs.get("session_key") or "").strip()
    if not sid:
        return ""
    if sid.startswith("joshu-app:") or sid.startswith("joshu-hermes-chat:") or sid.startswith("agent:"):
        return sid
    return f"joshu-hermes-chat:{sid}"


def _invoke_research(payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}/api/apps/last30days/invoke",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _patch_run_session(run_id: str, session_key: str, session_id: str = "") -> None:
    if not run_id or not session_key:
        return
    payload: dict = {"hermesSessionKey": session_key}
    if session_id:
        payload["hermesSessionId"] = session_id
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}/api/last30days/runs/{run_id}/session",
        data=body,
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
        print(f"[joshu-last30days] session patch failed for {run_id}: {err}", file=sys.stderr)


def last30days_research(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})

    invoke_args: dict = {"topic": topic}
    if args.get("days") is not None:
        invoke_args["days"] = args["days"]
    if args.get("depth"):
        invoke_args["depth"] = args["depth"]
    if args.get("mock") is True:
        invoke_args["mock"] = True

    session_key = _joshu_session_key(kwargs)
    payload = {
        "action": "research",
        "args": invoke_args,
    }
    if session_key:
        payload["hermesSessionKey"] = session_key
        invoke_args["hermesSessionKey"] = session_key

    try:
        result = _invoke_research(payload)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        return json.dumps({"ok": False, "error": detail or f"HTTP {err.code}"})
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        return json.dumps({"ok": False, "error": str(err)})

    return json.dumps(result)


def post_tool_call(tool_name: str, args: dict, result: str, session_id: str = "", **kwargs) -> None:
    if tool_name != "last30days_research":
        return
    session_key = _joshu_session_key({"session_id": session_id, **kwargs})
    if not session_key:
        return
    try:
        parsed = json.loads(result)
    except json.JSONDecodeError:
        return
    inner = parsed.get("result") if isinstance(parsed, dict) else None
    if not isinstance(inner, dict):
        return
    run_id = str(inner.get("runId") or "").strip()
    if run_id:
        _patch_run_session(run_id, session_key, session_id)


def register(ctx) -> None:
    ctx.register_tool(
        name="last30days_research",
        toolset="joshu-last30days",
        schema=LAST30DAYS_RESEARCH_SCHEMA,
        handler=last30days_research,
        emoji="🔎",
    )
    ctx.register_hook("post_tool_call", post_tool_call)
