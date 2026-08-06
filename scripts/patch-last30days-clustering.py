#!/usr/bin/env python3
"""
Joshu tuning for last30days clustering + agent JSON ordering.

- Softer text-similarity threshold for opinion/comparison queries (social captions).
- Softer entity-overlap merge so cross-source stories group together.
- Sort agent export clusters by engagement_total (not rerank score).

Idempotent — safe to re-run after sync-last30days-skill.sh.
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = "# --- joshu clustering patch (patch-last30days-clustering.py) ---"


def _replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"{label}: expected snippet not found")
    return text.replace(old, new, 1)


def patch_cluster_py(cluster_path: Path) -> None:
    text = cluster_path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[patch-last30days-clustering] already patched {cluster_path}")
        return

    text = _replace_once(
        text,
        "    threshold = 0.42 if plan.intent == \"breaking_news\" else 0.48\n",
        (
            "    # Joshu: social/opinion queries share entities but not exact phrasing.\n"
            f"    {MARKER}\n"
            "    if plan.intent == \"breaking_news\":\n"
            "        threshold = 0.42\n"
            "    elif plan.intent in (\"opinion\", \"comparison\"):\n"
            "        threshold = 0.36\n"
            "    else:\n"
            "        threshold = 0.48\n"
        ),
        "cluster threshold",
    )

    text = _replace_once(
        text,
        "            if len(shared_entities) >= min_shared_entities and overlap >= 0.45:\n",
        "            if len(shared_entities) >= min_shared_entities and overlap >= 0.32:\n",
        "entity overlap",
    )

    cluster_path.write_text(text, encoding="utf-8")
    print(f"[patch-last30days-clustering] patched {cluster_path}")


def patch_schema_py(schema_path: Path) -> None:
    text = schema_path.read_text(encoding="utf-8")
    if "joshu-agent-export-sort" in text:
        print(f"[patch-last30days-clustering] already patched {schema_path}")
        return

    old_block = """    for index, cluster in enumerate(report.clusters):
        cluster_by_id[cluster.cluster_id] = index
        for candidate_id in cluster.candidate_ids:
            cluster_by_candidate.setdefault(candidate_id, index)
        representative = next(
            (candidates[candidate_id] for candidate_id in cluster.representative_ids if candidate_id in candidates),
            None,
        )
        engagement_total = sum(
            _headline_engagement(candidates[candidate_id])
            for candidate_id in cluster.candidate_ids
            if candidate_id in candidates
        )
        exported_clusters.append(
            {
                "title": cluster.title,
                "summary": _agent_summary(representative) if representative else "",
                "sources": list(cluster.sources),
                "engagement_total": (
                    int(engagement_total) if engagement_total.is_integer() else engagement_total
                ),
            }
        )

    results: list[dict[str, Any]] = []"""

    new_block = """    # joshu-agent-export-sort: rank clusters by engagement, not rerank score.
    cluster_rows: list[tuple[float, int, dict[str, Any], str]] = []
    for index, cluster in enumerate(report.clusters):
        representative = next(
            (candidates[candidate_id] for candidate_id in cluster.representative_ids if candidate_id in candidates),
            None,
        )
        engagement_total = sum(
            _headline_engagement(candidates[candidate_id])
            for candidate_id in cluster.candidate_ids
            if candidate_id in candidates
        )
        exported = {
            "title": cluster.title,
            "summary": _agent_summary(representative) if representative else "",
            "sources": list(cluster.sources),
            "engagement_total": (
                int(engagement_total) if engagement_total.is_integer() else engagement_total
            ),
        }
        cluster_rows.append((engagement_total, len(cluster.candidate_ids), exported, cluster.cluster_id))

    cluster_rows.sort(key=lambda row: (row[0], row[1]), reverse=True)
    exported_clusters = [row[2] for row in cluster_rows]
    cluster_by_id = {row[3]: index for index, row in enumerate(cluster_rows)}
    for cluster in report.clusters:
        new_index = cluster_by_id.get(cluster.cluster_id)
        if new_index is None:
            continue
        for candidate_id in cluster.candidate_ids:
            cluster_by_candidate.setdefault(candidate_id, new_index)

    results: list[dict[str, Any]] = []"""

    text = _replace_once(text, old_block, new_block, "agent export sort")
    schema_path.write_text(text, encoding="utf-8")
    print(f"[patch-last30days-clustering] patched {schema_path}")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    skill_root = root / "integrations" / "last30days-skill" / "skills" / "last30days" / "scripts" / "lib"
    cluster_path = skill_root / "cluster.py"
    schema_path = skill_root / "schema.py"
    if not cluster_path.is_file() or not schema_path.is_file():
        print("[patch-last30days-clustering] skip — vendored skill not present", file=sys.stderr)
        return 0
    patch_cluster_py(cluster_path)
    patch_schema_py(schema_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
