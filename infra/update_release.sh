#!/bin/bash
# Invoke through the scoped SSM operator after CDK has granted the new asset.
set -euo pipefail
: "${PAI_RELEASE_HASH:?}"
: "${PAI_ASSET_BUCKET:?}"
: "${PAI_ASSET_KEY:?}"
RELEASE="/opt/pai/releases/$PAI_RELEASE_HASH"
# Data volume grown in the stack (EBS grows online): grow the filesystem to match; no-op when already full size.
DATA_DEV=$(findmnt -n -o SOURCE /var/lib/pai/data)
case "$(findmnt -n -o FSTYPE /var/lib/pai/data)" in ext4) resize2fs "$DATA_DEV" >/dev/null 2>&1 || true ;; xfs) xfs_growfs /var/lib/pai/data >/dev/null 2>&1 || true ;; esac
# Package builds unpack into TMPDIR; keep them on the data volume, not the small root disk.
PAI_TMP=/var/lib/pai/data/tmp
install -d -m 0700 -o pai -g pai "$PAI_TMP"
export PAI_RELEASE="$RELEASE"
python3 - <<'PY'
import boto3, hashlib, os, re, tarfile
from pathlib import Path
digest = os.environ["PAI_RELEASE_HASH"]
assert re.fullmatch("[a-f0-9]{64}", digest)
archive = Path("/tmp/pai-update-" + digest + ".tgz")
boto3.client("s3").download_file(os.environ["PAI_ASSET_BUCKET"], os.environ["PAI_ASSET_KEY"], str(archive))
assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
release = Path(os.environ["PAI_RELEASE"])
release.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive) as file:
    for member in file.getmembers():
        path = Path(member.name)
        assert not path.is_absolute() and ".." not in path.parts and ".state" not in path.parts
        assert member.isfile() or member.isdir()
    file.extractall(release, filter="data")
PY
if [ ! -e "$RELEASE/.state" ]; then ln -s /var/lib/pai/data/state "$RELEASE/.state"; fi
# demo.env is written through a release's .state symlink; paths that name a release directory break once that release
# is pruned (only the last 5 are kept). Point them at the persistent state they resolve to.
if [ -f /var/lib/pai/data/state/demo.env ]; then sed -i -E 's#/opt/pai/releases/[0-9a-f]{64}/\.state/#/var/lib/pai/data/state/#g' /var/lib/pai/data/state/demo.env; fi
chown -R pai:pai "$RELEASE"
cd "$RELEASE"
NODE_VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['node']['version'])" "$PAI_RELEASE/tools/runtime-pins.json")
NODE_BIN="/var/lib/pai/data/state/tools/node-v$NODE_VERSION-linux-x64/bin"
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm ci
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm prune --omit=dev
# Native parametric CAD: hash-locked CadQuery 2.8.0 / OCCT 7.9 in persistent state; idempotent. Fails before any switch.
if ! python3 -c "import ensurepip" 2>/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3.12-venv >/dev/null
fi
runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_cadquery.py
# Physics lane (Gmsh, CalculiX from the signed Ubuntu archive, Optuna, scikit-learn, MuJoCo); idempotent, no root needed.
DEBIAN_FRONTEND=noninteractive apt-get install -y -q libglu1-mesa libgl1 libopengl0 libxcursor1 libxft2 libxinerama1 libfontconfig1 libgomp1 libopenmpi3t64 >/dev/null
# BoTorch strategy (CPU PyTorch, hash-locked) and Newton USD conformance (CPU Warp) only when the operator opts in.
runuser -u pai -- env TMPDIR="$PAI_TMP" PAI_PHYSICS_BOTORCH="${PAI_PHYSICS_BOTORCH:-}" PAI_PHYSICS_NEWTON="${PAI_PHYSICS_NEWTON:-}" python3 tools/setup_physics.py
# Logistics planning artifact: hash-locked OR-Tools (wheels only); idempotent, no root needed.
runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_logistics.py
# Strands Decider on this host's GPU (opt-in PAI_DECIDER=1; ADR 0002). NVIDIA 580 open driver as precompiled, signed
# modules for the running AWS kernel; the hash-locked runtime and pinned model on the data volume; a loopback-only
# service. Without a working GPU the service is installed but not started, and the workbench fails closed (no suggestion).
if [ "${PAI_DECIDER:-}" = "1" ]; then
  if ! dpkg -s nvidia-headless-580-server-open >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "linux-modules-nvidia-580-server-open-$(uname -r)" nvidia-headless-580-server-open nvidia-utils-580-server >/dev/null
  fi
  runuser -u pai -- env TMPDIR="$PAI_TMP" PAI_TOOLS_DIR=/var/lib/pai/data/state/tools python3 tools/setup_decider.py
  MODEL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['strandsDecider']['model'])" "$RELEASE/tools/runtime-pins.json")
  cat > /etc/systemd/system/pai-decider.service <<UNIT
