#!/usr/bin/env python3
"""Strip DeepSeek DSML tool markup from Hermes assistant content (all surfaces).

DeepSeek V4 sometimes emits native ``<DSMLtool_calls>`` / ``<DSMLinvoke>`` markup
and ``mcp__…`` tool names in the assistant *content* stream instead of structured
tool_calls.  Hermes already strips ``<tool_call>`` XML via strip_think_blocks, but
not DSML.  This patch adds:

  1. Batch scrub in ``strip_think_blocks`` (post-stream + defensive callers)
  2. ``StreamingDsmlScrubber`` — hold-back streaming scrubber (like think_scrubber)
  3. Wire scrubber in agent init + ``_fire_stream_delta`` + reset paths

Marker: _joshu_dsml_scrub
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
MARKER = "_joshu_dsml_scrub"

TARGET_HELPERS = HERMES_DIR / "agent/agent_runtime_helpers.py"
TARGET_SCRUBBER = HERMES_DIR / "agent/think_scrubber.py"
TARGET_INIT = HERMES_DIR / "agent/agent_init.py"
TARGET_RUN = HERMES_DIR / "run_agent.py"
TARGET_LOOP = HERMES_DIR / "agent/conversation_loop.py"

HELPERS_PATTERNS = f'''
# Joshu ({MARKER}): DeepSeek native DSML tool markup in assistant content.
_JOSHU_DSML_BLOCK_PATTERN = re.compile(
    r"<DSML[^>]*>.*?(?:</DSML[^>]*>|$)",
    re.DOTALL | re.IGNORECASE,
)
_JOSHU_DSML_ORPHAN_TAG_PATTERN = re.compile(r"</?DSML[^>]*>\\s*", re.IGNORECASE)
_JOSHU_MCP_TOOL_NAME_PATTERN = re.compile(r"\\bmcp__[a-z0-9_]+__\\w+\\b", re.IGNORECASE)


def _joshu_strip_dsml_leaks(content: str) -> str:
    """Remove DSML tool-call debris from assistant-visible text ({MARKER})."""
    if not content:
        return ""
    content = _JOSHU_DSML_BLOCK_PATTERN.sub("", content)
    content = _JOSHU_DSML_ORPHAN_TAG_PATTERN.sub("", content)
    content = _JOSHU_MCP_TOOL_NAME_PATTERN.sub(" ", content)
    return content
'''

HELPERS_INSERT_BEFORE = "def strip_think_blocks(agent, content: str) -> str:"

HELPERS_RETURN_PATCH_OLD = """    content = _STRAY_TOOL_CALL_CLOSER_PATTERN.sub('', content)
    return content"""

HELPERS_RETURN_PATCH_NEW = f"""    content = _STRAY_TOOL_CALL_CLOSER_PATTERN.sub('', content)
    # Joshu ({MARKER}): DeepSeek DSML + mcp__ tool names in content stream.
    content = _joshu_strip_dsml_leaks(content)
    return content"""

SCRUBBER_APPEND = f'''

class StreamingDsmlScrubber:
    """Hold-back streaming scrubber for DSML tool markup ({MARKER}).

    DSML tags are never legitimate owner-facing prose, so no block-boundary
    gating — partial ``<DSML`` tails are held back across deltas.
    """

    _HOLD_BACK = 32

    def __init__(self) -> None:
        self._pending = ""

    def reset(self) -> None:
        self._pending = ""

    def feed(self, text: str) -> str:
        if not text:
            return ""
        buf = self._pending + text
        if len(buf) <= self._HOLD_BACK:
            self._pending = buf
            return ""
        safe = buf[:-self._HOLD_BACK]
        self._pending = buf[-self._HOLD_BACK :]
        from agent.agent_runtime_helpers import _joshu_strip_dsml_leaks

        return _joshu_strip_dsml_leaks(safe)

    def flush(self) -> str:
        from agent.agent_runtime_helpers import _joshu_strip_dsml_leaks

        out = _joshu_strip_dsml_leaks(self._pending)
        self._pending = ""
        return out
'''

SCRUBBER_ALL_OLD = '__all__ = ["StreamingThinkScrubber"]'
SCRUBBER_ALL_NEW = f'__all__ = ["StreamingThinkScrubber", "StreamingDsmlScrubber"]  # {MARKER}'

INIT_IMPORT_OLD = "from agent.think_scrubber import StreamingThinkScrubber"
INIT_IMPORT_NEW = f"from agent.think_scrubber import StreamingDsmlScrubber, StreamingThinkScrubber  # {MARKER}"

INIT_WIRE_OLD = "    agent._stream_think_scrubber = StreamingThinkScrubber()"
INIT_WIRE_NEW = f"""    agent._stream_think_scrubber = StreamingThinkScrubber()
    # Joshu ({MARKER}): DeepSeek DSML tool markup in streamed content.
    agent._stream_dsml_scrubber = StreamingDsmlScrubber()"""

RUN_DELTA_OLD = """            think_scrubber = getattr(self, "_stream_think_scrubber", None)
            if think_scrubber is not None:
                text = think_scrubber.feed(text or "")
            else:
                # Defensive: legacy callers without the scrubber attribute.
                text = self._strip_think_blocks(text or "")
            # Then feed through the stateful context scrubber so memory-context"""

RUN_DELTA_NEW = f"""            think_scrubber = getattr(self, "_stream_think_scrubber", None)
            if think_scrubber is not None:
                text = think_scrubber.feed(text or "")
            else:
                # Defensive: legacy callers without the scrubber attribute.
                text = self._strip_think_blocks(text or "")
            # Joshu ({MARKER}): strip DeepSeek DSML tool markup from content stream.
            dsml_scrubber = getattr(self, "_stream_dsml_scrubber", None)
            if dsml_scrubber is not None:
                text = dsml_scrubber.feed(text or "")
            # Then feed through the stateful context scrubber so memory-context"""

