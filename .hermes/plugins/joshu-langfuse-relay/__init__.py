"""Joshu Langfuse relay — Hermes plugin (no Langfuse secrets on the box).

Posts lightweight turn/tool events to the control-plane ingest endpoint.
CP holds DEFAULT_HERMES_LANGFUSE_* and forwards asynchronously.
"""

from .relay import register

__all__ = ["register"]
