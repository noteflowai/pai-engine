"""Surrogate training data: a space-filling design of a part family, every point measured by the native solvers.

    <physics python> -I surrogate_dataset.py --spec native/surrogate-datasets/<id>.json --output DIR [--concurrency 12] [--plan-only]

- The design is a scrambled Sobol sequence (seeded, so the plan is reproducible) over the family's design space
  (design_space.py), plus the reference design. Values are snapped to 0.01 mm like the optimiser's.
- Each point is one AWS Batch FEA job (the same job image, protocol and checks as cad_optimize.py): CadQuery builds the
  part, Gmsh meshes it, CalculiX solves the family's load case. Every downloaded file must match the job's digest and
  the job's tool versions must equal the pins, otherwise the point is recorded as failed. Nothing is resubmitted
  automatically; a rerun skips points that already have a verified row (resumable after an interruption).
- Output: points/<index>/{row.json, part.step, point.json, fea.json}, rows.jsonl (index order) and manifest.json
  (spec digest, counts, rows digest, script digests). Failed points stay in the data as failures; training uses
  measured rows only and the manifest says how many there are.
"""
import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from design_space import FAMILIES  # noqa: E402

PINS = {"gmsh": "4.15.2", "ccx": "2.21", "cadquery": "2.8.0"}
FILES = ("point.json", "fea.json", "part.step")
sha = lambda b: hashlib.sha256(b).hexdigest()


def plan(spec):
    """The reproducible design: reference first, then n scrambled-Sobol points, snapped to 0.01."""
    from scipy.stats import qmc
    fam = FAMILIES[spec["family"]]
    axes = list(fam["bounds"])
    lo = [fam["bounds"][k][0] for k in axes]; hi = [fam["bounds"][k][1] for k in axes]
    unit = qmc.Sobol(d=len(axes), scramble=True, seed=int(spec["design"]["seed"])).random(int(spec["design"]["n"]))
    pts = [dict(fam["reference"])] + [{k: round(float(v), 2) for k, v in zip(axes, row)} for row in qmc.scale(unit, lo, hi)]
    return [{**p, **fam["fixed"]} for p in pts]


def local_job(spec, folder, params):
    """The same job script on this machine (tests and development): solver_job.py --local, same outputs and checks."""
    import subprocess
    (folder / "input.json").write_text(json.dumps({"family": spec["family"], "parameters": params, "requirements": spec["requirements"], "structural": spec["structural"]}))
    r = subprocess.run([sys.executable, "-I", str(HERE / "solver_job.py"), "--local", str(folder)], capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"local job exited {r.returncode}: {(r.stderr.strip().splitlines() or [''])[-1][:200]}")
    result = json.loads((folder / "result.json").read_text())
    for name, digest in result.get("files", {}).items():
        if sha((folder / name).read_bytes()) != digest:
            raise RuntimeError(f"{name} differs from the job's digest")
    return result


def batch_job(spec, batch, folder, index, row):
    """The point as one AWS Batch FEA job; downloads and digest-checks its files."""
    import boto3
    s3, client = boto3.client("s3", region_name=batch["region"]), boto3.client("batch", region_name=batch["region"])
    prefix = f"jobs/surrogate-{spec['id']}/{index:04d}/"
    s3.put_object(Bucket=batch["bucket"], Key=prefix + "input.json", Body=json.dumps({"family": spec["family"], "parameters": row["parameters"],
        "requirements": spec["requirements"], "structural": spec["structural"]}).encode())
    job = client.submit_job(jobName=f"pai-surrogate-{spec['id']}-{index:04d}"[:128], jobQueue=batch["queue"], jobDefinition=batch["jobDefinition"],
                            containerOverrides={"command": ["--bucket", batch["bucket"], "--prefix", prefix]}, tags={"pai-run": f"surrogate-{spec['id']}"})
    row["jobId"] = job["jobId"]
    deadline = time.monotonic() + 1800
    while True:
        st = client.describe_jobs(jobs=[job["jobId"]])["jobs"][0]
        if st["status"] in ("SUCCEEDED", "FAILED"):
            break
        if time.monotonic() > deadline:
            raise RuntimeError(f"job still {st['status']} at the deadline; not resubmitted")
        time.sleep(10)
    if st["status"] != "SUCCEEDED":
        raise RuntimeError(f"job {st.get('statusReason', 'failed')[:160]}")
    result = json.loads(s3.get_object(Bucket=batch["bucket"], Key=prefix + "result.json")["Body"].read())
    for name, digest in result.get("files", {}).items():
        body = s3.get_object(Bucket=batch["bucket"], Key=prefix + name)["Body"].read()
        if sha(body) != digest:
            raise RuntimeError(f"{name} differs from the job's digest")
        (folder / name).write_bytes(body)
    return result