LOOP_RESET_OLD = '    for attr in ("_stream_context_scrubber", "_stream_think_scrubber"):'
LOOP_RESET_NEW = f'    for attr in ("_stream_context_scrubber", "_stream_think_scrubber", "_stream_dsml_scrubber"):  # {MARKER}'

RESET_TRACKING_OLD = """        think_scrubber = getattr(self, "_stream_think_scrubber", None)
        if think_scrubber is not None:
            think_tail = think_scrubber.flush()"""

RESET_TRACKING_NEW = f"""        think_scrubber = getattr(self, "_stream_think_scrubber", None)
        if think_scrubber is not None:
            think_tail = think_scrubber.flush()"""

# Insert dsml flush after think flush block - need to read run_agent more carefully

RESET_TRACKING_INSERT_AFTER = """                if think_tail:
                    callbacks = [cb for cb in (self.stream_delta_callback, self._stream_callback) if cb is not None]
                    for cb in callbacks:
                        try:
                            cb(think_tail)
                        except Exception:
                            pass
                    self._record_streamed_assistant_text(think_tail)
        # Flush any benign partial-tag tail held by the context scrubber so it"""

RESET_TRACKING_INSERT = f"""                if think_tail:
                    callbacks = [cb for cb in (self.stream_delta_callback, self._stream_callback) if cb is not None]
                    for cb in callbacks:
                        try:
                            cb(think_tail)
                        except Exception:
                            pass
                    self._record_streamed_assistant_text(think_tail)
        # Joshu ({MARKER}): flush DSML scrubber tail before context scrubber.
        dsml_scrubber = getattr(self, "_stream_dsml_scrubber", None)
        if dsml_scrubber is not None:
            dsml_tail = dsml_scrubber.flush()
            if dsml_tail:
                ctx_scrubber = getattr(self, "_stream_context_scrubber", None)
                if ctx_scrubber is not None:
                    dsml_tail = ctx_scrubber.feed(dsml_tail)
                if dsml_tail:
                    callbacks = [cb for cb in (self.stream_delta_callback, self._stream_callback) if cb is not None]
                    for cb in callbacks:
                        try:
                            cb(dsml_tail)
                        except Exception:
                            pass
                    self._record_streamed_assistant_text(dsml_tail)
        # Flush any benign partial-tag tail held by the context scrubber so it"""


def _apply_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text and old not in text and new in text:
        print(f"[hermes-dsml-scrub] {label}: already patched")
        return
    if old not in text:
        raise SystemExit(f"[hermes-dsml-scrub] {label}: anchor not found in {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"[hermes-dsml-scrub] {label}: applied")


def main() -> int:
    if not TARGET_HELPERS.is_file():
        print(f"[hermes-dsml-scrub] skip — {TARGET_HELPERS} missing", file=sys.stderr)
        return 0

    helpers = TARGET_HELPERS.read_text(encoding="utf-8")
    if MARKER not in helpers:
        idx = helpers.find(HELPERS_INSERT_BEFORE)
        if idx == -1:
            raise SystemExit("[hermes-dsml-scrub] helpers: strip_think_blocks anchor not found")
        helpers = helpers[:idx] + HELPERS_PATTERNS + "\n\n" + helpers[idx:]
        if HELPERS_RETURN_PATCH_OLD not in helpers:
            raise SystemExit("[hermes-dsml-scrub] helpers: return anchor not found")
        helpers = helpers.replace(HELPERS_RETURN_PATCH_OLD, HELPERS_RETURN_PATCH_NEW, 1)
        TARGET_HELPERS.write_text(helpers, encoding="utf-8")
        print("[hermes-dsml-scrub] agent_runtime_helpers.py: applied")
    else:
        print("[hermes-dsml-scrub] agent_runtime_helpers.py: already patched")

    scrubber = TARGET_SCRUBBER.read_text(encoding="utf-8")
    if MARKER not in scrubber:
        if SCRUBBER_ALL_OLD not in scrubber:
            raise SystemExit("[hermes-dsml-scrub] think_scrubber: __all__ anchor not found")
        scrubber = scrubber.replace(SCRUBBER_ALL_OLD, SCRUBBER_ALL_NEW, 1)
        scrubber = scrubber.rstrip() + SCRUBBER_APPEND + "\n"
        TARGET_SCRUBBER.write_text(scrubber, encoding="utf-8")
        print("[hermes-dsml-scrub] think_scrubber.py: applied")
    else:
        print("[hermes-dsml-scrub] think_scrubber.py: already patched")

    _apply_once(TARGET_INIT, INIT_IMPORT_OLD, INIT_IMPORT_NEW, "agent_init import")
    _apply_once(TARGET_INIT, INIT_WIRE_OLD, INIT_WIRE_NEW, "agent_init wire")

    run_path = TARGET_RUN if TARGET_RUN.is_file() else HERMES_DIR / "run_agent.py"
    _apply_once(run_path, RUN_DELTA_OLD, RUN_DELTA_NEW, "run_agent delta")
    if RESET_TRACKING_INSERT_AFTER in run_path.read_text(encoding="utf-8"):
        _apply_once(run_path, RESET_TRACKING_INSERT_AFTER, RESET_TRACKING_INSERT, "run_agent flush")

    loop_path = TARGET_LOOP
    if loop_path.is_file():
        _apply_once(loop_path, LOOP_RESET_OLD, LOOP_RESET_NEW, "conversation_loop reset")

    print("[hermes-dsml-scrub] done — restart Hermes gateway to load changes")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[hermes-dsml-scrub] error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
