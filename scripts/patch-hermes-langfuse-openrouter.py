#!/usr/bin/env python3
"""Idempotent Joshu Langfuse + OpenRouter patches for Hermes >= v0.20.

Applies (when missing):
  - HERMES_LANGFUSE_USER_ID → Langfuse user_id / box_slug
  - Anthropic system prompt in Langfuse generation input (+ conversation_loop hook)
  - OpenRouter usage.include=true (profile + chat_completions transport)
  - Prefer OpenRouter-reported cost in Langfuse usage details

Usage:
  HERMES_DIR=/path/to/hermes-agent python3 scripts/patch-hermes-langfuse-openrouter.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()

LANGFUSE = HERMES_DIR / "plugins/observability/langfuse/__init__.py"
OPENROUTER = HERMES_DIR / "plugins/model-providers/openrouter/__init__.py"
CHAT_COMPLETIONS = HERMES_DIR / "agent/transports/chat_completions.py"
CONVERSATION_LOOP = HERMES_DIR / "agent/conversation_loop.py"

changed_any = False


def log(msg: str) -> None:
    print(f"[hermes-langfuse-patch] {msg}")


def write_if_changed(path: Path, old: str, new: str, label: str) -> None:
    global changed_any
    if old == new:
        log(f"{label}: already applied")
        return
    path.write_text(new, encoding="utf-8")
    changed_any = True
    log(f"{label}: applied")


def patch_langfuse_user_id(text: str) -> str:
    if "langfuse_user_id = _env" in text:
        return text
    needle = """    if session_id:
        trace_ctx["session_id"] = session_id

    if propagate_attributes is not None:
        try:
            with propagate_attributes(
                session_id=session_id or task_key,
                trace_name="Hermes turn",
                tags=["hermes", "langfuse"],
            ):"""
    replacement = """    if session_id:
        trace_ctx["session_id"] = session_id

    langfuse_user_id = _env("HERMES_LANGFUSE_USER_ID")
    if langfuse_user_id:
        trace_ctx["user_id"] = langfuse_user_id
        metadata["box_slug"] = langfuse_user_id
    if propagate_attributes is not None:
        try:
            propagate_kwargs: Dict[str, Any] = {
                "session_id": session_id or task_key,
                "trace_name": "Hermes turn",
                "tags": ["hermes", "langfuse"],
            }
            if langfuse_user_id:
                propagate_kwargs["user_id"] = langfuse_user_id
            with propagate_attributes(
                **propagate_kwargs,
            ):"""
    if needle not in text:
        raise SystemExit("langfuse user_id: _start_root_trace anchor not found")
    # Docstring optional env list
    doc_needle = '  HERMES_LANGFUSE_ENV         - environment tag (e.g. "production", "local")\n'
    doc_add = (
        '  HERMES_LANGFUSE_ENV         - environment tag (e.g. "production", "local")\n'
        '  HERMES_LANGFUSE_USER_ID     - Langfuse Users view id (e.g. per-sandbox box slug)\n'
    )
    if "HERMES_LANGFUSE_USER_ID" not in text and doc_needle in text:
        text = text.replace(doc_needle, doc_add, 1)
    return text.replace(needle, replacement, 1)


def patch_langfuse_system_helpers(text: str) -> str:
    if "_messages_for_langfuse_input" in text:
        return text
    helpers = '''
def _serialize_system_prompt(system_prompt: Any) -> Optional[dict[str, Any]]:
    """Normalize Anthropic ``system`` param or OpenAI-style system content for Langfuse."""
    if system_prompt is None:
        return None
    if isinstance(system_prompt, str):
        text = system_prompt.strip()
        if not text:
            return None
        return {"role": "system", "content": _safe_value(text)}
    if isinstance(system_prompt, list):
        parts: list[str] = []
        for block in system_prompt:
            if isinstance(block, dict) and block.get("type") == "text":
                piece = block.get("text", "")
                if isinstance(piece, str) and piece:
                    parts.append(piece)
            elif isinstance(block, str) and block:
                parts.append(block)
        if not parts:
            return None
        return {"role": "system", "content": _safe_value("\\n\\n".join(parts))}
    return None


def _messages_for_langfuse_input(
    *,
    request_messages: Any = None,
    messages: Any = None,
    conversation_history: Any = None,
    user_message: Any = None,
    system_prompt: Any = None,
) -> list[dict[str, Any]]:
    """Build generation input: include Anthropic ``system`` when split out of ``messages``."""
    raw = _coerce_request_messages(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
    )
    if raw and raw[0].get("role") == "system":
        return _serialize_messages(raw)
    system_msg = _serialize_system_prompt(system_prompt)
    if system_msg is None:
        return _serialize_messages(raw)
    return [system_msg, *_serialize_messages(raw)]


'''
    anchor = "def _serialize_messages(messages: Any) -> list[dict[str, Any]]:"
    if anchor not in text:
        raise SystemExit("langfuse system helpers: _serialize_messages anchor not found")
    return text.replace(anchor, helpers + anchor, 1)


def patch_langfuse_on_pre_llm_request(text: str) -> str:
    if "langfuse_input = _messages_for_langfuse_input" in text:
        return text
    old_sig = """    conversation_history: Any = None,
    user_message: Any = None,
    turn_id: str = "",
    api_request_id: str = "",
    **_: Any,
) -> None:
    client = _get_langfuse()
    if client is None:
        return

    input_messages = _coerce_request_messages(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
    )
