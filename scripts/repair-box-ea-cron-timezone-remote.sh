#!/usr/bin/env bash
# Repair EA cron timezone on a single fleet box (run via ssh on the host).
# Reads owner IANA tz from Nylas profile, sets Hermes config + .env,
# restarts gateway, recalculates EA cron next_run_at with evening safety guard.
set -euo pipefail

slug="${1:?usage: repair-box-ea-cron-timezone-remote.sh <slug>}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "root@${slug}.box.joshu.me" bash -s <<'REMOTE'
set -euo pipefail
C=$(docker ps --format '{{.Names}}' | grep joshu-stack | head -1)
if [ -z "$C" ]; then echo "ERROR: no joshu-stack container"; exit 1; fi

docker exec "$C" bash -lc '
set -euo pipefail

PROF=$(find /var/lib/arozos/files/users -path "*/.joshu/nylas/profile.json" 2>/dev/null | head -1)
if [ -z "$PROF" ] || [ ! -f "$PROF" ]; then
  echo "ERROR: no Nylas profile.json"
  exit 1
fi

read -r OWNER_TZ WH_START WH_END <<< "$(python3 -c "
import json, sys
p = json.load(open(sys.argv[1]))
tz = (p.get(\"timezone\") or \"\").strip()
if not tz:
    sys.exit(2)
print(tz, p.get(\"workingHoursStart\") or \"\", p.get(\"workingHoursEnd\") or \"\")
" "$PROF")" || { echo "ERROR: profile missing timezone"; exit 1; }

echo "Owner timezone: $OWNER_TZ (hours ${WH_START:-?}-${WH_END:-?})"

python3 <<PY
import json, os, re, sys
from pathlib import Path

tz = """$OWNER_TZ"""
cfg = Path("/root/.hermes/config.yaml")
text = cfg.read_text()
if re.search(r"^timezone:", text, re.M):
    text = re.sub(r"^timezone:.*$", f"timezone: {tz}", text, count=1, flags=re.M)
else:
    text = text.rstrip() + f"\ntimezone: {tz}\n"
cfg.write_text(text)

env = Path("/root/.hermes/.env")
lines = env.read_text().splitlines() if env.exists() else []
key = "HERMES_TIMEZONE"
val = tz
found = False
for i, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[i] = f"{key}={val}"
        found = True
        break
if not found:
    lines.append(f"{key}={val}")
env.write_text("\n".join(lines).rstrip() + "\n")
print("config.yaml + .env updated")
PY

# Restart gateway via Joshu API (pick up HERMES_TIMEZONE + clear stale process state)
curl -fsS -X POST http://127.0.0.1:8788/joshu/api/safety-settings/restart-gateway \
  -H "Content-Type: application/json" -d "{}" >/dev/null
echo "gateway restarted"
sleep 8

/opt/hermes-agent/venv/bin/python3 <<PY
import json, os, sys
from datetime import datetime, timedelta
from pathlib import Path

os.environ["HERMES_TIMEZONE"] = """$OWNER_TZ"""
sys.path.insert(0, "/opt/hermes-agent")
from cron.jobs import compute_next_run, load_jobs, save_jobs
from hermes_time import now as hermes_now

now = hermes_now()
print(f"Hermes now: {now.isoformat()}")

jobs = load_jobs()
if not jobs:
    print("WARN: no cron jobs")
    sys.exit(0)

# Repair nested jobs.json if a prior bad save nested jobs twice
path = Path("/root/.hermes/cron/jobs.json")
raw = json.loads(path.read_text())
if isinstance(raw.get("jobs"), dict) and "jobs" in raw["jobs"]:
    jobs = raw["jobs"]["jobs"]

EVENING_MIN_LEAD = timedelta(hours=2)
changed = False

for job in jobs:
    name = job.get("name", "")
    if not name.startswith("EA "):
        continue
    sched = job.get("schedule")
    if not sched:
        continue

    last = job.get("last_run_at")
    next_run = compute_next_run(sched, last_run_at=last)
    if not next_run:
        print(f"  {name}: no next_run")
        continue

    next_dt = datetime.fromisoformat(next_run)
    if next_dt.tzinfo is None:
        next_dt = next_dt.replace(tzinfo=now.tzinfo)

    if next_dt <= now:
        next_run = compute_next_run(sched, last_run_at=now.isoformat())
        next_dt = datetime.fromisoformat(next_run)
        if next_dt.tzinfo is None:
            next_dt = next_dt.replace(tzinfo=now.tzinfo)
        print(f"  {name}: advanced past slot")

    if name == "EA evening":
        lead = next_dt - now
        if lead < EVENING_MIN_LEAD:
            next_run = compute_next_run(sched, last_run_at=next_dt.isoformat())
            next_dt = datetime.fromisoformat(next_run)
            if next_dt.tzinfo is None:
                next_dt = next_dt.replace(tzinfo=now.tzinfo)
            print(f"  {name}: evening bumped (lead was {lead})")

    job["next_run_at"] = next_run
    changed = True
    hrs = (next_dt - now).total_seconds() / 3600
    print(f"  {name}: next={next_run} ({hrs:.1f}h)")

if changed:
    save_jobs(jobs)
    print("jobs.json saved")
PY

echo "--- cron list ---"
/opt/hermes-agent/venv/bin/hermes cron list 2>&1 | grep -E "Name:|Next run:|Schedule:" || true
'
REMOTE

echo "OK: $slug"
