"""Structural surrogate: geometry (surface point cloud) -> max deflection, max von Mises stress, mass.

    <physics python> -I surrogate_train.py train --features features.npz --output DIR [--members 5] [--epochs 300]
    <physics python> -I surrogate_train.py predict --weights DIR/weights.pt --features one.npz

- Model: a PointNet regressor (shared per-point MLP, max + mean pooling, MLP head), trained as a deep ensemble; the
  ensemble spread is the predictive uncertainty. Targets: log deflection, log stress, mass (standardised).
- Split: a fixed, seeded 80/20 split of the measured rows; the held-out 20 % are never seen in training and are the
  benchmark. The reference design is always in training.
- Baseline: a Gaussian process on the recipe parameters (sklearn, Matern 5/2 + noise) on the same split. A geometry
  model that does not beat or match it is reported as such: its value is that it needs no parameters.
- Reproducible: CPU only, fixed seeds, deterministic algorithms, fixed thread count; weights carry their digest and the
  dataset digest. Predictions rank only; the native solver decides (the artifact enforces that, not this script).
"""
import argparse
import hashlib
import io
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

THREADS, SEED, ALPHA = 4, 20261012, 0.1
TARGETS = ("deflectionMm", "stressMPa", "mass")


# Candidate configurations, fixed before any data was seen; chosen by cross-validation inside the training rows only.
CONFIGS = {"pointnet": {"globals": False}, "pointnet+globals": {"globals": True}}


class PointNet(nn.Module):
    def __init__(self, globals_=False, width=128):
        super().__init__()
        self.globals_ = globals_
        self.point = nn.Sequential(nn.Linear(6, 64), nn.ReLU(), nn.Linear(64, width), nn.ReLU(), nn.Linear(width, 2 * width), nn.ReLU())
        self.head = nn.Sequential(nn.Linear(4 * width + (5 if globals_ else 0), width), nn.ReLU(), nn.Linear(width, 64), nn.ReLU(), nn.Linear(64, len(TARGETS)))

    def forward(self, x, g):  # x: (B, N, 6), g: (B, 5)
        h = self.point(x)
        feats = [h.max(dim=1).values, h.mean(dim=1)] + ([g] if self.globals_ else [])
        return self.head(torch.cat(feats, dim=1))


def setup():
    torch.set_num_threads(THREADS); torch.use_deterministic_algorithms(True)


def encode(y):  # (n, 3) physical -> model space
    return np.stack([np.log(y[:, 0]), np.log(y[:, 1]), y[:, 2]], axis=1)


def decode(z):
    return np.stack([np.exp(z[:, 0]), np.exp(z[:, 1]), z[:, 2]], axis=1)


def key(tag, i):
    """Row identity: the primary dataset keeps its historical key (its split is unchanged when datasets are added)."""
    return f"{i}" if tag == 0 else f"{TAGS[tag]}:{i}"


def split(index, tags=None):
    """Held-out = about 20 %, chosen by a seeded hash of the row key (stable when rows are added); never the reference."""
    tags = np.zeros(len(index), dtype=int) if tags is None else tags
    held = np.array([not (t == 0 and i == 0) and int(hashlib.sha256(f"{SEED}:{key(t, i)}".encode()).hexdigest(), 16) % 5 == 0 for i, t in zip(index, tags)])
    return ~held, held


TAGS = ["primary"]


def spearman(a, b):
    from scipy.stats import spearmanr
    return round(float(spearmanr(a, b).statistic), 4) if len(a) > 2 else None


def metrics(pred, true):
    out = {}
    for j, k in enumerate(TARGETS):
        rel = np.abs(pred[:, j] - true[:, j]) / np.abs(true[:, j])
        out[k] = {"spearman": spearman(pred[:, j], true[:, j]), "medianRelError": float(np.median(rel)), "p90RelError": float(np.quantile(rel, 0.9)),
                  "maxRelError": float(rel.max())}
    return out


