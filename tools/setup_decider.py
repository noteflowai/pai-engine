"""Install the pinned Strands Decider runtime and model into persistent state (hosted: data volume).

- strands-decider 0.1.0 with its CUDA extra into its own venv `decider-1`, from the hash-locked
  native/decider-requirements.txt (wheels only, no dependency resolution at install time).
- The decider adapter and its base model at the revisions pinned in tools/runtime-pins.json, downloaded once into
  `decider-hf`; the service then runs with HF_HUB_OFFLINE=1 and never fetches again.
- Writes nothing outside PAI_TOOLS_DIR (or .state/tools). Running the service is infra/update_release.sh's job.
- PAI_DECIDER_RUNTIME_ONLY=1 (engine image build, ADR 0004): the runtime only; the model stays on the data volume
  and is mounted into the container, so model bytes are never baked into an image.
"""
from pathlib import Path
import hashlib, json, os, subprocess, sys

root = Path(__file__).resolve().parents[1]
pin = json.loads((root / "tools/runtime-pins.json").read_text())["strandsDecider"]
lock = root / "native/decider-requirements.txt"
tools = Path(os.environ["PAI_TOOLS_DIR"]).resolve() if os.environ.get("PAI_TOOLS_DIR") else (root / ".state").resolve() / "tools"
venv, hf = tools / "decider-1", tools / "decider-hf"
if sys.version_info[:2] < (3, 12):
    raise SystemExit("strands-decider needs Python 3.12 or newer")
if not (venv / "bin/pip").exists():
    subprocess.run([sys.executable, "-m", "venv", "--clear", str(venv)], check=True)
python = venv / "bin/python"
subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input", "--no-cache-dir",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(lock)], check=True)
runtime_only = os.environ.get("PAI_DECIDER_RUNTIME_ONLY") == "1"
env = {**os.environ, "HF_HOME": str(hf), "HF_HUB_DISABLE_TELEMETRY": "1"}
fetch = ("import sys; from huggingface_hub import snapshot_download as d;"
         "print(d(sys.argv[1], revision=sys.argv[2])); print(d(sys.argv[3], revision=sys.argv[4]))")
paths = [] if runtime_only else subprocess.run([str(python), "-c", fetch, pin["model"], pin["modelRevision"], pin["base"], pin["baseRevision"]],
                       env=env, check=True, capture_output=True, text=True).stdout.split()
if not runtime_only and len(paths) != 2:
    raise SystemExit("model download did not return both pinned snapshots")
for p, rev in zip(paths, [pin["modelRevision"], pin["baseRevision"]]):
    if not p.endswith(rev):
        raise SystemExit(f"downloaded snapshot {p} is not the pinned revision {rev}")
    # The server resolves "main" offline: point it at the pinned commit (standard cache layout, refs/<name> = commit).
    refs = Path(p).parents[1] / "refs"
    refs.mkdir(exist_ok=True)
    (refs / "main").write_text(rev)
version = subprocess.run([str(python), "-c", "import importlib.metadata as m; print(m.version('strands-decider'))"], capture_output=True, text=True, check=True).stdout.strip()
if f"strands-decider=={version}" != pin["package"]:
    raise SystemExit(f"strands-decider {version} differs from the pin {pin['package']}")
receipt = {"schema": "pai-decider-install-1", "package": pin["package"], "model": pin["model"], "modelRevision": pin["modelRevision"],
           "base": pin["base"], "baseRevision": pin["baseRevision"], "venv": str(venv), "hfHome": str(hf),
           "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest()}
(tools / "decider-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
