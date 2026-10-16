#!/bin/sh
# Featurize and train the structural surrogate on a measured dataset, on the hosted instance (native/surrogate_featurize.py,
# native/surrogate_train.py). A hardened transient unit limited to two CPUs, so the workbench keeps serving meanwhile.
#
#   PAI_SEND_DATASET=fea-bracket-v1 [PAI_SEND_ACTION=start|status|domain] python3 tools/aws_operator.py send --script tools/hosted_surrogate_train.sh
# ACTION=domain fits only the applicability-domain detector (domain-2) of the trained model, on its own features.
set -e
DATASET="${DATASET:?}"; ACTION="${ACTION:-start}"
case "$DATASET" in *[!a-z0-9-]*) echo "bad dataset id" >&2; exit 2;; esac
REL=$(readlink -f /opt/pai/current); D=/var/lib/pai/data/state/surrogate/datasets/$DATASET; M=/var/lib/pai/data/state/surrogate/models/$DATASET; UNIT=pai-surrogate-train-$DATASET
T=/var/lib/pai/data/state/tools
if [ "$ACTION" = status ]; then
  systemctl is-active "$UNIT" 2>/dev/null || true
  [ -f "$M/domain-2.json" ] && /usr/bin/python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ("trainRows","datasets","mahalanobisThreshold","embeddingThresholds","weightsSha256")}))' "$M/domain-2.json"
  [ -f "$M/benchmark.json" ] && /usr/bin/python3 -c 'import json,sys;b=json.load(open(sys.argv[1]));print(json.dumps({k:b[k] for k in ("train","heldOut","weightsSha256","inferenceMs","trainSeconds","selection","surrogate","gpBaseline","coverage2Sigma")}))' "$M/benchmark.json"
  journalctl -u "$UNIT" --no-pager -n 4 -o cat 2>/dev/null | cut -c1-300
  exit 0
fi
# A model spec (native/surrogate-models/<id>.json) trains on several datasets; otherwise DATASET is one dataset.
SPEC="$REL/native/surrogate-models/$DATASET.json"
if [ -f "$SPEC" ]; then SOURCES=$(/usr/bin/python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1]))["datasets"]))' "$SPEC"); WHAT="--spec $SPEC"
else SOURCES="$DATASET"; WHAT="--dataset $DATASET"; fi
for s in $SOURCES; do [ -f "/var/lib/pai/data/state/surrogate/datasets/$s/manifest.json" ] || { echo "dataset $s has no manifest yet" >&2; exit 2; }; done
if systemctl is-active --quiet "$UNIT"; then echo "$UNIT is already running"; exit 0; fi
install -d -o pai -g pai -m 0700 /var/lib/pai/data/state/surrogate /var/lib/pai/data/state/surrogate/models "$M"; systemctl reset-failed "$UNIT" 2>/dev/null || true
systemd-run --unit "$UNIT" --description "PAI surrogate training $DATASET" -p User=pai -p Group=pai -p NoNewPrivileges=true -p ProtectSystem=strict \
  -p ProtectHome=true -p PrivateTmp=true -p ReadWritePaths=/var/lib/pai/data -p CPUQuota=200% -p Nice=10 -p WorkingDirectory="$REL" \
  "$T/physics-1/bin/python" -I "$REL/native/surrogate_build_model.py" $WHAT $( [ "$ACTION" = domain ] && echo --domain-only ) --datasets /var/lib/pai/data/state/surrogate/datasets --output "$M" --cadquery "$T/cadquery-2.8.0/bin/python"
echo "started $UNIT (output $M)"