def train(a):
    setup()
    f = np.load(a.features)
    # Extra datasets (e.g. off-recipe parts): trained on together, benchmarked per dataset; the GP baseline needs recipe
    # parameters and runs on the primary dataset only.
    extras = [np.load(e) for e in (a.extra_features or [])]
    TAGS[:] = [str(f["dataset"][0]) if "dataset" in f else "primary"] + [str(e["dataset"][0]) for e in extras]
    x = np.concatenate([f["x"], *[e["x"] for e in extras]]); index = np.concatenate([f["index"], *[e["index"] for e in extras]])
    G = np.concatenate([f["g"], *[e["g"] for e in extras]])
    tags = np.concatenate([np.zeros(len(f["index"]), dtype=int), *[np.full(len(e["index"]), j + 1) for j, e in enumerate(extras)]])
    y = np.stack([np.concatenate([f[k], *[e[k] for e in extras]]) for k in TARGETS], axis=1).astype(np.float64)
    tr, te = split(index, tags)
    if te.sum() < 1 or tr.sum() < 5:
        raise SystemExit(f"dataset too small for a held-out benchmark ({int(tr.sum())} train / {int(te.sum())} held-out rows)")
    z = encode(y); mu, sd = z[tr].mean(0), z[tr].std(0) + 1e-9
    zt = torch.tensor((z - mu) / sd, dtype=torch.float32); xt = torch.tensor(x)
    gt = torch.tensor(G)
    gmu, gsd = gt[tr].mean(0), gt[tr].std(0) + 1e-6
    gt = (gt - gmu) / gsd

    def fit(cfg, rows, n_members, epochs):
        nets = []
        for m in range(n_members):
            torch.manual_seed(SEED + m); gen = torch.Generator().manual_seed(SEED + 1000 + m)
            net = PointNet(CONFIGS[cfg]["globals"]); opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
            sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
            idx = torch.tensor(rows)
            for _ in range(epochs):
                perm = idx[torch.randperm(len(idx), generator=gen)]
                for b in range(0, len(perm), 32):
                    bi = perm[b:b + 32]
                    sub = torch.randperm(x.shape[1], generator=gen)[: a.train_points]  # point dropout: robustness to sampling
                    loss = nn.functional.mse_loss(net(xt[bi][:, sub], gt[bi]), zt[bi])
                    opt.zero_grad(); loss.backward(); opt.step()
                sched.step()
            nets.append(net.eval())
        return nets

    def run(nets, rows):
        with torch.no_grad():
            return np.stack([n(xt[rows], gt[rows]).numpy() for n in nets])  # standardised model space
    # Model selection: 5-fold CV on the training rows (one member, a third of the epochs); held-out rows are not touched.
    train_rows = np.flatnonzero(tr)
    folds = np.array([int(hashlib.sha256(f"cv:{SEED}:{key(t, i)}".encode()).hexdigest(), 16) % 5 for i, t in zip(index[train_rows], tags[train_rows])])
    cv, oof = {}, {}
    for cfg in CONFIGS:
        err, oof[cfg] = [], np.full((len(train_rows), len(TARGETS)), np.nan)
        for k in range(5):
            if not (folds == k).any() or (folds != k).sum() < 2:
                continue  # tiny datasets (tests): an empty fold says nothing
            nets = fit(cfg, train_rows[folds != k], 1, a.cv_epochs)
            got = run(nets, train_rows[folds == k])[0]
            oof[cfg][folds == k] = got
            err.append(((got - zt[train_rows[folds == k]].numpy()) ** 2).mean())
        cv[cfg] = float(np.sqrt(np.mean(err)))
    chosen = min(cv, key=cv.get)
    # Split-conformal intervals from the chosen configuration's out-of-fold residuals (training rows only): the
    # finite-sample (1 - alpha) quantile of |error| in the model's own space (log for deflection and stress, grams for
    # mass). Out-of-fold models are weaker than the final ensemble, so the intervals err on the wide side.
    resid = np.abs((oof[chosen] * sd + mu) - z[train_rows])
    resid = resid[~np.isnan(resid).any(1)]
    level = min(1.0, np.ceil((len(resid) + 1) * (1 - ALPHA)) / max(len(resid), 1))
    conformal = np.quantile(resid, level, axis=0, method="higher") if len(resid) else np.full(len(TARGETS), np.inf)
    t0 = time.time()
    members = fit(chosen, train_rows, a.members, a.epochs)
    seconds = time.time() - t0

    def ensemble(rows):
        zs = run(members, rows) * sd + mu
        return decode(zs.mean(0)), zs.std(0)
    te_rows = np.flatnonzero(te)
    pred, spread = ensemble(te_rows)
    true = y[te]
    # Calibration: share of held-out points whose log-space truth lies within 2 ensemble sigmas.
    zt_true = encode(true)
    cover = {k: float(np.mean(np.abs(encode(pred)[:, j] - zt_true[:, j]) <= 2 * spread[:, j] + 1e-12)) for j, k in enumerate(TARGETS)}
    cover90 = {k: float(np.mean(np.abs(encode(pred)[:, j] - zt_true[:, j]) <= conformal[j])) for j, k in enumerate(TARGETS)}
    # Baseline: GP on the recipe parameters, same split.
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel
    # Constant recipe values (e.g. 35.012) can have a float std of ~1e-15: decide by range, not by std.
    n0 = len(f["index"]); tr0, te0 = tr[:n0], te[:n0]
    P = f["parameters"]; varying = (P[tr0].max(0) - P[tr0].min(0)) > 1e-9; P = P[:, varying]
    plo, phi = P[tr0].min(0), P[tr0].max(0); Pn = (P - plo) / (phi - plo)
    gp_pred = np.zeros((int(te0.sum()), 3))
    for j in range(3):
        gp = GaussianProcessRegressor(ConstantKernel(1.0) * Matern(length_scale=[0.5] * Pn.shape[1], nu=2.5) + WhiteKernel(1e-4), normalize_y=True, random_state=0)
        gp.fit(Pn[tr0], ((z[:n0] - mu) / sd)[tr0, j]); gp_pred[:, j] = gp.predict(Pn[te0]) * sd[j] + mu[j]
    gp_pred = decode(gp_pred)
    te_tags = tags[te]
    subsets = {TAGS[t]: {"heldOut": int((te_tags == t).sum()), "metrics": metrics(pred[te_tags == t], true[te_tags == t]),
                         "conformal90Coverage": {k: float(np.mean(np.abs(encode(pred[te_tags == t])[:, j] - zt_true[te_tags == t, j]) <= conformal[j])) for j, k in enumerate(TARGETS)}}
               for t in range(len(TAGS)) if (te_tags == t).sum() > 2} if extras else None
    # Inference latency of the ensemble on one part (2048 points), median of 20.
    lat = []
    for _ in range(20):
        s = time.perf_counter(); ensemble(te_rows[:1]); lat.append((time.perf_counter() - s) * 1000)
    out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    torch.save({"schema": "pai-structural-surrogate-1", "config": chosen, "members": [n.state_dict() for n in members], "mu": mu.tolist(), "sd": sd.tolist(), "conformal90": conformal.tolist(),
                "gmu": gmu.tolist(), "gsd": gsd.tolist(),
                "targets": TARGETS, "points": int(x.shape[1]), "rowsSha256": str(f["rowsSha256"][0]),
                "extraRowsSha256": [str(e["rowsSha256"][0]) for e in extras]}, buf)
    (out / "weights.pt").write_bytes(buf.getvalue())
    # What an artifact ships for its own re-check: the held-out rows (features and truths) and the training domain of
    # the geometry descriptors (a prediction outside it is flagged out-of-domain).
    np.savez_compressed(out / "heldout.npz", x=x[te], g=G[te], index=index[te], tag=tags[te], tags=np.array(TAGS), **{k: y[te, j] for j, k in enumerate(TARGETS)})
    graw = G[tr]
    domain = {"schema": "pai-surrogate-domain-1", "descriptors": ["surfaceArea", "volume", "extentX", "extentY", "extentZ"],
              "min": graw.min(0).tolist(), "max": graw.max(0).tolist(), "trainRows": int(tr.sum())}
    (out / "domain.json").write_text(json.dumps(domain, indent=1) + "\n")
    here = Path(__file__).resolve().parent
    result = {"schema": "pai-surrogate-benchmark-1", "scripts": {n: hashlib.sha256((here / n).read_bytes()).hexdigest() for n in ("surrogate_train.py", "surrogate_featurize.py")}, "rowsSha256": str(f["rowsSha256"][0]), "extraRowsSha256": [str(e["rowsSha256"][0]) for e in extras], "datasets": TAGS, "featuresSha256": hashlib.sha256(Path(a.features).read_bytes()).hexdigest(),
              "weightsSha256": hashlib.sha256(buf.getvalue()).hexdigest(), "train": int(tr.sum()), "heldOut": int(te.sum()),
              "selection": {"method": "5-fold CV on training rows, log-space RMSE (standardised)", "cvEpochs": a.cv_epochs, "cv": cv, "chosen": chosen},
              "model": {"name": "PointNet deep ensemble", "config": chosen, "members": a.members, "epochs": a.epochs, "trainPoints": a.train_points, "seed": SEED, "threads": THREADS, "torch": torch.__version__},
              "surrogate": metrics(pred, true), **({"subsets": subsets} if subsets else {}), "coverage2Sigma": cover, "conformal90": {"halfWidth": dict(zip(TARGETS, map(float, conformal))), "space": "log (deflection, stress), grams (mass)",
                "from": f"{len(resid)} out-of-fold residuals of training rows", "heldOutCoverage": cover90}, "gpBaseline": metrics(gp_pred, y[:n0][te0]),
              "inferenceMs": float(np.median(lat)), "trainSeconds": round(seconds, 1),
              "heldOutPoints": [{"index": int(i), "true": t.tolist(), "pred": p.tolist(), "sigmaLog": s.tolist()} for i, t, p, s in zip(index[te], true, pred, spread)],
              "heldOutTags": [TAGS[t] for t in te_tags]}
    (out / "benchmark.json").write_text(json.dumps(result, indent=1, allow_nan=False) + "\n")
    print(json.dumps({k: result[k] for k in ("train", "heldOut", "weightsSha256", "inferenceMs", "trainSeconds", "selection")} |
                     {"surrogate": {k: (v["spearman"], round(v["medianRelError"], 3)) for k, v in result["surrogate"].items()},
                      "gp": {k: (v["spearman"], round(v["medianRelError"], 3)) for k, v in result["gpBaseline"].items()}}))


