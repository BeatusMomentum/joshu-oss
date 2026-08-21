"""last30days Hermes tools — research + Watching via Joshu app invoke.

Skills (SKILL.md) tell the agent *when* to use these. The tools *do* the work
so jChat does not have to improvise HTTP against /joshu/api/last30days/*.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")

# Invoke action names must match joshu.app.json agent.actions[] and the
# convention-based proxies in src/appInvokeRegistry.ts.
INVOKE_RESEARCH = "research"
INVOKE_WATCH_LIST = "watchingList"
INVOKE_WATCH_ADD = "watchingAdd"
INVOKE_WATCH_REMOVE = "watchingRemove"
INVOKE_WATCH_REPORT = "watchingReport"
INVOKE_WATCH_RUN = "watchingRun"
INVOKE_WATCH_RUN_ALL = "watchingRunAll"

LAST30DAYS_RESEARCH_SCHEMA = {
    "name": "last30days_research",
    "description": (
        "Start last30days topic research (async). Returns runId immediately; "
        "Joshu replies in this chat when the report is ready. Does not add a watch."
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

LAST30DAYS_WATCH_LIST_SCHEMA = {
    "name": "last30days_watch_list",
    "description": (
        "List last30days Watching topics with cadence, snapshot count, and "
        "trending status (Building baseline / Trending / Steady / Quiet)."
    ),
    "parameters": {"type": "object", "properties": {}},
}

LAST30DAYS_WATCH_ADD_SCHEMA = {
    "name": "last30days_watch_add",
    "description": (
        "Add a last30days Watching topic (daily or weekly). Does not run research; "
        "call last30days_watch_run afterward to seed snapshot #1."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "description": "Topic to watch"},
            "cadence": {
                "type": "string",
                "enum": ["daily", "weekly"],
                "description": "Recheck cadence (default daily)",
            },
        },
        "required": ["topic"],
    },
}

LAST30DAYS_WATCH_REMOVE_SCHEMA = {
    "name": "last30days_watch_remove",
    "description": "Stop watching a last30days topic (does not delete past reports).",
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "description": "Topic to remove from Watching"},
        },
        "required": ["topic"],
    },
}

LAST30DAYS_WATCH_REPORT_SCHEMA = {
    "name": "last30days_watch_report",
    "description": (
        "Watch report for one topic: trending vs average, new/dropped URLs, "
        "volume delta. Needs at least one completed watch run."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "description": "Watched topic"},
        },
        "required": ["topic"],
    },
}

LAST30DAYS_WATCH_RUN_SCHEMA = {
    "name": "last30days_watch_run",
    "description": (
        "Re-run one Watching topic now (7-day window, async). Returns runId; "
        "Joshu replies in this chat when the snapshot is ready."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "description": "Watched topic to re-check"},
        },
        "required": ["topic"],
    },
}

LAST30DAYS_WATCH_RUN_ALL_SCHEMA = {
    "name": "last30days_watch_run_all",
    "description": (
        "Re-run enabled Watching topics now (async, 7-day window). "
        "Optional cadence filters daily or weekly jobs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "cadence": {
                "type": "string",
                "enum": ["daily", "weekly"],
                "description": "Limit to this cadence; omit to run all enabled",
            },
        },
    },
}

# Async tools whose invoke result includes runId / runIds — session-patch after the call.
ASYNC_SESSION_TOOLS = frozenset(
    {"last30days_research", "last30days_watch_run", "last30days_watch_run_all"}
)


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


def _invoke(action: str, args: dict | None = None, session_key: str = "") -> dict:
    """POST /joshu/api/apps/last30days/invoke — same contract as cron + GUI."""
    invoke_args = dict(args or {})
    payload: dict = {"action": action, "args": invoke_args}
    if session_key:
        payload["hermesSessionKey"] = session_key
        invoke_args["hermesSessionKey"] = session_key
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}/api/apps/last30days/invoke",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _invoke_json(action: str, args: dict | None = None, **kwargs) -> str:
    session_key = _joshu_session_key(kwargs)
    try:
        result = _invoke(action, args, session_key=session_key)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        return json.dumps({"ok": False, "error": detail or f"HTTP {err.code}"})
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        return json.dumps({"ok": False, "error": str(err)})
    return json.dumps(result)


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


def _run_ids_from_invoke_result(parsed: dict) -> list[str]:
    inner = parsed.get("result") if isinstance(parsed, dict) else None
    if not isinstance(inner, dict):
        return []
    ids: list[str] = []
    one = str(inner.get("runId") or "").strip()
    if one:
        ids.append(one)
    extra = inner.get("runIds")
    if isinstance(extra, list):
        for item in extra:
            rid = str(item or "").strip()
            if rid and rid not in ids:
                ids.append(rid)
    return ids


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
    return _invoke_json(INVOKE_RESEARCH, invoke_args, **kwargs)


def last30days_watch_list(args: dict, **kwargs) -> str:
    return _invoke_json(INVOKE_WATCH_LIST, {}, **kwargs)


def last30days_watch_add(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})
    cadence = str(args.get("cadence") or "daily").strip() or "daily"
    if cadence not in ("daily", "weekly"):
        cadence = "daily"
    return _invoke_json(INVOKE_WATCH_ADD, {"topic": topic, "cadence": cadence}, **kwargs)


def last30days_watch_remove(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})
    return _invoke_json(INVOKE_WATCH_REMOVE, {"topic": topic}, **kwargs)


def last30days_watch_report(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})
    return _invoke_json(INVOKE_WATCH_REPORT, {"topic": topic}, **kwargs)


def last30days_watch_run(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})
    return _invoke_json(INVOKE_WATCH_RUN, {"topic": topic}, **kwargs)


def last30days_watch_run_all(args: dict, **kwargs) -> str:
    invoke_args: dict = {}
    cadence = str(args.get("cadence") or "").strip()
    if cadence in ("daily", "weekly"):
        invoke_args["cadence"] = cadence
    return _invoke_json(INVOKE_WATCH_RUN_ALL, invoke_args, **kwargs)


def post_tool_call(tool_name: str, args: dict, result: str, session_id: str = "", **kwargs) -> None:
    if tool_name not in ASYNC_SESSION_TOOLS:
        return
    session_key = _joshu_session_key({"session_id": session_id, **kwargs})
    if not session_key:
        return
    try:
        parsed = json.loads(result)
    except json.JSONDecodeError:
        return
    if not isinstance(parsed, dict):
        return
    for run_id in _run_ids_from_invoke_result(parsed):
        _patch_run_session(run_id, session_key, session_id)


def register(ctx) -> None:
    specs = (
        ("last30days_research", LAST30DAYS_RESEARCH_SCHEMA, last30days_research, "🔎"),
        ("last30days_watch_list", LAST30DAYS_WATCH_LIST_SCHEMA, last30days_watch_list, "👀"),
        ("last30days_watch_add", LAST30DAYS_WATCH_ADD_SCHEMA, last30days_watch_add, "📌"),
        ("last30days_watch_remove", LAST30DAYS_WATCH_REMOVE_SCHEMA, last30days_watch_remove, "🗑️"),
        ("last30days_watch_report", LAST30DAYS_WATCH_REPORT_SCHEMA, last30days_watch_report, "📈"),
        ("last30days_watch_run", LAST30DAYS_WATCH_RUN_SCHEMA, last30days_watch_run, "🔄"),
        ("last30days_watch_run_all", LAST30DAYS_WATCH_RUN_ALL_SCHEMA, last30days_watch_run_all, "📋"),
    )
    for name, schema, handler, emoji in specs:
        ctx.register_tool(
            name=name,
            toolset="joshu-last30days",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
    ctx.register_hook("post_tool_call", post_tool_call)