"""
    new_sig = """    conversation_history: Any = None,
    user_message: Any = None,
    system_prompt: Any = None,
    turn_id: str = "",
    api_request_id: str = "",
    **_: Any,
) -> None:
    client = _get_langfuse()
    if client is None:
        return

    input_messages = _coerce_request_messages(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
    )
    langfuse_input = _messages_for_langfuse_input(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
        system_prompt=system_prompt,
    )
    system_chars = 0
    if langfuse_input and langfuse_input[0].get("role") == "system":
        system_chars = len(str(langfuse_input[0].get("content") or ""))
"""
    if old_sig not in text:
        raise SystemExit("langfuse on_pre_llm_request: signature/body anchor not found")
    text = text.replace(old_sig, new_sig, 1)

    old_gen = """        state.generations[req_key] = _start_child_observation(
            state,
            client=client,
            name=f"LLM call {api_call_count}",
            as_type="generation",
            input_value=_serialize_messages(input_messages),
            metadata={
                "provider": provider,
                "platform": platform,
                "api_mode": api_mode,
                "base_url": base_url,
                "message_count": message_count,
                "approx_input_tokens": approx_input_tokens,
            },
            model=model,
            model_parameters={"api_mode": api_mode, "provider": provider},
        )
"""
    # Tolerate older metadata without message_count
    if old_gen not in text:
        old_gen = """        state.generations[req_key] = _start_child_observation(
            state,
            client=client,
            name=f"LLM call {api_call_count}",
            as_type="generation",
            input_value=_serialize_messages(input_messages),
            metadata={
                "provider": provider,
                "platform": platform,
                "api_mode": api_mode,
                "base_url": base_url,
            },
            model=model,
            model_parameters={"api_mode": api_mode, "provider": provider},
        )
"""
    new_gen = """        gen_metadata = {
            "provider": provider,
            "platform": platform,
            "api_mode": api_mode,
            "base_url": base_url,
            "message_count": message_count,
            "approx_input_tokens": approx_input_tokens,
        }
        if system_chars:
            gen_metadata["system_prompt_chars"] = system_chars
        state.generations[req_key] = _start_child_observation(
            state,
            client=client,
            name=f"LLM call {api_call_count}",
            as_type="generation",
            input_value=langfuse_input,
            metadata=gen_metadata,
            model=model,
            model_parameters={"api_mode": api_mode, "provider": provider},
        )
