"""browser_task — Joshu localhost API for the browser-use sidecar."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from .schemas import BROWSER_TASK_SCHEMA

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def _post_json(path: str, body: dict, timeout: int) -> tuple[int, dict]:
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}{path}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"error": detail or f"HTTP {err.code}"}
        return err.code, parsed


def browser_task(args: dict, **kwargs) -> str:
    task = str(args.get("task") or "").strip()
    if not task:
        return json.dumps({"ok": False, "error": "task is required"})
    status, data = _post_json("/api/browser-agent/task", {"task": task}, timeout=20 * 60)
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps({"ok": True, **data})


def register(ctx) -> None:
    ctx.register_tool(
        name="browser_task",
        toolset="joshu-browser-agent",
        schema=BROWSER_TASK_SCHEMA,
        handler=browser_task,
        emoji="🌐",
    )
