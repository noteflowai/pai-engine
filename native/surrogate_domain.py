"""Applicability domain of a structural surrogate: is this part like the parts the model was trained on?

    <physics python> -I surrogate_domain.py fit --weights W.pt --features F.npz [--extra-features E.npz ...] --output DIR
    <physics python> -I surrogate_domain.py score --weights W.pt --domain DIR/domain-2.npz --features one.npz
    <physics python> -I surrogate_domain.py shift-test --weights W.pt --features F.npz [--extra-features ...] --shift S.npz

A prediction is trusted only if the part passes every check; otherwise it is flagged "outside the domain" and ranks as
unknown (the native solver decides either way). The detector was fixed on 2026-10-16, before any of its results were
computed, after structural-surrogate-pillow@1.0.0 predicted 3 off-recipe parts inside its descriptor box with ~100 %
error:

1. descriptor box: each of the five shape descriptors within the training [min, max] +- 5 % (the domain-1 check);
2. constant descriptors: a descriptor that never varies in training (relative spread < 1e-3) must stay within 1 %;
3. Mahalanobis distance of the varying descriptors (standardised, covariance + 1e-3 I) <= the 99th percentile of the
   training rows' distances;
4. geometry embedding: per ensemble member, the pooled point features (max and mean pooling, 512 values) standardised
   on the training rows; the mean distance to the 5 nearest training rows over sqrt(512) is divided by that member's
   threshold (99th percentile of the training rows' leave-one-out scores); flagged when the mean ratio over members
   exceeds 1.

SHIFT_GATE (also fixed before results): on a recipe-only model and parts it never saw (the off-recipe datasets), at
most 10 % of the parts with a deflection or stress error above 10 % may pass unflagged (needs at least 10 such
parts), and at most 10 % of the model's own recipe held-out parts may be flagged. A shipped model's own held-out
subsets may each be flagged at most 10 %.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("surrogate_train", HERE / "surrogate_train.py")
T = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(T)

BOX_MARGIN, CONST_REL, CONST_TOL, SHRINK, QUANTILE, K = 0.05, 1e-3, 0.01, 1e-3, 0.99, 5
SHIFT_GATE = {"maxLeak": 0.10, "wrongRelError": 0.10, "minWrong": 10, "maxFalseAlarm": 0.10}
DESCRIPTORS = ["surfaceArea", "volume", "extentX", "extentY", "extentZ"]


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def training_rows(features, extras):
    """Rebuild the trainer's rows and split exactly (same keys, same hash), return (x, g, y, tags, train mask)."""
    f = np.load(features); ex = [np.load(e) for e in extras]
    T.TAGS[:] = [str(f["dataset"][0]) if "dataset" in f else "primary"] + [str(e["dataset"][0]) for e in ex]
    x = np.concatenate([f["x"], *[e["x"] for e in ex]]); g = np.concatenate([f["g"], *[e["g"] for e in ex]]).astype(np.float64)
    index = np.concatenate([f["index"], *[e["index"] for e in ex]])
    tags = np.concatenate([np.zeros(len(f["index"]), dtype=int), *[np.full(len(e["index"]), j + 1) for j, e in enumerate(ex)]])
    y = np.stack([np.concatenate([f[k], *[e[k] for e in ex]]) for k in T.TARGETS], axis=1).astype(np.float64)
    tr, te = T.split(index, tags)
    return x, g, y, tags, tr, te, list(T.TAGS)


def embed(members, x, batch=32):
    """(members, rows, 512): pooled point features of each ensemble member (the head's geometry input)."""
    out = []
    with torch.no_grad():
        for n in members:
            parts = []
            for i in range(0, len(x), batch):
                h = n.point(torch.tensor(x[i:i + batch]))
                parts.append(torch.cat([h.max(dim=1).values, h.mean(dim=1)], dim=1).numpy())
            out.append(np.concatenate(parts))
    return np.stack(out).astype(np.float64)


def knn_score(ref, q, k=K, exclude_self=False):
    sq = (q ** 2).sum(1)[:, None] + (ref ** 2).sum(1)[None, :] - 2 * q @ ref.T
    d = np.sqrt(np.maximum(sq, 0)) / np.sqrt(ref.shape[1])
    if exclude_self:
        np.fill_diagonal(d, np.inf)
    return np.sort(d, axis=1)[:, :k].mean(1)