"""
    if old_gen not in text:
        raise SystemExit("langfuse on_pre_llm_request: generation start anchor not found")
    return text.replace(old_gen, new_gen, 1)


def patch_langfuse_openrouter_cost(text: str) -> str:
    if "_openrouter_cost_details" in text:
        return text
    helpers = '''
def _is_openrouter_route(*, provider: str, base_url: str) -> bool:
    if (provider or "").strip().lower() == "openrouter":
        return True
    return "openrouter.ai" in (base_url or "").lower()


def _read_usage_field(raw_usage: Any, field: str) -> Any:
    if raw_usage is None:
        return None
    if isinstance(raw_usage, dict):
        return raw_usage.get(field)
    return getattr(raw_usage, field, None)


def _openrouter_cost_details(raw_usage: Any) -> Dict[str, float]:
    """Prefer OpenRouter-reported USD cost over Hermes/Langfuse price inference."""
    cost_details: Dict[str, float] = {}
    if raw_usage is None:
        return cost_details

    cost_details_raw = _read_usage_field(raw_usage, "cost_details")
    if isinstance(cost_details_raw, dict):
        prompt_cost = cost_details_raw.get("upstream_inference_prompt_cost")
        completion_cost = cost_details_raw.get("upstream_inference_completions_cost")
    elif cost_details_raw is not None:
        prompt_cost = getattr(cost_details_raw, "upstream_inference_prompt_cost", None)
        completion_cost = getattr(cost_details_raw, "upstream_inference_completions_cost", None)
    else:
        prompt_cost = completion_cost = None

    if prompt_cost is not None:
        cost_details["input"] = float(prompt_cost)
    if completion_cost is not None:
        cost_details["output"] = float(completion_cost)

    total_cost = _read_usage_field(raw_usage, "cost")
    if total_cost is not None:
        cost_details["total"] = float(total_cost)

    return cost_details


'''
    anchor = "def _usage_and_cost(response: Any, *, provider: str, api_mode: str, model: str, base_url: str)"
    if anchor not in text:
        raise SystemExit("langfuse cost: _usage_and_cost anchor not found")
    text = text.replace(anchor, helpers + anchor, 1)

    # Insert OpenRouter preference before estimate_usage_cost
    needle = """        if canonical.reasoning_tokens:
            usage_details["reasoning_tokens"] = canonical.reasoning_tokens
        cost = estimate_usage_cost(
"""
    insert = """        if canonical.reasoning_tokens:
            usage_details["reasoning_tokens"] = canonical.reasoning_tokens

        if _is_openrouter_route(provider=provider, base_url=base_url):
            or_cost_details = _openrouter_cost_details(raw_usage)
            if or_cost_details:
                return usage_details, or_cost_details

        cost = estimate_usage_cost(
"""
    if needle not in text:
        raise SystemExit("langfuse cost: estimate_usage_cost anchor not found")
    text = text.replace(needle, insert, 1)

    # Extend _end_observation with optional model=
    old_end = (
        "def _end_observation(observation: Any, *, output: Any = None, metadata: Optional[dict] = None,\n"
        "                     usage_details: Optional[dict] = None, cost_details: Optional[dict] = None) -> None:"
    )
    new_end = (
        "def _end_observation(observation: Any, *, output: Any = None, metadata: Optional[dict] = None,\n"
        "                     usage_details: Optional[dict] = None, cost_details: Optional[dict] = None,\n"
        "                     model: Optional[str] = None) -> None:"
    )
    if old_end in text:
        text = text.replace(old_end, new_end, 1)
        cost_kw = """        if cost_details:
            update_kwargs["cost_details"] = cost_details
        if update_kwargs:"""
        cost_kw_new = """        if cost_details:
            update_kwargs["cost_details"] = cost_details
        if model:
            update_kwargs["model"] = model
        if update_kwargs:"""
        if cost_kw in text and 'update_kwargs["model"] = model' not in text:
            text = text.replace(cost_kw, cost_kw_new, 1)

    return text


def patch_openrouter_usage(text: str) -> str:
    if '"usage": {"include": True}' in text or "'usage': {'include': True}" in text:
        return text
    old = """    def build_extra_body(
        self, *, session_id: str | None = None, **context: Any
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
"""
    new = """    def build_extra_body(
        self, *, session_id: str | None = None, **context: Any
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"usage": {"include": True}}
"""
    if old not in text:
        raise SystemExit("openrouter usage.include: build_extra_body anchor not found")
    return text.replace(old, new, 1)


def patch_chat_completions_usage(text: str) -> str:
    if 'extra_body.setdefault("usage", {"include": True})' in text:
        return text
    needle = """        provider_prefs = params.get("provider_preferences")
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs

        # Pareto Code router plugin — model-gated."""
    insert = """        provider_prefs = params.get("provider_preferences")
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs

        if is_openrouter:
            extra_body.setdefault("usage", {"include": True})

        # Pareto Code router plugin — model-gated."""
    if needle not in text:
        raise SystemExit("chat_completions usage.include: openrouter prefs anchor not found")
    return text.replace(needle, insert, 1)


def patch_conversation_loop_system_prompt(text: str) -> str:
    if "system_prompt=system_prompt_for_hooks" in text:
        return text
    needle = """                        if not isinstance(request_messages, list):
                            request_messages = api_messages
                        # Shallow-copy the outer list so plugins that retain the
"""
    insert = """                        if not isinstance(request_messages, list):
                            request_messages = api_messages
                        # Anthropic Messages API moves system out of messages;
                        # pass it explicitly for observability plugins (Langfuse).
                        system_prompt_for_hooks = api_kwargs.get("system")
                        if system_prompt_for_hooks is None and isinstance(request_messages, list):
                            if request_messages and isinstance(request_messages[0], dict) and request_messages[0].get("role") == "system":
                                system_prompt_for_hooks = request_messages[0].get("content")
                        # Shallow-copy the outer list so plugins that retain the
"""
    if needle not in text:
        raise SystemExit("conversation_loop system_prompt: request_messages anchor not found")
    text = text.replace(needle, insert, 1)

    hook_needle = """                            request_messages=list(request_messages)
                            if isinstance(request_messages, list)
                            else [],
                            message_count=len(api_messages),
"""
    hook_insert = """                            request_messages=list(request_messages)
                            if isinstance(request_messages, list)
                            else [],
                            system_prompt=system_prompt_for_hooks,
                            message_count=len(api_messages),
"""
    if hook_needle not in text:
        raise SystemExit("conversation_loop system_prompt: invoke_hook kwargs anchor not found")
    return text.replace(hook_needle, hook_insert, 1)


def main() -> int:
    if not LANGFUSE.is_file():
        log(f"skip: {LANGFUSE} not found")
        return 0

    lf_old = LANGFUSE.read_text(encoding="utf-8")
    lf = patch_langfuse_user_id(lf_old)
    lf = patch_langfuse_system_helpers(lf)
    lf = patch_langfuse_on_pre_llm_request(lf)
    lf = patch_langfuse_openrouter_cost(lf)
    write_if_changed(LANGFUSE, lf_old, lf, "langfuse plugin")

    if OPENROUTER.is_file():
        or_text = OPENROUTER.read_text(encoding="utf-8")
        or_new = patch_openrouter_usage(or_text)
        write_if_changed(OPENROUTER, or_text, or_new, "openrouter usage.include")

    if CHAT_COMPLETIONS.is_file():
        cc = CHAT_COMPLETIONS.read_text(encoding="utf-8")
        cc_new = patch_chat_completions_usage(cc)
        write_if_changed(CHAT_COMPLETIONS, cc, cc_new, "chat_completions usage.include")

    if CONVERSATION_LOOP.is_file():
        cl = CONVERSATION_LOOP.read_text(encoding="utf-8")
        cl_new = patch_conversation_loop_system_prompt(cl)
        write_if_changed(CONVERSATION_LOOP, cl, cl_new, "conversation_loop system_prompt hook")

    log("done — restart Hermes gateway to load plugin changes")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[hermes-langfuse-patch] error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
