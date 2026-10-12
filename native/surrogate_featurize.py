"""Geometry features for the structural surrogate: a part's B-Rep as a fixed-size surface point cloud with normals.

    <cadquery python> -I surrogate_featurize.py --dataset DIR --output features.npz      # every measured row of a dataset
    <cadquery python> -I surrogate_featurize.py --step part.step --output one.npz        # one part (prediction)

- The STEP is tessellated by OCCT (linear deflection 0.05 mm) and N surface points are sampled area-weighted, each
  with its facet's outward normal. The generator is seeded from the STEP's own digest, so the same part always gives
  the same cloud (training and prediction are reproducible, and a cloud identifies its part).
- Coordinates stay in the part's own frame in millimetres (the recipes build every part in one frame: mounting face,
  motor/bearing axis), scaled by 1/100: size matters for mass and stiffness, so nothing is normalised away.
- Five global descriptors, also from the tessellation only: surface area, enclosed volume, bounding-box extents.
- The model never sees the recipe parameters: only geometry. That is what makes it usable on parts without parameters
  (AI-written CadQuery code), and why it is benchmarked against a parameter-space Gaussian process.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

N_POINTS, DEFLECTION_MM, SCALE = 2048, 0.05, 0.01


def cloud(step: Path, n: int = N_POINTS):
    """(points (n, 6), globals (5,)): sampled surface with normals, and surface area, enclosed volume, extents (geometry only)."""
    import cadquery as cq
    digest = hashlib.sha256(step.read_bytes()).digest()
    shape = cq.importers.importStep(str(step)).val()
    verts, tris = shape.tessellate(DEFLECTION_MM, 0.2)
    v = np.array([[p.x, p.y, p.z] for p in verts], dtype=np.float64)
    t = np.array(tris, dtype=np.int64)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cross, axis=1)
    keep = area > 1e-12
    a, b, c, cross, area = a[keep], b[keep], c[keep], cross[keep], area[keep]
    normals = cross / np.linalg.norm(cross, axis=1, keepdims=True)
    # Enclosed volume by the divergence theorem over the closed, outward-oriented tessellation.
    volume = abs(float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)
    ext = v.max(0) - v.min(0)
    glob = np.array([area.sum() * 1e-4, volume * 1e-5, *(ext * SCALE)], dtype=np.float32)
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    pick = rng.choice(len(area), size=n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    pts = (1 - s)[:, None] * a[pick] + (s * (1 - r2))[:, None] * b[pick] + (s * r2)[:, None] * c[pick]
    return np.concatenate([pts * SCALE, normals[pick]], axis=1).astype(np.float32), glob


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset"); ap.add_argument("--step"); ap.add_argument("--output", required=True)
    a = ap.parse_args()
    if a.step:
        x, g = cloud(Path(a.step))
        np.savez_compressed(a.output, x=x[None], g=g[None], stepSha256=np.array([hashlib.sha256(Path(a.step).read_bytes()).hexdigest()]))
        print(json.dumps({"points": int(x.shape[0])}))
        return
    root = Path(a.dataset)
    manifest = json.loads((root / "manifest.json").read_text())
    rows = [json.loads(line) for line in (root / "rows.jsonl").read_text().splitlines()]
    if hashlib.sha256((root / "rows.jsonl").read_bytes()).hexdigest() != manifest["rowsSha256"]:
        raise SystemExit("rows.jsonl differs from the manifest")
    measured = [r for r in rows if r["status"] == "measured"]
    xs, gs, idx, steps = [], [], [], []
    for r in measured:
        step = root / "points" / f"{r['index']:04d}" / "part.step"
        digest = hashlib.sha256(step.read_bytes()).hexdigest()
        if digest != r["files"]["part.step"]:
            raise SystemExit(f"point {r['index']}: part.step differs from its row")
        x, g = cloud(step); xs.append(x); gs.append(g); idx.append(r["index"]); steps.append(digest)
    np.savez_compressed(a.output, x=np.stack(xs), g=np.stack(gs), index=np.array(idx), stepSha256=np.array(steps),
                        mass=np.array([r["mass"] for r in measured]), deflectionMm=np.array([r["deflectionMm"] for r in measured]),
                        stressMPa=np.array([r["stressMPa"] for r in measured]),
                        parameters=np.array([[r["parameters"][k] for k in sorted(r["parameters"])] for r in measured]),
                        parameterNames=np.array(sorted(measured[0]["parameters"])), rowsSha256=np.array([manifest["rowsSha256"]]))
    print(json.dumps({"rows": len(measured), "points": N_POINTS, "rowsSha256": manifest["rowsSha256"]}))


if __name__ == "__main__":
    main()