[Unit]
Description=PAI Strands Decider (suggestions only; loopback)
After=network-online.target
[Service]
User=pai
Group=pai
Environment=HF_HOME=/var/lib/pai/data/state/tools/decider-hf
Environment=HF_HUB_OFFLINE=1
Environment=HF_HUB_DISABLE_TELEMETRY=1
ExecStart=/var/lib/pai/data/state/tools/decider-1/bin/strands-decider serve $MODEL --host 127.0.0.1 --port 8801 --device cuda --model-name strands-decider-2B-qwen3.5-v1-2610
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pai/data/state/tools/decider-hf
PrivateTmp=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable pai-decider.service >/dev/null
  if nvidia-smi -L >/dev/null 2>&1; then systemctl restart pai-decider.service; else echo "No GPU visible yet; pai-decider.service enabled, starts on a GPU instance"; fi
  sed -i '/^PAI_DECIDER_URL=/d;/^PAI_DECIDER_MODEL=/d' /etc/pai/runtime.env
  printf 'PAI_DECIDER_URL=http://127.0.0.1:8801/v1/systemone\nPAI_DECIDER_MODEL=strands-decider-2B-qwen3.5-v1-2610\n' >> /etc/pai/runtime.env
fi
# Strands Robots cross-check (hash-locked, pinned Menagerie, simulation only) only when the operator opts in.
if [ "${PAI_ROBOTS:-}" = "1" ]; then runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_robots.py; fi
# OS sandbox for generated CAD code; without it the lane stays disabled (fail closed).
if ! command -v bwrap >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap >/dev/null; fi
# Ubuntu 24.04 restricts unprivileged user namespaces; grant them to bwrap only (per-application AppArmor profile).
if [ -d /sys/kernel/security/apparmor ] && [ -f "$RELEASE/infra/apparmor-bwrap" ]; then
  install -m 0644 "$RELEASE/infra/apparmor-bwrap" /etc/apparmor.d/pai-bwrap && apparmor_parser -r /etc/apparmor.d/pai-bwrap
