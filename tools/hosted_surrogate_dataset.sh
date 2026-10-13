#!/bin/sh
# Measure a surrogate dataset on the hosted instance (native/surrogate_dataset.py): the service user, the release's
# native scripts, the instance role's existing Batch/S3 jobs/* permissions. Runs as a hardened transient systemd unit so
# it outlives the SSM command; resumable (a rerun skips verified points, never resubmits a failed one by itself).
#
#   PAI_SEND_DATASET=fea-bracket-v1 [PAI_SEND_LIMIT=4] [PAI_SEND_REMEASURE=failed] [PAI_SEND_ACTION=start|status] python3 tools/aws_operator.py send --script tools/hosted_surrogate_dataset.sh
set -e
DATASET="${DATASET:?}"; ACTION="${ACTION:-start}"
case "$DATASET" in *[!a-z0-9-]*) echo "bad dataset id" >&2; exit 2;; esac
case "${LIMIT:-}" in *[!0-9]*) echo "bad limit" >&2; exit 2;; esac
case "${REMEASURE:-}" in ""|failed) ;; *) echo "REMEASURE may only be 'failed'" >&2; exit 2;; esac
REL=$(readlink -f /opt/pai/current); OUT=/var/lib/pai/data/state/surrogate/datasets/$DATASET; UNIT=pai-surrogate-$DATASET
PY=/var/lib/pai/data/state/tools/physics-1/bin/python
if [ "$ACTION" = status ]; then
  systemctl is-active "$UNIT" 2>/dev/null || true
  [ -d "$OUT/points" ] && echo "rows: $(ls "$OUT"/points/*/row.json 2>/dev/null | wc -l) measured: $(grep -l '"status": "measured"' "$OUT"/points/*/row.json 2>/dev/null | wc -l)"
  [ -f "$OUT/manifest.json" ] && /usr/bin/python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(json.dumps({k:m[k] for k in ("id","planned","attempted","measured","failed","rowsSha256","seconds")}))' "$OUT/manifest.json"
  journalctl -u "$UNIT" --no-pager -n 3 -o cat 2>/dev/null | cut -c1-200
  exit 0
fi
[ -f "$REL/native/surrogate-datasets/$DATASET.json" ] || { echo "no spec $DATASET in the release" >&2; exit 2; }
if systemctl is-active --quiet "$UNIT"; then echo "$UNIT is already running"; exit 0; fi
install -d -o pai -g pai -m 0700 /var/lib/pai/data/state/surrogate /var/lib/pai/data/state/surrogate/datasets "$OUT"
systemctl reset-failed "$UNIT" 2>/dev/null || true
systemd-run --unit "$UNIT" --description "PAI surrogate dataset $DATASET" -p User=pai -p Group=pai -p NoNewPrivileges=true -p ProtectSystem=strict \
  -p ProtectHome=true -p PrivateTmp=true -p ReadWritePaths=/var/lib/pai/data -p EnvironmentFile=/etc/pai/runtime.env -p WorkingDirectory="$REL" \
  "$PY" -I "$REL/native/surrogate_dataset.py" --spec "$REL/native/surrogate-datasets/$DATASET.json" --output "$OUT" --concurrency 12 ${LIMIT:+--limit "$LIMIT"} ${REMEASURE:+--remeasure-failed}
echo "started $UNIT (output $OUT)"
