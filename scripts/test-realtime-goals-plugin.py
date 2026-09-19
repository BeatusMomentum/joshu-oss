#!/usr/bin/env python3
"""Contract tests for the Hermes Slack/Telegram admission hook."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / ".hermes/plugins/joshu-realtime-goals/tools.py"
SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_tools", TOOLS)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Adapter:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict | None]] = []

    async def send(self, chat_id: str, text: str, metadata=None) -> None:
        self.sent.append((chat_id, text, metadata))


class Platform:
    value = "slack"


async def main() -> None:
    assert MODULE._origin_from_session("agent:main:email:dm:owner") is None
    assert MODULE._origin_from_session("share-chat:public") is None
    assert MODULE._origin_from_session("agent:main:slack:dm:D1")["channel"] == "slack"
    os.environ["HERMES_KANBAN_TASK"] = "t_worker"
    rejected = json.loads(
        MODULE.realtime_goal_defer(
            {"objective": "recursively queue me"},
            gateway_session_key="joshu-hermes-chat:test",
        )
    )
    assert rejected["ok"] is False
    del os.environ["HERMES_KANBAN_TASK"]

    platform = Platform()
    source = SimpleNamespace(
        platform=platform,
        user_id="U1",
        chat_id="C1",
        thread_id="123.456",
    )
    event = SimpleNamespace(source=source, text="Research this deeply", message_id="M1")
    adapter = Adapter()
    gateway = SimpleNamespace(
        adapters={platform: adapter},
        _is_user_authorized=lambda _source: True,
        _session_key_for_source=lambda _source: "agent:main:slack:channel:C1:123.456",
    )

    MODULE._post = lambda *_args, **_kwargs: {
        "action": "reply",
        "text": "Queued. Anything else?",
    }
    result = MODULE.pre_gateway_dispatch(event, gateway)
    assert result["action"] == "skip"
    await asyncio.sleep(0)
    assert adapter.sent == [
        ("C1", "Queued. Anything else?", {"thread_id": "123.456"})
    ]

    gateway._is_user_authorized = lambda _source: False
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    event.text = "/status"
    gateway._is_user_authorized = lambda _source: True
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    print("test-realtime-goals-plugin: ok")


asyncio.run(main())
