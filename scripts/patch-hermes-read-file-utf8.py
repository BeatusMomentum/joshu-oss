#!/usr/bin/env python3
"""Fix Hermes read_file false-binary on UTF-8 truncated samples + skip AppleDouble.

Upstream `_is_likely_binary` treats any U+FFFD in the head sample as binary.
`read_file` samples with `head -c 1000`, which often splits a multibyte UTF-8
sequence mid-character. The terminal backend decodes stdout with
errors="replace", so valid Markdown (e.g. about.md ending mid-emdash) becomes
"…�" and is rejected as "Binary file - cannot display as text".

Joshu: strip a single trailing U+FFFD from the sample before the FFFD check,
and drop macOS AppleDouble `._*` paths from search_files results.

Marker: _joshu_utf8_head_truncate
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "tools/file_operations.py"
MARKER = "_joshu_utf8_head_truncate"

# Exact upstream block (Hermes v0.20 / v2026.8.3).
OLD_BINARY_CHECK = '''            if "\\ufffd" in content_sample[:1000]:
                return True
            non_printable = sum(1 for c in content_sample[:1000]
                               if ord(c) < 32 and c not in '\\n\\r\\t')
            return non_printable / min(len(content_sample), 1000) > 0.30'''

NEW_BINARY_CHECK = '''            # Joshu (__MARKER__): head -c N often cuts mid UTF-8 sequence;
            # terminal errors=replace yields a trailing U+FFFD on valid text.
            sample = content_sample[:1000]
            if sample.endswith("\\ufffd"):
                sample = sample[:-1]
            if "\\ufffd" in sample:
                return True
            denom = min(len(sample), 1000) if sample else 1
            non_printable = sum(1 for c in sample
                               if ord(c) < 32 and c not in '\\n\\r\\t')
            return non_printable / denom > 0.30'''.replace("__MARKER__", MARKER)

# Insert AppleDouble filter before return SearchResult in file-name search paths.
# Target distinctive return blocks (find fallback + rg path).
OLD_FIND_RETURN = '''        return SearchResult(
            files=files,
            total_count=len(files),
            truncated=bool(limit_reason),
            limit_reason=limit_reason,
        )

    def _search_files_rg(self, pattern: str, path: str, limit: int, offset: int) -> SearchResult:'''

NEW_FIND_RETURN = '''        # Joshu (__MARKER__): skip macOS AppleDouble sidecars.
        files = [f for f in files if not Path(f).name.startswith("._")]
        return SearchResult(
            files=files,
            total_count=len(files),
            truncated=bool(limit_reason),
            limit_reason=limit_reason,
        )

    def _search_files_rg(self, pattern: str, path: str, limit: int, offset: int) -> SearchResult:'''.replace(
    "__MARKER__", MARKER
)

OLD_RG_RETURN = '''        page = all_files[offset:offset + limit]

        return SearchResult(
            files=page,
            total_count=len(all_files),
            truncated=len(all_files) >= fetch_limit or bool(limit_reason),
            limit_reason=limit_reason,
        )
    
    def _search_content(self, pattern: str, path: str, file_glob: Optional[str],'''

NEW_RG_RETURN = '''        # Joshu (__MARKER__): skip macOS AppleDouble sidecars.
        all_files = [f for f in all_files if not Path(f).name.startswith("._")]
        page = all_files[offset:offset + limit]

        return SearchResult(
            files=page,
            total_count=len(all_files),
            truncated=len(all_files) >= fetch_limit or bool(limit_reason),
            limit_reason=limit_reason,
        )
    
    def _search_content(self, pattern: str, path: str, file_glob: Optional[str],'''.replace(
    "__MARKER__", MARKER
)


def main() -> int:
    if not TARGET.is_file():
        print(f"[hermes-read-file-utf8] skip: {TARGET} not found", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[hermes-read-file-utf8] already applied ({TARGET})")
        return 0

    missing = []
    if OLD_BINARY_CHECK not in text:
        missing.append("_is_likely_binary FFFD check")
    if OLD_FIND_RETURN not in text:
        missing.append("_search_files return")
    if OLD_RG_RETURN not in text:
        missing.append("_search_files_rg return")
    if missing:
        print(
            f"[hermes-read-file-utf8] error: expected blocks missing in {TARGET}: "
            + ", ".join(missing),
            file=sys.stderr,
        )
        return 1

    text = text.replace(OLD_BINARY_CHECK, NEW_BINARY_CHECK, 1)
    text = text.replace(OLD_FIND_RETURN, NEW_FIND_RETURN, 1)
    text = text.replace(OLD_RG_RETURN, NEW_RG_RETURN, 1)
    TARGET.write_text(text, encoding="utf-8")
    print(f"[hermes-read-file-utf8] applied → {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
