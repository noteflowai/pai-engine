"""Featurize the datasets of a surrogate model spec and train on them (operator entry point; the hosted unit runs it).

    <physics python> -I surrogate_build_model.py --spec native/surrogate-models/<id>.json --datasets DIR --output DIR --cadquery <cadquery python>
    <physics python> -I surrogate_build_model.py --dataset <id> --datasets DIR --output DIR --cadquery <cadquery python>

The first dataset is the primary one (recipe parameters, GP baseline, historical split); the others are trained on
together and benchmarked separately (native/surrogate_train.py --extra-features).
"""
import argparse, json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--spec"); ap.add_argument("--dataset"); ap.add_argument("--datasets", required=True); ap.add_argument("--output", required=True)
ap.add_argument("--cadquery", required=True)
a = ap.parse_args()
ids = json.loads(Path(a.spec).read_text())["datasets"] if a.spec else [a.dataset]
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
feats = []
for d in ids:
    f = out / f"features-{d}.npz"
    subprocess.run([a.cadquery, "-I", "-W", "ignore", str(HERE / "surrogate_featurize.py"), "--dataset", str(Path(a.datasets) / d), "--output", str(f)], check=True)
    feats.append(f)
cmd = [sys.executable, "-I", str(HERE / "surrogate_train.py"), "train", "--features", str(feats[0]), "--output", str(out)]
for f in feats[1:]:
    cmd += ["--extra-features", str(f)]
subprocess.run(cmd, check=True)