def load(path):
    w = torch.load(path, weights_only=True)
    members = []
    for sdict in w["members"]:
        n = PointNet(CONFIGS[w["config"]]["globals"]); n.load_state_dict(sdict); members.append(n.eval())
    return w, members


def ensemble_z(w, members, x, g):
    g = (torch.tensor(g) - torch.tensor(w["gmu"])) / torch.tensor(w["gsd"])
    with torch.no_grad():
        return np.stack([n(torch.tensor(x), g).numpy() for n in members]) * np.array(w["sd"]) + np.array(w["mu"])


def evaluate(a):
    """Re-check of shipped weights on the shipped held-out rows (artifact acceptance): metrics and conformal coverage."""
    setup()
    w, members = load(a.weights)
    h = np.load(a.features)
    true = np.stack([h[k] for k in TARGETS], axis=1).astype(np.float64)
    zs = ensemble_z(w, members, h["x"], h["g"])
    pred, q = decode(zs.mean(0)), np.array(w["conformal90"])
    cover = {k: float(np.mean(np.abs(zs.mean(0)[:, j] - encode(true)[:, j]) <= q[j])) for j, k in enumerate(TARGETS)}
    subsets = None
    if "tag" in h and len(h["tags"]) > 1:
        t, names = h["tag"], [str(n) for n in h["tags"]]
        subsets = {names[k]: {"heldOut": int((t == k).sum()), "metrics": metrics(pred[t == k], true[t == k]),
                              "conformal90Coverage": {n: float(np.mean(np.abs(zs.mean(0)[t == k, j] - encode(true[t == k])[:, j]) <= q[j])) for j, n in enumerate(TARGETS)}}
                   for k in range(len(names)) if (t == k).sum() > 2}
    print(json.dumps({"schema": "pai-surrogate-evaluation-1", "heldOut": int(len(true)), "metrics": metrics(pred, true), "conformal90Coverage": cover, **({"subsets": subsets} if subsets else {}),
                      "weightsSha256": hashlib.sha256(Path(a.weights).read_bytes()).hexdigest()}, allow_nan=False))


