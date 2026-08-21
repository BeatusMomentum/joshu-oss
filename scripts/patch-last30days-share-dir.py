#!/usr/bin/env python3
"""
Route last30days research.db via LAST30DAYS_SHARE_DIR (Joshu Aroz user tree).

Upstream defaults to ~/.local/share/last30days which is container overlay FS and
is wiped on joshu-stack force-recreate. Joshu sets LAST30DAYS_SHARE_DIR to
{AROZ_DATA}/files/users/<user>/.joshu/last30days/share.

Idempotent — safe to re-run after sync-last30days-skill.sh.
"""
from __future__ import annotations

from pathlib import Path

OLD = '''DB_DIR = Path.home() / ".local" / "share" / "last30days"
DB_PATH = DB_DIR / "research.db"
'''

NEW = '''# Joshu: LAST30DAYS_SHARE_DIR points at the Aroz user-tree share dir (volume).
_share_override = (os.environ.get("LAST30DAYS_SHARE_DIR") or "").strip()
DB_DIR = Path(_share_override) if _share_override else (Path.home() / ".local" / "share" / "last30days")
DB_PATH = DB_DIR / "research.db"
'''


def patch_store(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if "LAST30DAYS_SHARE_DIR" in text and "_share_override" in text:
        print(f"[patch-last30days-share-dir] already patched {path}")
        return
    if OLD not in text:
        raise SystemExit(f"store.py expected DB_DIR snippet not found in {path}")
    # store.py already imports os near the top.
    if "import os" not in text.split("DB_DIR", 1)[0]:
        raise SystemExit(f"store.py missing `import os` before DB_DIR in {path}")
    path.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"[patch-last30days-share-dir] patched {path}")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    store = (
        root
        / "integrations"
        / "last30days-skill"
        / "skills"
        / "last30days"
        / "scripts"
        / "store.py"
    )
    if not store.is_file():
        print(f"[patch-last30days-share-dir] skip — missing {store}")
        return 0
    patch_store(store)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