def fit_domain(members, x, g):
    mu, sd = g.mean(0), g.std(0)
    varying = sd > CONST_REL * (np.abs(mu) + 1e-3)
    z = (g[:, varying] - mu[varying]) / sd[varying]
    icov = np.linalg.inv(np.cov(z, rowvar=False).reshape(varying.sum(), varying.sum()) + SHRINK * np.eye(varying.sum()))
    maha = np.sqrt(np.einsum("ij,jk,ik->i", z, icov, z))
    e = embed(members, x)
    emu, esd = e.mean(1, keepdims=True), e.std(1, keepdims=True)
    esd = np.where(esd > 1e-6, esd, 1.0)
    en = (e - emu) / esd
    tau = np.array([np.quantile(knn_score(en[m], en[m], exclude_self=True), QUANTILE) for m in range(len(members))])
    return {"gmin": g.min(0), "gmax": g.max(0), "gmu": mu, "gsd": sd, "varying": varying, "icov": icov,
            "mahaMax": float(np.quantile(maha, QUANTILE)), "emu": emu, "esd": esd, "eref": en, "tau": tau}


def score(dom, members, x, g):
    """Per row: (flagged, reasons, mahalanobis, embedding ratio)."""
    g = np.asarray(g, dtype=np.float64)
    lo, hi = dom["gmin"], dom["gmax"]
    box = (g < lo - BOX_MARGIN * np.abs(lo)) | (g > hi + BOX_MARGIN * np.abs(hi))
    v = dom["varying"].astype(bool)
    const = np.abs(g[:, ~v] - dom["gmu"][~v]) > CONST_TOL * (np.abs(dom["gmu"][~v]) + 1e-3)
    z = (g[:, v] - dom["gmu"][v]) / dom["gsd"][v]
    maha = np.sqrt(np.einsum("ij,jk,ik->i", z, dom["icov"], z))
    e = (embed(members, x) - dom["emu"]) / dom["esd"]
    ratio = np.mean([knn_score(dom["eref"][m], e[m]) / dom["tau"][m] for m in range(len(members))], axis=0)
    rows = []
    names = np.array(DESCRIPTORS)
    for i in range(len(g)):
        reasons = [f"descriptor {n} outside the training range" for n in names[box[i]]]
        reasons += [f"descriptor {n} differs from its constant training value" for n in names[~v][const[i]]]
        if maha[i] > dom["mahaMax"]:
            reasons.append(f"descriptor combination unusual (Mahalanobis {maha[i]:.2f} > {dom['mahaMax']:.2f})")
        if ratio[i] > 1:
            reasons.append(f"geometry unlike the training parts (embedding distance {ratio[i]:.2f} x threshold)")
        rows.append({"flagged": bool(reasons), "reasons": reasons, "mahalanobis": round(float(maha[i]), 4), "embeddingRatio": round(float(ratio[i]), 4)})
    return rows


def save(dom, path, provenance):
    np.savez_compressed(path, **{k: np.asarray(v) for k, v in dom.items()})
    meta = {"schema": "pai-surrogate-domain-2", "descriptors": DESCRIPTORS, "checks": ["box", "constant", "mahalanobis", "embedding"],
            "parameters": {"boxMargin": BOX_MARGIN, "constantRelSpread": CONST_REL, "constantTolerance": CONST_TOL, "shrinkage": SHRINK, "quantile": QUANTILE, "k": K},
            "mahalanobisThreshold": dom["mahaMax"], "embeddingThresholds": dom["tau"].tolist(), "varying": dom["varying"].tolist(), **provenance,
            "npzSha256": sha(path), "script": sha(__file__)}
    Path(path).with_suffix(".json").write_text(json.dumps(meta, indent=1) + "\n")
    return meta


