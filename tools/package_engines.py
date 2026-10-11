"""Stage the build context of the engine images (engines/Dockerfile.<engine>, ADR 0004) under .state/deploy/engine-context.

Each image is tagged `engine-<name>-<16 hex>` from the digest of its Dockerfile and exactly the files it COPYs (read
from the Dockerfile itself, the one source). Native scripts are not image inputs: they are mounted from the release at
run time, so a script change rebuilds nothing. Tags are immutable in ECR; an existing tag is never rebuilt.
"""
import hashlib
import json
import re
import shutil
from pathlib import Path

ENGINES = ("cad", "physics", "blender", "robots", "newton", "logistics", "decider")
root = Path(__file__).resolve().parent.parent
out = root / ".state/deploy/engine-context"


def inputs(dockerfile: Path) -> list[str]:
    files = []
    for line in dockerfile.read_text().splitlines():
        if line.startswith("COPY "):
            files += [f for f in line.split()[1:-1] if not f.startswith("--")]
    return sorted(set(files))


def stage() -> dict:
    shutil.rmtree(out, ignore_errors=True)
    tags, staged = {}, set()
    for engine in ENGINES:
        dockerfile = root / "engines" / f"Dockerfile.{engine}"
        h = hashlib.sha256(dockerfile.read_bytes())
        for f in inputs(dockerfile):
            if not (root / f).is_file():
                raise SystemExit(f"{dockerfile.name} copies a missing file: {f}")
            h.update(f.encode()); h.update(hashlib.sha256((root / f).read_bytes()).digest())
            staged.add(f)
        tags[engine] = f"engine-{engine}-{h.hexdigest()[:16]}"
        staged.add(f"engines/Dockerfile.{engine}")
    for f in sorted(staged):
        (out / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / f, out / f); (out / f).chmod(0o644)
    (out / "engine-tags.json").write_text(json.dumps(tags, indent=1) + "\n")
    return {"context": str(out.relative_to(root)), "files": len(staged), "tags": tags}


if __name__ == "__main__":
    print(json.dumps(stage()))