fi
# Engine containers (ADR 0004; opt-in PAI_ENGINE_CONTAINERS=<engines>, images pinned by digest in PAI_ENGINE_IMAGES).
# Rootless podman as the service user with a single uid mapping (no setuid helpers, so the service keeps
# NoNewPrivileges); storage on the data volume; every run is a no-network, read-only, no-capability container.
if [ -n "${PAI_ENGINE_CONTAINERS:-}" ] && [ -n "${PAI_ENGINE_IMAGES:-}" ]; then
  dpkg -s podman crun conmon catatonit >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends podman crun conmon catatonit >/dev/null; }
  CT=/var/lib/pai/data/containers
  install -d -o pai -g pai -m 0700 "$CT" "$CT/storage" "$CT/run" "$CT/config"
  PODMAN="podman --root $CT/storage --runroot $CT/run --storage-driver overlay --storage-opt overlay.ignore_chown_errors=true --cgroup-manager cgroupfs --events-backend none --log-level error"
  ENVS="HOME=$CT XDG_CONFIG_HOME=$CT/config XDG_RUNTIME_DIR=$CT/run XDG_DATA_HOME=$CT"
  BOTO=$(for p in /var/lib/pai/data/state/tools/*/bin/python; do "$p" -c "import boto3" 2>/dev/null && echo "$p" && break; done)
  [ -n "$BOTO" ] || { echo "No Python with boto3 for the ECR login" >&2; exit 1; }
  REGISTRY=$(printf '%s' "$PAI_ENGINE_IMAGES" | python3 -c "import json,sys;print(sorted({v.split('/')[0] for v in json.load(sys.stdin).values()})[0])")
  # The ECR password goes through a pipe only (never a file or argv).
  "$BOTO" -c "import boto3,base64;a=boto3.client('ecr',region_name='$(printf '%s' "$REGISTRY" | cut -d. -f4)').get_authorization_token()['authorizationData'][0];print(base64.b64decode(a['authorizationToken']).decode().split(':',1)[1])" \
    | runuser -u pai -- env $ENVS $PODMAN login --username AWS --password-stdin "$REGISTRY" >/dev/null
  for ref in $(printf '%s' "$PAI_ENGINE_IMAGES" | python3 -c "import json,sys;print(' '.join(json.load(sys.stdin).values()))"); do
    case "$ref" in *@sha256:*) ;; *) echo "Engine image not pinned by digest: $ref" >&2; exit 1 ;; esac
    runuser -u pai -- env $ENVS $PODMAN image exists "$ref" || runuser -u pai -- env $ENVS $PODMAN pull -q "$ref" >/dev/null
  done
  runuser -u pai -- env $ENVS $PODMAN logout "$REGISTRY" >/dev/null 2>&1 || true
  # Images no longer referenced by this release are removed (by digest, so nothing in use is touched).
  for id in $(runuser -u pai -- env $ENVS $PODMAN images -q --no-trunc | sort -u); do
    used=$(runuser -u pai -- env $ENVS $PODMAN image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$id" | tr ' ' '\n' | grep -cxF -f <(printf '%s' "$PAI_ENGINE_IMAGES" | python3 -c "import json,sys;print('\n'.join(json.load(sys.stdin).values()))") || true)
    [ "$used" = "0" ] && runuser -u pai -- env $ENVS $PODMAN rmi -f "$id" >/dev/null 2>&1 || true
  done
  # GPU for engine containers: NVIDIA's nvidia-ctk (official signed repository, key fingerprint and version pinned in
  # tools/runtime-pins.json) generates the CDI spec, regenerated on every release so it follows driver updates.
  GPU=0
  if nvidia-smi -L >/dev/null 2>&1; then
    # OptiX for Blender Cycles: libnvoptix ships in the driver's GL libraries (Ubuntu archive), exactly the installed
    # driver version; the CDI spec generated below then mounts it into GPU containers.
    DRV=$(dpkg-query -W -f='${Version}' libnvidia-compute-580-server 2>/dev/null || true)
    if [ -n "$DRV" ] && [ "$(dpkg-query -W -f='${Version}' libnvidia-gl-580-server 2>/dev/null)" != "$DRV" ]; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "libnvidia-gl-580-server=$DRV" >/dev/null 2>&1 \
        || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "libnvidia-gl-580-server=$DRV" >/dev/null; }
    fi
    NV=$(python3 -c "import json;p=json.load(open('$RELEASE/tools/runtime-pins.json'))['nvidiaContainerToolkit'];print(p['package'],p['version'],p['repository'],p['keyUrl'],p['keyFingerprint'])")
    read -r NV_PKG NV_VER NV_REPO NV_KEY NV_FPR <<< "$NV"
    KEYRING=/usr/share/keyrings/nvidia-container-toolkit.gpg
    if [ "$(dpkg-query -W -f='${Version}' "$NV_PKG" 2>/dev/null)" != "$NV_VER" ]; then
      curl -fsSL "$NV_KEY" -o "$PAI_TMP/nv.key"
      [ "$(gpg --show-keys --with-colons "$PAI_TMP/nv.key" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')" = "$NV_FPR" ] || { echo "NVIDIA key fingerprint mismatch" >&2; exit 1; }
      gpg --dearmor < "$PAI_TMP/nv.key" > "$KEYRING.tmp" && mv "$KEYRING.tmp" "$KEYRING" && chmod 644 "$KEYRING" && rm -f "$PAI_TMP/nv.key"
      echo "deb [signed-by=$KEYRING] $NV_REPO /" > /etc/apt/sources.list.d/nvidia-container-toolkit.list
      apt-get update -qq -o Dir::Etc::sourcelist=sources.list.d/nvidia-container-toolkit.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$NV_PKG=$NV_VER" >/dev/null
    fi
    install -d -m 0755 /etc/cdi; rm -f /etc/cdi/nvidia.yaml
    nvidia-ctk cdi generate --format json --output="$PAI_TMP/nvidia-cdi.json" >/dev/null 2>&1
    # podman 4.9 reads CDI <= 0.6.0; only additionalGids (for /dev/dri, not applicable to a single-uid mapping) needs 0.7.0.
    python3 - "$PAI_TMP/nvidia-cdi.json" /etc/cdi/nvidia.json <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
for e in [d["containerEdits"] for d in s["devices"]] + [s.get("containerEdits", {})]:
    e.pop("additionalGids", None)
s["cdiVersion"] = "0.6.0"
json.dump(s, open(sys.argv[2], "w"), indent=1)
PY
    chmod 644 /etc/cdi/nvidia.json; rm -f "$PAI_TMP/nvidia-cdi.json"; GPU=1
  fi
  sed -i '/^PAI_ENGINE_CONTAINERS=/d;/^PAI_ENGINE_IMAGES=/d;/^PAI_ENGINE_TOOLS_DIR=/d;/^PAI_CONTAINERS_ROOT=/d;/^PAI_ENGINE_CONTAINER_CLI=/d;/^PAI_ENGINE_GPU=/d' /etc/pai/runtime.env
  case "$PAI_ENGINE_IMAGES" in *"'"*) echo "PAI_ENGINE_IMAGES must not contain single quotes" >&2; exit 1 ;; esac
  printf "PAI_ENGINE_CONTAINERS=%s\nPAI_ENGINE_IMAGES='%s'\nPAI_ENGINE_TOOLS_DIR=/var/lib/pai/data/state/tools\nPAI_CONTAINERS_ROOT=%s\nPAI_ENGINE_CONTAINER_CLI=podman\nPAI_ENGINE_GPU=%s\n" \
    "$PAI_ENGINE_CONTAINERS" "$PAI_ENGINE_IMAGES" "$CT" "$GPU" >> /etc/pai/runtime.env
fi
# Decider in its engine container (ADR 0004) when listed in PAI_ENGINE_CONTAINERS: same unit name, same loopback port,
# same offline model on the data volume (mounted); host network namespace so it can listen on 127.0.0.1 only.
case ",${PAI_ENGINE_CONTAINERS:-}," in *,decider,*)
  if [ "${PAI_DECIDER:-}" = "1" ] && [ "${GPU:-0}" = "1" ]; then
    DIMG=$(printf '%s' "$PAI_ENGINE_IMAGES" | python3 -c "import json,sys;print(json.load(sys.stdin)['decider'])")
    HFH=/var/lib/pai/data/state/tools/decider-hf
    cat > /etc/systemd/system/pai-decider.service <<UNIT
[Unit]
Description=PAI Strands Decider in its engine container (suggestions only; loopback)
After=network-online.target
[Service]
User=pai
Group=pai
Environment=HOME=$CT XDG_CONFIG_HOME=$CT/config XDG_RUNTIME_DIR=$CT/run XDG_DATA_HOME=$CT
ExecStart=/usr/bin/podman --root $CT/storage --runroot $CT/run --storage-driver overlay --storage-opt overlay.ignore_chown_errors=true --cgroup-manager cgroupfs --events-backend none --log-level error \
  run --rm --replace --name pai-decider --network host --cap-drop ALL --security-opt no-new-privileges --cgroups disabled --user 0:0 \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g --device nvidia.com/gpu=all -e HF_HOME=$HFH -v $HFH:$HFH:rw \
  --entrypoint /opt/pai/tools/decider-1/bin/strands-decider $DIMG serve $MODEL --host 127.0.0.1 --port 8801 --device cuda --model-name strands-decider-2B-qwen3.5-v1-2610
ExecStop=/usr/bin/podman --root $CT/storage --runroot $CT/run --storage-opt overlay.ignore_chown_errors=true --log-level error stop -t 10 pai-decider
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pai/data
PrivateTmp=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload && systemctl restart pai-decider.service
    # Ready once it answers HTTP at all (the model loads before the server listens).
    for i in $(seq 1 60); do [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8801/docs || true)" != "000" ] && break; sleep 3; done
    systemctl is-active pai-decider.service
  fi ;;
esac
# AI engine (pinned Kiro CLI + bounded executor); skipped only if the stack predates the AI resources.
if [ -n "${PAI_EXECUTOR_KEY:-}" ] && [ -n "${PAI_AI_KEYS_ARN:-}" ]; then
  bash "$RELEASE/infra/install_ai.sh"
fi
# Release seals: S3 Object Lock archive and RFC 3161 time-stamping authority (each optional).
for key in PAI_PACKAGE_ARCHIVE_BUCKET PAI_PACKAGE_RETENTION_DAYS PAI_TSA_URL PAI_SOLVER_QUEUE PAI_SOLVER_JOB_DEFINITION PAI_SOLVER_BUCKET PAI_SOLVER_REGION PAI_SOLVER_CFD_JOB_DEFINITION PAI_SOLVER_CAM_JOB_DEFINITION; do
  value="${!key:-}"
  if [ -n "$value" ]; then
    sed -i "/^${key}=/d" /etc/pai/runtime.env
    printf '%s=%s\n' "$key" "$value" >> /etc/pai/runtime.env
  fi
done
if [ -n "${PAI_SIGNING_KMS_KEY_ID:-}" ]; then
  sed -i '/^PAI_SIGNING_KMS_KEY_ID=/d' /etc/pai/runtime.env
  printf 'PAI_SIGNING_KMS_KEY_ID=%s\n' "$PAI_SIGNING_KMS_KEY_ID" >> /etc/pai/runtime.env
fi
# Machine-agent API settings come from stack outputs; keep the file's other lines unchanged.
# Invite-only tenants from the stack output (JSON; an empty list means none); validated again by the workbench at start.
if [ -n "${PAI_TENANTS+x}" ]; then
  # Single-quoted so both systemd EnvironmentFile and `. runtime.env` (hosted e2e) keep the JSON intact.
  case "$PAI_TENANTS" in *"'"*) echo "PAI_TENANTS must not contain single quotes" >&2; exit 1 ;; esac
  sed -i '/^PAI_TENANTS=/d' /etc/pai/runtime.env
  if [ -n "$PAI_TENANTS" ] && [ "$PAI_TENANTS" != "[]" ]; then printf "PAI_TENANTS='%s'\n" "$PAI_TENANTS" >> /etc/pai/runtime.env; fi
fi
if [ -n "${PAI_AGENT_USER_POOL_ID:-}" ] && [ -n "${PAI_AGENT_CLIENT_ID:-}" ]; then
  sed -i '/^PAI_AGENT_USER_POOL_ID=/d;/^PAI_AGENT_CLIENT_IDS=/d' /etc/pai/runtime.env
  printf 'PAI_AGENT_USER_POOL_ID=%s\nPAI_AGENT_CLIENT_IDS=%s\n' "$PAI_AGENT_USER_POOL_ID" "$PAI_AGENT_CLIENT_ID" >> /etc/pai/runtime.env
fi
# The service runs node from persistent state, never from a release directory (those are pruned below). bootstrap.sh is
# part of the instance's user data, so changing it would replace the instance; this drop-in fixes the unit instead.
DROPIN=/etc/systemd/system/pai-workbench.service.d/10-node-path.conf
WANT="[Service]
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=
ExecStart=$NODE_BIN/node --env-file-if-exists=.state/demo.env dist/src/server.js"
if [ "$(cat "$DROPIN" 2>/dev/null)" != "$WANT" ]; then
  install -d /etc/systemd/system/pai-workbench.service.d
  printf '%s\n' "$WANT" > "$DROPIN"
  systemctl daemon-reload
fi
PREVIOUS=$(readlink -f /opt/pai/current)
systemctl stop pai-workbench.service
ln -sfn "$RELEASE" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl start pai-workbench.service
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4317/healthz >/dev/null; then
    BUILD=$(python3 -c "import json,sys;b=json.load(open(sys.argv[1]));print('v%s commit %s' % (b['version'], b.get('sourceCommit') or 'unknown'))" "$RELEASE/.build-info.json" 2>/dev/null || echo "build info not recorded")
    # Keep the new release, the previous one and the 3 newest others; older copies only fill the root disk.
    KEEP="$(basename "$RELEASE") $(basename "$PREVIOUS") $(ls -1t /opt/pai/releases | head -5 | tr '\n' ' ')"
    for r in $(ls -1 /opt/pai/releases); do
      case " $KEEP " in *" $r "*) ;; *) [[ "$r" =~ ^[a-f0-9]{64}$ ]] && rm -rf -- "/opt/pai/releases/$r" ;; esac
    done
    echo "Verified new release $PAI_RELEASE_HASH ($BUILD); previous $PREVIOUS retained; no native replay."
    exit 0
  fi
  sleep 1
done
ln -sfn "$PREVIOUS" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl restart pai-workbench.service
echo "New release failed health; restored previous release without changing domain state." >&2
exit 1
