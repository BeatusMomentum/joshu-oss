#!/usr/bin/env python3
"""browser-use Agent attached to the Chromium Joshu already launched.

Does not start Chrome and does not call Browser.stop(), so the supervisor
process stays up for the screencast and handoff. One run at a time.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CDP_URL = os.environ.get("BROWSER_CDP_URL", "http://127.0.0.1:9222").rstrip("/")
PORT = int(os.environ.get("BROWSER_AGENT_PORT", "9378"))
MAX_STEPS = int(os.environ.get("BROWSER_AGENT_MAX_STEPS", "40"))

_lock = threading.Lock()
_state = {
    "phase": "idle",
    "task": "",
    "result": "",
    "error": "",
    "url": "",
}
_pause = threading.Event()  # set means paused
_loop: asyncio.AbstractEventLoop | None = None
_agent = None


def _set(**kwargs: str) -> None:
    with _lock:
        _state.update(kwargs)


def _snapshot() -> dict:
    with _lock:
        return dict(_state)


def _api_key() -> str:
    """Fleet relay expects Bearer instanceId.rawToken. A bu_ key talks to Browser Use directly."""
    explicit = (os.environ.get("BROWSER_USE_API_KEY") or "").strip()
    if explicit.startswith("bu_"):
        return explicit
    instance_id = (os.environ.get("JOSHU_INSTANCE_ID") or os.environ.get("INSTANCE_ID") or "").strip()
    raw = explicit or (os.environ.get("INSTANCE_AGENT_TOKEN") or "").strip()
    if instance_id and raw and not raw.startswith(f"{instance_id}."):
        return f"{instance_id}.{raw}"
    return raw


def _llm():
    from browser_use import ChatBrowserUse

    # Fleet: BROWSER_USE_LLM_URL is the control-plane relay. Self-host: a bu_ key
    # and the default llm.api.browser-use.com host.
    base_url = (os.environ.get("BROWSER_USE_LLM_URL") or "").strip() or None
    kwargs = {"model": "bu-latest", "api_key": _api_key() or None}
    if base_url:
        kwargs["base_url"] = base_url
    return ChatBrowserUse(**kwargs)


async def _on_step_end(agent) -> None:
    while _pause.is_set():
        pause = getattr(agent, "pause", None)
        if callable(pause):
            pause()
        await asyncio.sleep(0.25)
    resume = getattr(agent, "resume", None)
    if callable(resume):
        resume()


async def _run(task: str) -> None:
    global _agent
    _set(phase="running", task=task, result="", error="")
    try:
        from browser_use import Agent, Browser

        browser = Browser(cdp_url=CDP_URL)
        _agent = Agent(
            task=task,
            llm=_llm(),
            browser=browser,
            use_vision=True,
            vision_detail_level="low",
            llm_screenshot_size=(1024, 640),
        )
        history = await _agent.run(max_steps=MAX_STEPS, on_step_end=_on_step_end)
        result = ""
        final = getattr(history, "final_result", None)
        if callable(final):
            result = final() or ""
        elif final:
            result = str(final)
        url = ""
        try:
            page = await browser.get_current_page()
            url = getattr(page, "url", "") or ""
        except Exception:
            url = ""
        _set(phase="done", result=result or "done", url=url)
    except Exception as err:
        _set(phase="error", error=str(err))
    finally:
        _agent = None
        _pause.clear()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/status":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, _snapshot())

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid_json"})
            return
        if path == "/pause":
            _pause.set()
            if _snapshot()["phase"] == "running":
                _set(phase="paused")
            self._json(200, _snapshot())
            return
        if path == "/resume":
            _pause.clear()
            if _snapshot()["phase"] == "paused":
                _set(phase="running")
            self._json(200, _snapshot())
            return
        if path != "/task":
            self._json(404, {"error": "not_found"})
            return
        task = str(body.get("task") or "").strip()
        if not task:
            self._json(400, {"error": "task is required"})
            return
        phase = _snapshot()["phase"]
        if phase in ("running", "paused"):
            self._json(409, {"error": "agent_busy", "phase": phase})
            return
        if _loop is None:
            self._json(503, {"error": "agent_loop_down"})
            return
        _set(phase="running", task=task, result="", error="")
        fut = asyncio.run_coroutine_threadsafe(_run(task), _loop)
        try:
            fut.result(timeout=20 * 60)
        except Exception as err:
            _set(phase="error", error=str(err))
        self._json(200, _snapshot())


def main() -> None:
    global _loop
    _loop = asyncio.new_event_loop()

    def _serve() -> None:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

    threading.Thread(target=_serve, daemon=True).start()
    print(f"[browser-agent] http://127.0.0.1:{PORT} cdp={CDP_URL}", flush=True)
    _loop.run_forever()


if __name__ == "__main__":
    main()
