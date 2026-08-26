#!/usr/bin/env python3
"""Gate KANBAN_GUIDANCE on HERMES_KANBAN_TASK (dispatcher workers only).

Orchestrator profiles and api_server sessions that pin kanban in platform_toolsets
must not receive worker lifecycle protocol in the system prompt.

Handles both Hermes layouts:
- Legacy: run_agent.py injects KANBAN_GUIDANCE in _build_system_prompt
- Current (v0.14+): agent/agent_init.py sets _kanban_worker_guidance;
  agent/system_prompt.py has a kanban_show fallback

Idempotent. Target: $HERMES_DIR/
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-kanban-guidance-worker-env-gate-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()

RUN_AGENT = HERMES_DIR / "run_agent.py"
AGENT_INIT = HERMES_DIR / "agent/agent_init.py"
SYSTEM_PROMPT = HERMES_DIR / "agent/system_prompt.py"


def _already_patched(text: str) -> bool:
    return MARKER in text or 'os.environ.get("HERMES_KANBAN_TASK") and "kanban_show"' in text


def patch_run_agent() -> bool:
    if not RUN_AGENT.is_file():
        return False
    text = RUN_AGENT.read_text(encoding="utf-8")
    if _already_patched(text):
        print(f"[kanban-guidance-gate] run_agent.py already patched/skipped")
        return False

    old = (
        '        if "kanban_show" in self.valid_tool_names:\n'
        "            tool_guidance.append(KANBAN_GUIDANCE)"
    )
    new = f"""        # {MARKER}
        if os.environ.get("HERMES_KANBAN_TASK") and "kanban_show" in self.valid_tool_names:
            tool_guidance.append(KANBAN_GUIDANCE)"""
    if old not in text:
        return False
    RUN_AGENT.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"[kanban-guidance-gate] patched {RUN_AGENT}")
    return True


def patch_agent_init() -> bool:
    if not AGENT_INIT.is_file():
        return False
    text = AGENT_INIT.read_text(encoding="utf-8")
    if _already_patched(text):
        print(f"[kanban-guidance-gate] agent_init.py already patched/skipped")
        return False

    old = """    agent._kanban_worker_guidance = (
        KANBAN_GUIDANCE if "kanban_show" in agent.valid_tool_names else ""
    )"""
    new = f"""    agent._kanban_worker_guidance = (
        KANBAN_GUIDANCE
        if os.environ.get("HERMES_KANBAN_TASK") and "kanban_show" in agent.valid_tool_names
        else ""
    )  # {MARKER}"""
    if old not in text:
        return False
    if "import os" not in text.split("\n")[:40]:
        text = text.replace(
            "from __future__ import annotations\n",
            "from __future__ import annotations\n\nimport os\n",
            1,
        )
    AGENT_INIT.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"[kanban-guidance-gate] patched {AGENT_INIT}")
    return True


def patch_system_prompt() -> bool:
    if not SYSTEM_PROMPT.is_file():
        return False
    text = SYSTEM_PROMPT.read_text(encoding="utf-8")
    if _already_patched(text):
        print(f"[kanban-guidance-gate] system_prompt.py already patched/skipped")
        return False

    old = (
        '    elif _kanban_guidance is None and "kanban_show" in agent.valid_tool_names:\n'
        "        # Fallback for code paths that bypass agent_init (rare).\n"
        "        tool_guidance.append(KANBAN_GUIDANCE)"
    )
    new = f"""    elif (
        _kanban_guidance is None
        and os.environ.get("HERMES_KANBAN_TASK")
        and "kanban_show" in agent.valid_tool_names
    ):  # {MARKER}
        # Fallback for code paths that bypass agent_init (rare).
        tool_guidance.append(KANBAN_GUIDANCE)"""
    if old not in text:
        return False
    if "import os" not in text.split("\n")[:40]:
        text = text.replace(
            "from __future__ import annotations\n",
            "from __future__ import annotations\n\nimport os\n",
            1,
        )
    SYSTEM_PROMPT.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"[kanban-guidance-gate] patched {SYSTEM_PROMPT}")
    return True


def main() -> int:
    changed_any = False
    for patch_fn in (patch_run_agent, patch_agent_init, patch_system_prompt):
        if patch_fn():
            changed_any = True

    if changed_any:
        return 0

    # Idempotent no-op when nothing to patch (older/newer upstream already fixed).
    if RUN_AGENT.is_file() and _already_patched(RUN_AGENT.read_text(encoding="utf-8")):
        print(f"[kanban-guidance-gate] already applied ({RUN_AGENT})")
        return 0
    if AGENT_INIT.is_file() and _already_patched(AGENT_INIT.read_text(encoding="utf-8")):
        print(f"[kanban-guidance-gate] already applied ({AGENT_INIT})")
        return 0

    print(
        "[kanban-guidance-gate] error: no known KANBAN_GUIDANCE injection sites found",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