def measure(spec, batch, folder, index, params):
    """One native measurement (AWS Batch, or the local job when batch is None); returns the row (measured or failed)."""
    row = {"index": index, "parameters": params, "status": "failed"}
    started = time.monotonic()
    try:
        result = local_job(spec, folder, params) if batch is None else batch_job(spec, batch, folder, index, row)
        v = result.get("versions", {})
        if v.get("gmsh") != PINS["gmsh"] or PINS["ccx"] not in v.get("ccx", "") or v.get("cadquery") != PINS["cadquery"]:
            raise RuntimeError(f"solver versions {v} differ from the pins {PINS}")
        row.update({"image": result.get("image"), "versions": v, "files": result.get("files", {}), "jobSeconds": result.get("seconds")})
        if result.get("status") != "measured":
            raise RuntimeError(result.get("error", "the job reported a failed measurement"))
        geo, fea = json.loads((folder / "point.json").read_text()), json.loads((folder / "fea.json").read_text())
        checks = geo["checks"] + fea["checks"]
        get = lambda cid: next((c["observed"] for c in checks if c["id"] == cid), None)
        row.update({"status": "measured", "mass": geo["mass"], "deflectionMm": get("max-deflection"), "stressMPa": get("max-stress"),
                    "minWallMm": get("min-wall"), "boreDistortionMm": get("bore-distortion"), "elements": fea["meshes"]["fine"]["elements"],
                    "failed": [c["id"] for c in checks if not c["passed"]]})
    except Exception as e:  # noqa: BLE001 — a failed point is data, recorded with its reason
        row["error"] = f"{type(e).__name__}: {str(e)[:240]}"
    row["seconds"] = round(time.monotonic() - started, 1)
    (folder / "row.json").write_text(json.dumps(row, indent=1) + "\n")
    print(json.dumps({"index": index, "status": row["status"], "seconds": row["seconds"], **({"error": row["error"]} if "error" in row else {})}), flush=True)
    return row


def verified(folder):
    """An existing row counts only if its files still match their digests (a rerun never trusts a half-written point)."""
    try:
        row = json.loads((folder / "row.json").read_text())
        return row if all(sha((folder / n).read_bytes()) == d for n, d in row.get("files", {}).items()) else None
    except (OSError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True); ap.add_argument("--output", required=True)
    ap.add_argument("--concurrency", type=int, default=12); ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--backend", choices=["batch", "local"], default="batch", help="local: solver_job.py on this machine (tests)")
    ap.add_argument("--remeasure-failed", action="store_true", help="measure failed points again (an explicit operator decision after a fix; recorded in the manifest)")
    ap.add_argument("--limit", type=int, help="measure only the first N planned points (smoke run; the manifest records it)")
    a = ap.parse_args()
    spec_bytes = Path(a.spec).read_bytes(); spec = json.loads(spec_bytes)
    if spec.get("schema") != "pai-surrogate-dataset-spec-1" or spec["family"] not in FAMILIES:
        raise SystemExit("not a pai-surrogate-dataset-spec-1 for a known family")
    points = plan(spec)
    if a.plan_only:
        print(json.dumps({"id": spec["id"], "points": len(points), "planSha256": sha(json.dumps(points, sort_keys=True).encode()), "first": points[:3]}))
        return
    batch = None if a.backend == "local" else {"queue": os.environ["PAI_SOLVER_QUEUE"], "jobDefinition": os.environ["PAI_SOLVER_JOB_DEFINITION"],
             "bucket": os.environ["PAI_SOLVER_BUCKET"], "region": os.environ.get("PAI_SOLVER_REGION", "ap-northeast-1")}
    out = Path(a.output); (out / "points").mkdir(parents=True, exist_ok=True)
    (out / "spec.json").write_bytes(spec_bytes)
    started = time.time()

    remeasured = []

    def one(item):
        index, params = item
        folder = out / "points" / f"{index:04d}"; folder.mkdir(exist_ok=True)
        row = verified(folder)
        if row and row["status"] == "failed" and a.remeasure_failed:
            (folder / "row.json").rename(folder / f"row.failed-{int(time.time())}.json")  # the earlier failure is kept
            remeasured.append(index); row = None
        return row or measure(spec, batch, folder, index, params)
    with ThreadPoolExecutor(max_workers=max(1, min(a.concurrency, 16))) as pool:
        rows = list(pool.map(one, list(enumerate(points))[: a.limit or len(points)]))
    lines = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
    (out / "rows.jsonl").write_text(lines)
    measured = [r for r in rows if r["status"] == "measured"]
    manifest = {"schema": "pai-surrogate-dataset-1", "id": spec["id"], "family": spec["family"], "specSha256": sha(spec_bytes),
                "planSha256": sha(json.dumps(points, sort_keys=True).encode()), "planned": len(points), "attempted": len(rows), "measured": len(measured),
                "failed": len(rows) - len(measured), "rowsSha256": sha(lines.encode()),
                "images": sorted({r["image"] for r in measured if r.get("image")}), "versions": PINS,
                "scripts": {n: sha((HERE / n).read_bytes()) for n in ("surrogate_dataset.py", "design_space.py", "solver_job.py")},
                "remeasured": sorted(remeasured), "load": spec["structural"], "seconds": round(time.time() - started), "synthetic": True, "physicalValidation": False}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps({k: manifest[k] for k in ("id", "planned", "measured", "failed", "rowsSha256")}))


if __name__ == "__main__":
    main()