def load_domain(path):
    z = np.load(path)
    return {k: z[k] for k in z.files}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("mode", choices=["fit", "score", "shift-test"])
    ap.add_argument("--weights", required=True); ap.add_argument("--features", required=True); ap.add_argument("--extra-features", action="append", default=[])
    ap.add_argument("--domain"); ap.add_argument("--output"); ap.add_argument("--shift")
    a = ap.parse_args()
    T.setup()
    w, members = T.load(a.weights)
    if a.mode == "score":
        f = np.load(a.features)
        print(json.dumps({"schema": "pai-surrogate-domain-score-1", **score(load_domain(a.domain), members, f["x"], f["g"])[0]}))
        return
    x, g, y, tags, tr, te, names = training_rows(a.features, a.extra_features)
    dom = fit_domain(members, x[tr], g[tr])
    prov = {"weightsSha256": sha(a.weights), "featuresSha256": [sha(a.features), *map(sha, a.extra_features)], "trainRows": int(tr.sum()), "datasets": names}
    if a.mode == "fit":
        out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
        print(json.dumps(save(dom, out / "domain-2.npz", prov)))
        return
    # shift-test: the model's own held-out subsets (false alarms) and an unseen dataset (leaks), against SHIFT_GATE.
    def predict(xx, gg):
        return T.decode(T.ensemble_z(w, members, xx, gg.astype(np.float32)).mean(0))

    report = {"schema": "pai-surrogate-shift-test-1", "gate": SHIFT_GATE, **prov, "heldOut": {}, "failed": []}
    s_te = score(dom, members, x[te], g[te])
    for t, n in enumerate(names):
        m = tags[te] == t
        if m.sum():
            fa = float(np.mean([r["flagged"] for r, k in zip(s_te, m) if k]))
            report["heldOut"][n] = {"rows": int(m.sum()), "flagged": fa}
            if fa > SHIFT_GATE["maxFalseAlarm"]:
                report["failed"].append(f"{n}: {fa:.0%} of held-out parts flagged > {SHIFT_GATE['maxFalseAlarm']:.0%}")
    if a.shift:
        s = np.load(a.shift)
        ys = np.stack([s[k] for k in T.TARGETS], axis=1).astype(np.float64)
        pred = predict(s["x"], s["g"])
        rel = np.abs(pred - ys) / np.abs(ys)
        wrong = (rel[:, 0] > SHIFT_GATE["wrongRelError"]) | (rel[:, 1] > SHIFT_GATE["wrongRelError"])
        sc = score(dom, members, s["x"], s["g"])
        flag = np.array([r["flagged"] for r in sc])
        box_only = np.array([any(x.startswith("descriptor") and "range" in x for x in r["reasons"]) for r in sc])
        leak = float((wrong & ~flag).sum() / max(wrong.sum(), 1))
        report["shift"] = {"dataset": str(s["dataset"][0]) if "dataset" in s else a.shift, "rows": int(len(ys)), "wrong": int(wrong.sum()),
                           "flagged": int(flag.sum()), "wrongUnflagged": int((wrong & ~flag).sum()), "leak": leak,
                           "boxOnly": {"flagged": int(box_only.sum()), "wrongUnflagged": int((wrong & ~box_only).sum()), "leak": float((wrong & ~box_only).sum() / max(wrong.sum(), 1))},
                           "correctFlagged": int((~wrong & flag).sum()), "correct": int((~wrong).sum()),
                           "byCheck": {c: int(sum(any(c in x for x in r["reasons"]) for r in sc)) for c in ("range", "constant", "Mahalanobis", "embedding")},
                           "medianRelError": {k: float(np.median(rel[:, j])) for j, k in enumerate(T.TARGETS)},
                           "unflaggedWrong": [{"index": int(s["index"][i]), "relError": [round(float(v), 3) for v in rel[i]], **sc[i]} for i in np.where(wrong & ~flag)[0]]}
        if wrong.sum() < SHIFT_GATE["minWrong"]:
            report["failed"].append(f"only {int(wrong.sum())} wrong parts in the shift set (< {SHIFT_GATE['minWrong']}): the leak rate is not measured")
        elif leak > SHIFT_GATE["maxLeak"]:
            report["failed"].append(f"{leak:.0%} of wrong predictions unflagged > {SHIFT_GATE['maxLeak']:.0%}")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
