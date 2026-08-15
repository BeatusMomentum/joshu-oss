#!/usr/bin/env python3
"""Stop Hermes auto-decompose / block-loop triage from hijacking EA scheduling.

Root cause (patrick, 2026-08-12 Becca thread):
  ingress unblocks meeting task → worker sends + kanban_block("awaiting reply")
  → Hermes block_loop (same kind ×2) routes task to triage
  → global auto_decompose fans out children that also nylas_send_message

Joshu scheduling is one meeting card → one worker. auto_decompose is only for
project-<slug> boards (ea-project-kanban). EA boards must never auto-fan-out.

Patches:
  1) gateway/kanban_watchers.py — skip ea-scheduling / ea-mail-ingress /
     ea-sched-ingress in _auto_decompose_tick
  2) hermes_cli/kanban_db.py — on block_loop for those boards, stay blocked
     instead of routing to triage

Marker: _joshu_ea_kanban_no_autodecompose
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
MARKER = "_joshu_ea_kanban_no_autodecompose"

WATCHERS = HERMES_DIR / "gateway/kanban_watchers.py"
KANBAN_DB = HERMES_DIR / "hermes_cli/kanban_db.py"

EA_BOARDS_LITERAL = (
    '{"ea-scheduling", "ea-mail-ingress", "ea-sched-ingress", "ea-owner-reply"}  # ' + MARKER
)


def _die(msg: str) -> None:
    print(f"[hermes-ea-kanban-no-autodecompose] error: {msg}", file=sys.stderr)
    sys.exit(1)


def _patch_watchers(text: str) -> str:
    if MARKER in text and "EA_NO_AUTODECOMPOSE" in text:
        print("[hermes-ea-kanban-no-autodecompose] watchers: already applied")
        return text

    needle = """            for b in boards:
                slug = b.get("slug") or _kb.DEFAULT_BOARD
                if attempted >= auto_decompose_per_tick:
                    break
                # Pin this board for the duration of the call — same"""

    if needle not in text:
        _die("watchers: auto_decompose board loop anchor not found")

    insert = f"""            # Joshu: never auto-decompose EA mail/scheduling boards ({MARKER}).
            # Meeting cards are single-worker; fan-out caused duplicate outreach.
            EA_NO_AUTODECOMPOSE = {EA_BOARDS_LITERAL}
            for b in boards:
                slug = b.get("slug") or _kb.DEFAULT_BOARD
                if attempted >= auto_decompose_per_tick:
                    break
                if slug in EA_NO_AUTODECOMPOSE:
                    continue
                # Pin this board for the duration of the call — same"""

    return text.replace(needle, insert, 1)


def _patch_kanban_db(text: str) -> str:
    if MARKER in text and "joshu_ea_keep_blocked" in text:
        print("[hermes-ea-kanban-no-autodecompose] kanban_db: already applied")
        return text

    needle = """        if recurrences >= BLOCK_RECURRENCE_LIMIT:
            # Loop detected — stop letting the unblocker spin this task. Route
            # to triage for a human-in-the-loop decision instead of blocked.
            cur = conn.execute(
                \"\"\"
                UPDATE tasks
                   SET status        = 'triage',
                       claim_lock    = NULL,
                       claim_expires = NULL,
                       worker_pid    = NULL,
                       block_kind    = ?,
                       block_recurrences = ?
                 WHERE id = ?
                   AND status IN ('running', 'ready')
                \"\"\" + (\"\" if expected_run_id is None else \" AND current_run_id = ?\"),
                (kind, recurrences, task_id) if expected_run_id is None
                else (kind, recurrences, task_id, int(expected_run_id)),
            )
            if cur.rowcount != 1:
                return False
            run_id = _end_run(
                conn, task_id,
                outcome=\"blocked\", status=\"blocked\",
                summary=reason,
            )
            if run_id is None and reason:
                run_id = _synthesize_ended_run(
                    conn, task_id, outcome=\"blocked\", summary=reason,
                )
            _append_event(
                conn, task_id, \"block_loop_detected\",
                {
                    \"reason\": reason,
                    \"kind\": kind,
                    \"recurrences\": recurrences,
                    \"limit\": BLOCK_RECURRENCE_LIMIT,
                },
                run_id=run_id,
            )
"""

    if needle not in text:
        _die("kanban_db: block_loop triage anchor not found")

    replacement = f"""        if recurrences >= BLOCK_RECURRENCE_LIMIT:
            # Loop detected — stop letting the unblocker spin this task. Route
            # to triage for a human-in-the-loop decision instead of blocked.
            #
            # Joshu ({MARKER}): EA scheduling/mail boards intentionally
            # unblock→work→re-block ("awaiting reply") across ingress handoffs.
            # Escalating those cards to triage lets auto_decompose fan out
            # duplicate outreach workers. Keep them blocked instead.
            _joshu_ea_keep_blocked = get_current_board() in {EA_BOARDS_LITERAL}
            _joshu_loop_status = "blocked" if _joshu_ea_keep_blocked else "triage"
            cur = conn.execute(
                \"\"\"
                UPDATE tasks
                   SET status        = ?,
                       claim_lock    = NULL,
                       claim_expires = NULL,
                       worker_pid    = NULL,
                       block_kind    = ?,
                       block_recurrences = ?
                 WHERE id = ?
                   AND status IN ('running', 'ready')
                \"\"\" + (\"\" if expected_run_id is None else \" AND current_run_id = ?\"),
                (
                    (_joshu_loop_status, kind, recurrences, task_id)
                    if expected_run_id is None
                    else (_joshu_loop_status, kind, recurrences, task_id, int(expected_run_id))
                ),
            )
            if cur.rowcount != 1:
                return False
            run_id = _end_run(
                conn, task_id,
                outcome=\"blocked\", status=\"blocked\",
                summary=reason,
            )
            if run_id is None and reason:
                run_id = _synthesize_ended_run(
                    conn, task_id, outcome=\"blocked\", summary=reason,
                )
            _append_event(
                conn, task_id, \"block_loop_detected\",
                {{
                    \"reason\": reason,
                    \"kind\": kind,
                    \"recurrences\": recurrences,
                    \"limit\": BLOCK_RECURRENCE_LIMIT,
                    **({{"joshu_ea_keep_blocked": True}} if _joshu_ea_keep_blocked else {{}}),
                }},
                run_id=run_id,
            )
"""

    return text.replace(needle, replacement, 1)


def main() -> int:
    if not WATCHERS.is_file():
        print(f"[hermes-ea-kanban-no-autodecompose] skip: {WATCHERS} not found")
        return 0
    if not KANBAN_DB.is_file():
        print(f"[hermes-ea-kanban-no-autodecompose] skip: {KANBAN_DB} not found")
        return 0

    watchers = WATCHERS.read_text(encoding="utf-8")
    kanban = KANBAN_DB.read_text(encoding="utf-8")

    new_watchers = _patch_watchers(watchers)
    new_kanban = _patch_kanban_db(kanban)

    changed = False
    if new_watchers != watchers:
        WATCHERS.write_text(new_watchers, encoding="utf-8")
        print(f"[hermes-ea-kanban-no-autodecompose] patched {WATCHERS}")
        changed = True
    if new_kanban != kanban:
        KANBAN_DB.write_text(new_kanban, encoding="utf-8")
        print(f"[hermes-ea-kanban-no-autodecompose] patched {KANBAN_DB}")
        changed = True

    if not changed:
        print("[hermes-ea-kanban-no-autodecompose] already applied")
    else:
        print(
            "[hermes-ea-kanban-no-autodecompose] done — restart Hermes gateway to load changes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
