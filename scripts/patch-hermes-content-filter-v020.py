#!/usr/bin/env python3
"""Port Joshu DeepSeek/OpenRouter content_filter retries onto Hermes conversation_loop.

Upstream v0.20 never retries the same model on finish_reason=content_filter.
Joshu retries up to 2 times (trim bulky tool results + English nudge), then
tries configured fallback, then returns an English error.

Marker: _joshu_content_filter_retry
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "agent/conversation_loop.py"
MARKER = "_joshu_content_filter_retry"

HELPERS = '''
# Joshu: same-model recovery for provider content_filter refusals (DeepSeek via OpenRouter).
# Upstream refuse-and-fallback-only is insufficient for jChat — nudge + trim often unblocks.
_JOSHU_CONTENT_FILTER_REFUSAL_PATTERNS = (
    re.compile(r"你好，我无法给到相关内容"),
    re.compile(r"^I(?:'m| am) sorry,? but I can't assist with that request\\.?$", re.I),
    re.compile(r"^I cannot (?:help|assist) with (?:that|this)\\.?$", re.I),
)


def _joshu_is_provider_content_filter_response(agent, finish_reason: str, assistant_message) -> bool:
    """Detect provider moderation blocks that should never reach the user ({marker})."""
    if (finish_reason or "").strip().lower() == "content_filter":
        return True
    content = getattr(assistant_message, "content", None)
    if not isinstance(content, str):
        return False
    visible = agent._strip_think_blocks(content).strip()
    if not visible:
        return False
    for pattern in _JOSHU_CONTENT_FILTER_REFUSAL_PATTERNS:
        if pattern.search(visible):
            return True
    return False


def _joshu_trim_recent_tool_results_for_content_filter(messages: list, *, max_tool_chars: int = 4000) -> int:
    """Truncate bulky tool payloads that often trip provider moderation ({marker})."""
    trimmed = 0
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "tool":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            if len(content) <= max_tool_chars:
                continue
            msg["content"] = (
                content[:max_tool_chars]
                + "\\n\\n… (truncated for moderation retry)"
            )
            trimmed += 1
        elif isinstance(content, (dict, list)):
            serialized = json.dumps(content, ensure_ascii=False)
            if len(serialized) <= max_tool_chars:
                continue
            msg["content"] = (
                serialized[:max_tool_chars]
                + "… (truncated for moderation retry)"
            )
            trimmed += 1
    return trimmed


def _joshu_reset_streamed_assistant_output(agent) -> None:
    """Discard streamed assistant text after a blocked provider response ({marker})."""
    agent._current_streamed_assistant_text = ""
    for attr in ("_stream_context_scrubber", "_stream_think_scrubber"):
        scrubber = getattr(agent, attr, None)
        if scrubber is not None and hasattr(scrubber, "reset"):
            scrubber.reset()


'''.replace("{marker}", MARKER)

# Replacement block for the HTTP-200 content_filter branch.
NEW_BLOCK = r'''                # ── Content-policy refusal (HTTP 200) — Joshu retry path ──
                # Upstream never retries the same model. Joshu retries with tool
                # trim + English nudge (common DeepSeek OpenRouter content_filter
                # pattern) before falling back / failing.
                if finish_reason == "content_filter" or (
                    "_joshu_content_filter_retry"  # marker for apply script
                    and False  # placeholder replaced below
                ):
                    pass
'''

# Actually write the real block carefully:
NEW_BLOCK = '''                # ── Content-policy refusal (HTTP 200) — Joshu retry path ──
                # Upstream never retries the same model. Joshu retries with tool
                # trim + English nudge (common DeepSeek OpenRouter content_filter
                # pattern) before falling back / failing. (__MARKER__)
                _refusal_transport = agent._get_transport()
                if agent.api_mode == "anthropic_messages":
                    _refusal_result = _refusal_transport.normalize_response(
                        response, strip_tool_prefix=agent._is_anthropic_oauth
                    )
                else:
                    _refusal_result = _refusal_transport.normalize_response(response)
                _assistant_for_filter = getattr(_refusal_result, "content", None)
                # Normalize to a lightweight message-like for pattern checks.
                class _JoshuFilterMsg:
                    def __init__(self, content):
                        self.content = content
                _filter_msg = _JoshuFilterMsg(_assistant_for_filter)
                if not _joshu_is_provider_content_filter_response(
                    agent, finish_reason, _filter_msg
                ):
                    pass  # fall through — only when finish_reason was length etc.
                elif True:
                    _refusal_text = (getattr(_refusal_result, "content", None) or "").strip()
                    if not _refusal_text:
                        _refusal_text = (agent._extract_reasoning(_refusal_result) or "").strip()

                    if not hasattr(agent, "_content_filter_retries"):
                        agent._content_filter_retries = 0
                    agent._content_filter_retries += 1
                    logger.warning(
                        "%sProvider content filter blocked response "
                        "(retry %d/2, model=%s, preview=%r)",
                        agent.log_prefix,
                        agent._content_filter_retries,
                        agent.model,
                        (_refusal_text or "")[:120],
                    )
                    agent._emit_status(
                        "⚠️ Provider moderation blocked the response — retrying"
                    )
                    _joshu_reset_streamed_assistant_output(agent)

                    if thinking_spinner:
                        thinking_spinner.stop("")
                        thinking_spinner = None
                    if agent.thinking_callback:
                        agent.thinking_callback("")

                    if agent._content_filter_retries <= 2:
                        _joshu_trim_recent_tool_results_for_content_filter(messages)
                        messages.append({
                            "role": "user",
                            "content": (
                                "[System: The model provider blocked the previous "
                                "completion due to content moderation "
                                "(finish_reason=content_filter). Respond in English "
                                "only. Answer the user's latest request directly using "
                                "available tools. Do not repeat provider refusal "
                                "boilerplate. If tool outputs are large, summarize "
                                "instead of echoing raw payloads.]"
                            ),
                            "_content_filter_recovery_synthetic": True,
                        })
                        agent._session_messages = messages
                        agent._save_session_log(messages)
                        continue

                    if agent._has_pending_fallback():
                        agent._buffer_status(
                            "⚠️ Model declined to respond (safety refusal) — trying fallback..."
                        )
                    if agent._try_activate_fallback():
                        agent._content_filter_retries = 0
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue

                    agent._content_filter_retries = 0
                    agent._flush_status_buffer()
                    _filter_response = (
                        "Sorry — the model provider blocked that response due to "
                        "content moderation. I couldn't complete this request after "
                        "retrying. Try rephrasing, starting a fresh session, or asking "
                        "me to use a specific tool path (for example joshu-mail for "
                        "email)."
                    )
                    agent._cleanup_task_resources(effective_task_id)
                    agent._persist_session(messages, conversation_history)
                    return _content_policy_blocked_result(
                        messages,
                        api_call_count,
                        final_response=_filter_response,
                        error_detail=_refusal_text or "content_filter",
                    )

'''.replace("__MARKER__", MARKER)


def log(msg: str) -> None:
    print(f"[hermes-content-filter-patch] {msg}")


def main() -> int:
    if not TARGET.is_file():
        # Pre-v0.20: run_agent.py path handled by legacy .patch
        run_agent = HERMES_DIR / "run_agent.py"
        if run_agent.is_file() and "_is_provider_content_filter_response" in run_agent.read_text(encoding="utf-8"):
            log("legacy run_agent.py already has content-filter helpers")
            return 0
        log(f"skip: {TARGET} not found")
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text and "_joshu_is_provider_content_filter_response" in text:
        log("already applied")
        return 0

    # Ensure `re` / `json` imported at module level
    if "\nimport re\n" not in text and not re.search(r"^import re\b", text, re.M):
        text = text.replace("\nimport os\n", "\nimport os\nimport re\n", 1)
    if "\nimport json\n" not in text and not re.search(r"^import json\b", text, re.M):
        text = text.replace("\nimport os\n", "\nimport os\nimport json\n", 1)

    if "_joshu_is_provider_content_filter_response" not in text:
        anchor = "_CONTENT_POLICY_RECOVERY_HINT = (\n"
        idx = text.find(anchor)
        if idx < 0:
            raise SystemExit("CONTENT_POLICY_RECOVERY_HINT anchor not found")
        # Insert helpers after the hint tuple closes
        close = text.find(")\n\n", idx)
        if close < 0:
            raise SystemExit("CONTENT_POLICY_RECOVERY_HINT close not found")
        insert_at = close + 3
        text = text[:insert_at] + HELPERS + text[insert_at:]

    # Replace the upstream content_filter block (from comment through return _content_policy_blocked_result)
    start = text.find("                # ── Content-policy refusal (HTTP 200)")
    if start < 0:
        start = text.find('                if finish_reason == "content_filter":')
    if start < 0:
        raise SystemExit("content_filter block start not found")

    # Find the end: return _content_policy_blocked_result(...) after that start, then blank line before next if
    end_marker = "                    return _content_policy_blocked_result(\n"
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit("content_filter return marker not found")
    # extend to end of that return call
    paren = text.find(")\n\n", end)
    if paren < 0:
        raise SystemExit("content_filter return close not found")
    end = paren + 3

    # Only replace if this is the finish_reason branch (first occurrence in loop)
    block = text[start:end]
    if 'if finish_reason == "content_filter"' not in block and MARKER not in block:
        raise SystemExit("unexpected content_filter block shape")

    # Rewrite as: if finish_reason == content_filter OR pattern match after normalize
    # Simpler: keep `if finish_reason == "content_filter":` guard at top of NEW_BLOCK
    real_block = '''                # ── Content-policy refusal (HTTP 200) — Joshu retry path (__MARKER__)
                # Upstream never retries the same model. Joshu retries with tool
                # trim + English nudge (common DeepSeek OpenRouter content_filter
                # pattern) before falling back / failing.
                if finish_reason == "content_filter":
                    _refusal_transport = agent._get_transport()
                    if agent.api_mode == "anthropic_messages":
                        _refusal_result = _refusal_transport.normalize_response(
                            response, strip_tool_prefix=agent._is_anthropic_oauth
                        )
                    else:
                        _refusal_result = _refusal_transport.normalize_response(response)
                    _refusal_text = (getattr(_refusal_result, "content", None) or "").strip()
                    if not _refusal_text:
                        _refusal_text = (agent._extract_reasoning(_refusal_result) or "").strip()

                    if not hasattr(agent, "_content_filter_retries"):
                        agent._content_filter_retries = 0
                    agent._content_filter_retries += 1
                    logger.warning(
                        "%sProvider content filter blocked response "
                        "(retry %d/2, model=%s, preview=%r)",
                        agent.log_prefix,
                        agent._content_filter_retries,
                        agent.model,
                        (_refusal_text or "")[:120],
                    )
                    agent._emit_status(
                        "⚠️ Provider moderation blocked the response — retrying"
                    )
                    _joshu_reset_streamed_assistant_output(agent)

                    if thinking_spinner:
                        thinking_spinner.stop("")
                        thinking_spinner = None
                    if agent.thinking_callback:
                        agent.thinking_callback("")

                    if agent._content_filter_retries <= 2:
                        _joshu_trim_recent_tool_results_for_content_filter(messages)
                        messages.append({
                            "role": "user",
                            "content": (
                                "[System: The model provider blocked the previous "
                                "completion due to content moderation "
                                "(finish_reason=content_filter). Respond in English "
                                "only. Answer the user's latest request directly using "
                                "available tools. Do not repeat provider refusal "
                                "boilerplate. If tool outputs are large, summarize "
                                "instead of echoing raw payloads.]"
                            ),
                            "_content_filter_recovery_synthetic": True,
                        })
                        agent._session_messages = messages
                        agent._save_session_log(messages)
                        continue

                    if agent._has_pending_fallback():
                        agent._buffer_status(
                            "⚠️ Model declined to respond (safety refusal) — trying fallback..."
                        )
                    if agent._try_activate_fallback():
                        agent._content_filter_retries = 0
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue

                    agent._content_filter_retries = 0
                    agent._flush_status_buffer()
                    _filter_response = (
                        "Sorry — the model provider blocked that response due to "
                        "content moderation. I couldn't complete this request after "
                        "retrying. Try rephrasing, starting a fresh session, or asking "
                        "me to use a specific tool path (for example joshu-mail for "
                        "email)."
                    )
                    agent._cleanup_task_resources(effective_task_id)
                    agent._persist_session(messages, conversation_history)
                    return _content_policy_blocked_result(
                        messages,
                        api_call_count,
                        final_response=_filter_response,
                        error_detail=_refusal_text or "content_filter",
                    )

'''.replace("__MARKER__", MARKER)

    text = text[:start] + real_block + text[end:]
    TARGET.write_text(text, encoding="utf-8")
    log("applied — restart Hermes gateway to load changes")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[hermes-content-filter-patch] error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
