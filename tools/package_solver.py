"""Stage the build context of the FEA solver image (Dockerfile.solver) under .state/deploy/solver-context.

Only the images' inputs are copied. Each image is tagged by the digest of its own Dockerfile and the files that
Dockerfile COPYs (read from the Dockerfile, the one source), written to image-tags.json; so an FEA script change
rebuilds only the FEA image and never re-pulls the OpenFOAM or FreeCAD bases.
"""
import hashlib
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / ".state/deploy/solver-context"
files = ["Dockerfile.solver", "Dockerfile.cfd", "Dockerfile.cam", "tools/setup_cam.py", "tools/runtime-pins.json", "native/cam-requirements.txt",
         "native/cam_part.py", "native/cam_verify.py", "native/cam_job.py", "native/dfm-shop.json", "native/cfd-job-requirements.txt",
         "native/cfd_job.py", "native/cfd_run.sh",
         *[f"native/{n}" for n in ("cad_point.py", "cad_recipe.py", "cad_bearing.py", "cad_checks.py", "fea_core.py", "fea_bracket.py", "fea_pillow.py", "solver_job.py")]]
shutil.rmtree(out, ignore_errors=True)
digest = hashlib.sha256()
for f in files:
    (out / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / f, out / f)
    (out / f).chmod(0o644)
    digest.update(f.encode()); digest.update(hashlib.sha256((root / f).read_bytes()).digest())
import re
import importlib.util
_spec = importlib.util.spec_from_file_location("package_engines", root / "tools/package_engines.py")
_mod = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_mod)
engines = _mod.stage()
tags = {}
for kind, dockerfile in (("fea", "Dockerfile.solver"), ("cfd", "Dockerfile.cfd"), ("cam", "Dockerfile.cam")):
    text = (root / dockerfile).read_text()
    inputs = sorted({f for line in text.splitlines() if line.startswith("COPY ") for f in line.split()[1:-1] if not f.startswith("--")})
    missing = [f for f in inputs if f not in files]
    if missing:
        raise SystemExit(f"{dockerfile} copies files that are not staged: {missing}")
    h = hashlib.sha256(text.encode())
    if kind == "fea":  # FROM the physics engine image: its tag is an input
        h.update(engines["tags"]["physics"].encode())
    for f in inputs:
        h.update(f.encode()); h.update(hashlib.sha256((root / f).read_bytes()).digest())
    tags[kind] = f"{kind}-{h.hexdigest()[:16]}"
(out / "image-tags.json").write_text(json.dumps(tags, indent=1) + "\n")
print(json.dumps({"context": str(out.relative_to(root)), "files": len(files), "contentSha256": digest.hexdigest(), "tags": tags}))
print(json.dumps(engines))
