# Local Langfuse trace retention — TODO (later)

**Status:** backlog — not scheduled. Captured 2026-07-21 from architecture discussion.

**Goal:** Customer boxes keep Langfuse-shaped traces **on the box** (≈7 days) and never ship
sensitive prompts/tool I/O to Langfuse Cloud by default. For troubleshooting, the customer
can **opt in** to export a timestamped bundle that we re-ingest into a private Langfuse
project (or lab self-hosted Langfuse).

Related today: [`hermes-integration.md`](hermes-integration.md) (Langfuse observability),
Joshu Node exporter [`src/observability/langfuse.ts`](../src/observability/langfuse.ts),
CP defaults in `joshu-control-plane` `sandboxEnv.ts`.

## Verdict

- **Do** local ring-buffer + opt-in export + operator OTLP re-ingest.
- **Do not** run full self-hosted Langfuse on every customer box (Postgres + ClickHouse +
  Redis + blob + web + worker is too heavy for VPS sandboxes).
- **Do not** keep fleet boxes shipping to Langfuse Cloud by default.

Today fleet sandboxes get `HERMES_LANGFUSE_*` from the control plane and send mail snippets,
chat, tool I/O, Day 0 / share-chat evidence to cloud. Tracing is fail-open when keys are
absent, but provisioned boxes currently opt *in* via CP `DEFAULT_HERMES_LANGFUSE_*`.

`HERMES_LANGFUSE_BASE_URL` *can* point at a self-hosted instance — reserve that for **our**
support/lab environment, not customer boxes.

## Recommended model

```text
Hermes plugin ──┐
                ├──► local OTLP/JSONL ring (7d + size cap)  ──(opt-in export)──► zip
Joshu Node OTEL─┘                                                              │
                                                                               ▼
                                                    operator re-ingest → private Langfuse
```

1. **Default: no cloud egress** — omit/clear `HERMES_LANGFUSE_*` on customer provisions.
2. **Always-on local capture** — same payload shape as Langfuse (inputs, outputs, tools,
   metadata, timestamps, userId/session) on disk.
3. **Support export** — e.g. `joshu support-traces --from … --to …` → zip + manifest
   (box slug, time range, schema version). Clear PII warning.
4. **Operator ingest** — replay into a private support Langfuse project via OTLP
   (`/api/public/otel/v1/traces`). Langfuse data-migration cookbook shows this pattern.

## Design defaults

| Choice | Default | Rationale |
|--------|---------|-----------|
| Audience | Fleet first; OSS buffer later | Fleet is where cloud keys are injected |
| On-box UI | None in v1 | Export + our Langfuse UI; avoid ClickHouse |
| Retention | 7 days + max disk (e.g. 500MB–2GB) | Size cap prevents disk fill |
| Dual-write to cloud | Off for customers; optional for internal boxes | Skill-evolution / learning-loop on boxes we own |
| Consent | Explicit export; no auto-upload | Customer chooses what leaves the box |

## Implementation checklist (when we build it)

- [ ] **CP defaults:** Stop injecting cloud Langfuse keys for customer provisions; keep for
      internal / skill-evolution hosts only.
- [ ] **Local OTLP sink:** Thin HTTP collector on the box writing append-only JSONL
      (preferred over dual file exporters beside Hermes + Joshu).
- [ ] **Point exporters:** Hermes `observability/langfuse` + Joshu Node
      `src/observability/langfuse.ts` → `http://127.0.0.1:…/v1/traces` on customer boxes.
- [ ] **Store:** e.g. `/var/lib/joshu/traces/`, day-rotated; prune >7d / over size on
      cron or boot.
- [ ] **Export CLI** (or Aroz settings action): timestamp (+ optional session) filter,
      zip + checksum, PII warning.
- [ ] **Operator ingest script:** JSONL → OTLP into private support project; tag with
      box-slug + ticket id.
- [ ] **Docs:** Privacy default + support workflow in `joshu/docs/` and CP provisioning notes.

Capture approach **A (preferred):** one local OTLP sink both exporters already speak.
**B:** file exporter beside each SDK (more dual-maintenance).

## Partial substitute today

Hermes `logs/session_{id}.json` helps some debugging but is **not** Langfuse-equivalent
(no unified Day 0 / classifier / share-chat observations, weaker UI). Backup signal only.

## Risks / caveats

- Traces remain sensitive **at rest on the box** — restrict perms; warn on export.
- Re-ingest may not preserve exact Langfuse UI IDs — fine for support, not cloud continuity.
- Skill-evolution / fleet analytics that assume cloud Langfuse need an explicit alternate
  (internal boxes only, or sample/opt-in).

## First build slice

Fleet default-off cloud + local OTLP JSONL buffer + export CLI + operator ingest script.
Decide later whether an on-box viewer is worth it.
