#!/usr/bin/env python3
"""
Pin watchlist.py research runs to a 7-day window (not upstream 90d --quick).

Idempotent — safe to re-run after sync-last30days-skill.sh.
"""
from __future__ import annotations

from pathlib import Path

OLD = '''                "--emit=json",
                "--json-profile=raw",
                "--quick",
                "--lookback-days",
                "90",
'''

NEW = '''                "--emit=json",
                "--json-profile=agent",
                "--days=7",
'''


def patch_watchlist(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if "--days=7" in text and "--lookback-days" not in text.split("_run_topic", 1)[-1][:800]:
        print(f"[patch-last30days-watch-window] already patched {path}")
        return
    if OLD not in text:
        if "--days=7" in text:
            print(f"[patch-last30days-watch-window] already patched {path}")
            return
        raise SystemExit(f"watchlist.py expected snippet not found in {path}")
    path.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"[patch-last30days-watch-window] patched {path}")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    watchlist = (
        root
        / "integrations"
        / "last30days-skill"
        / "skills"
        / "last30days"
        / "scripts"
        / "watchlist.py"
    )
    if not watchlist.is_file():
        print(f"[patch-last30days-watch-window] skip — missing {watchlist}")
        return 0
    patch_watchlist(watchlist)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
