#!/bin/sh
# Measure the off-recipe surrogate dataset on the hosted instance (scripts/surrogate-offrecipe-dataset.ts): the release's
# compiled code, the service user and environment (engine containers, sandbox), a hardened transient unit limited to two
# CPUs so the workbench keeps serving. Resumable; never resubmits a failed point unless PAI_SEND_REMEASURE=failed.
#
#   PAI_SEND_DATASET=fea-bracket-offrecipe-v1 [PAI_SEND_LIMIT=N] [PAI_SEND_REMEASURE=failed] [PAI_SEND_ACTION=start|status] \
#     python3 tools/aws_operator.py send --script tools/hosted_offrecipe_dataset.sh
set -e
DATASET="${DATASET:?}"; ACTION="${ACTION:-start}"
case "$DATASET" in *[!a-z0-9-]*) echo "bad dataset id" >&2; exit 2;; esac
case "${LIMIT:-}" in *[!0-9]*) echo "bad limit" >&2; exit 2;; esac
case "${REMEASURE:-}" in ""|failed) ;; *) echo "REMEASURE may only be 'failed'" >&2; exit 2;; esac
REL=$(readlink -f /opt/pai/current); OUT=/var/lib/pai/data/state/surrogate/datasets/$DATASET; UNIT=pai-surrogate-$DATASET
JOB=/var/lib/pai/data/state/surrogate/jobs/$DATASET
if [ "$ACTION" = status ]; then
  systemctl is-active "$UNIT" 2>/dev/null || true
  [ -d "$OUT/points" ] && echo "rows: $(ls "$OUT"/points/*/row.json 2>/dev/null | wc -l) measured: $(grep -l '"status": "measured"' "$OUT"/points/*/row.json 2>/dev/null | wc -l)"
  [ -f "$OUT/manifest.json" ] && /usr/bin/python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(json.dumps({k:m[k] for k in ("id","planned","attempted","measured","failed","rowsSha256")}))' "$OUT/manifest.json"
  journalctl -u "$UNIT" --no-pager -n 3 -o cat 2>/dev/null | cut -c1-200
  exit 0
fi
[ -f "$REL/native/surrogate-datasets/$DATASET.json" ] || { echo "no spec $DATASET in the release" >&2; exit 2; }
if systemctl is-active --quiet "$UNIT"; then echo "$UNIT is already running"; exit 0; fi
install -d -o pai -g pai -m 0700 /var/lib/pai/data/state/surrogate /var/lib/pai/data/state/surrogate/datasets /var/lib/pai/data/state/surrogate/jobs "$OUT" "$JOB"
# The script imports the compiled release (dist/src), as tools/hosted_e2e.sh does.
sed -e "s#\.\./src/\([a-z/-]*\)\.js#$REL/dist/src/\1.js#g" "$REL/scripts/surrogate-offrecipe-dataset.ts" > "$JOB/job.ts"; chown pai "$JOB/job.ts"
NODE=$(systemctl show pai-workbench -p ExecStart | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)
systemctl reset-failed "$UNIT" 2>/dev/null || true
systemd-run --unit "$UNIT" --description "PAI off-recipe surrogate dataset $DATASET" -p User=pai -p Group=pai -p NoNewPrivileges=true -p ProtectSystem=strict \
  -p ProtectHome=true -p PrivateTmp=true -p ReadWritePaths=/var/lib/pai/data -p CPUQuota=200% -p Nice=10 -p EnvironmentFile=/etc/pai/runtime.env -p WorkingDirectory="$REL" \
  "$NODE" --env-file-if-exists="$REL/.state/demo.env" "$JOB/job.ts" "$REL/native/surrogate-datasets/$DATASET.json" "$OUT" --concurrency 2 ${LIMIT:+--limit "$LIMIT"} ${REMEASURE:+--remeasure-failed}
echo "started $UNIT (output $OUT)"