def predict(a):
    setup()
    w, members = load(a.weights)
    f = np.load(a.features)
    t0 = time.perf_counter()
    zs = ensemble_z(w, members, f["x"], f["g"])
    ms = round((time.perf_counter() - t0) * 1000, 2)
    zm, spread = zs.mean(0)[0], zs.std(0)[0]
    mean, q = decode(zs.mean(0))[0], np.array(w.get("conformal90", [np.inf] * len(TARGETS)))
    interval = {k: [float(v) for v in decode(np.array([zm - q, zm + q]))[:, j]] for j, k in enumerate(TARGETS)}
    domain = json.loads(Path(a.domain).read_text()) if a.domain else None
    outside = [] if not domain else [n for n, v, lo, hi in zip(domain["descriptors"], f["g"][0], domain["min"], domain["max"])
                                       if not (lo - 0.05 * abs(lo) <= v <= hi + 0.05 * abs(hi))]
    print(json.dumps({"schema": "pai-surrogate-prediction-1", **{k: float(v) for k, v in zip(TARGETS, mean)}, "sigmaLog": dict(zip(TARGETS, map(float, spread))),
                      "interval90": interval, "inDomain": not outside, "outsideDomain": outside, "ms": ms, "authority": "suggestion"}, allow_nan=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode", choices=["train", "predict", "evaluate"])
    ap.add_argument("--features", required=True); ap.add_argument("--extra-features", action="append"); ap.add_argument("--output"); ap.add_argument("--weights"); ap.add_argument("--domain")
    ap.add_argument("--members", type=int, default=5); ap.add_argument("--epochs", type=int, default=300); ap.add_argument("--train-points", type=int, default=512)
    ap.add_argument("--cv-epochs", type=int, default=100)
    a = ap.parse_args()
    {"train": train, "predict": predict, "evaluate": evaluate}[a.mode](a)
