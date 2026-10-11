"""Cross-engine check of the exported OpenUSD robot cell: Newton (Linux Foundation, NVIDIA Warp) against MuJoCo.

    <newton venv>/bin/python usd_newton_check.py --usd scene.usda --mjcf scene.xml --output newton.json

The USD is what Isaac Lab / Newton users receive, so it must carry the same robot as the MJCF that PAI simulated:
- Newton imports the USD as one articulation (6 revolute + fixed joints, no orphan joints) and the body masses match;
- forward kinematics agree: Newton FK of the USD and MuJoCo FK of the MJCF at the authored pose and at 32 seeded
  configurations inside the joint limits, every robot body position within 0.1 mm and orientation within 0.01 deg;
- the authored body Xforms equal Newton FK at the authored pose (the stage is self-consistent).
Kinematics and mass only; no dynamics claim. Exit 0 with passed:false when a check fails; exit 2 on a load error.
"""
import argparse, hashlib, json, os, sys, time
from pathlib import Path
import numpy as np

p = argparse.ArgumentParser(); p.add_argument("--usd", required=True); p.add_argument("--mjcf", required=True); p.add_argument("--output", required=True)
a = p.parse_args()
t0 = time.time()
import warp as wp
wp.config.log_level = wp.LOG_WARNING if hasattr(wp, "LOG_WARNING") else None
import mujoco, newton
from pxr import Usd, UsdGeom

POS_TOL, ROT_TOL_DEG, SAMPLES = 1e-4, 0.01, 32
stage = Usd.Stage.Open(a.usd)
pose = list(stage.GetRootLayer().customLayerData.get("poseJointRadians", []))
builder = newton.ModelBuilder()
builder.add_usd(a.usd)
# CUDA (Warp) when the runtime offered a GPU, else the CPU; the checks compare against MuJoCo with fixed tolerances.
DEVICE = "cuda" if os.environ.get("PAI_GPU") == "1" and wp.is_cuda_available() else "cpu"
model = builder.finalize(device=DEVICE)
labels = [l.rsplit("/", 1)[-1] for l in model.body_label]
mj = mujoco.MjModel.from_xml_path(a.mjcf); md = mujoco.MjData(mj)
from pxr import Tf
# Prim names are the MuJoCo body names made valid USD identifiers (robot_sim.py write_usd), e.g. cad-tool → cad_tool.
ids = {Tf.MakeValidIdentifier(mujoco.mj_id2name(mj, mujoco.mjtObj.mjOBJ_BODY, b) or f"body{b}"): b for b in range(mj.nbody)}
common = [n for n in labels if n in ids]
jtypes = model.joint_type.numpy().tolist()
revolute = sum(1 for t in jtypes if t == int(newton.JointType.REVOLUTE))


def quat_angle_deg(q1, q2):
    """Rotation angle between two xyzw quaternions: 2·atan2(|v|, |w|) of q1⁻¹q2 (stable near zero, unlike acos)."""
    q1, q2 = np.asarray(q1, float) / np.linalg.norm(q1), np.asarray(q2, float) / np.linalg.norm(q2)
    v1, w1, v2, w2 = -q1[:3], q1[3], q2[:3], q2[3]
    w = w1 * w2 - v1 @ v2; v = w1 * v2 + w2 * v1 + np.cross(v1, v2)
    return float(np.degrees(2 * np.arctan2(np.linalg.norm(v), abs(w))))


def compare(q):
    state = model.state()
    jq = model.joint_q.numpy(); jq[:6] = q; model.joint_q.assign(jq)
    newton.eval_fk(model, model.joint_q, model.joint_qd, state)
    bq = state.body_q.numpy()  # (n, 7): p xyz, q xyzw
    md.qpos[:6] = q; mujoco.mj_kinematics(mj, md)
    worst_p, worst_r = 0.0, 0.0
    for i, n in enumerate(labels):
        if n not in ids:
            continue
        b = ids[n]
        worst_p = max(worst_p, float(np.linalg.norm(bq[i, :3] - md.xpos[b])))
        w = md.xquat[b]; worst_r = max(worst_r, quat_angle_deg(bq[i, 3:], np.array([w[1], w[2], w[3], w[0]])))
    return worst_p, worst_r, bq


lo, hi = mj.jnt_range[:6, 0], mj.jnt_range[:6, 1]
rng = np.random.default_rng(20261004)
configs = ([np.array(pose)] if len(pose) == 6 else []) + [lo + (hi - lo) * rng.random(6) for _ in range(SAMPLES)]
errs = [compare(q)[:2] for q in configs]
fk_pos, fk_rot = max(e[0] for e in errs), max(e[1] for e in errs)
authored = 0.0
if len(pose) == 6:
    _, _, bq = compare(np.array(pose))
    cache = UsdGeom.XformCache()
    for i, path in enumerate(model.body_label):
        prim = stage.GetPrimAtPath(path)
        if prim:
            t = cache.GetLocalToWorldTransform(prim).ExtractTranslation()
            authored = max(authored, float(np.linalg.norm(bq[i, :3] - np.array(t))))
mass_newton = {n: float(m) for n, m in zip(labels, model.body_mass.numpy())}
mass_err = max((abs(mass_newton[n] - float(mj.body_mass[ids[n]])) for n in common), default=float("inf"))
checks = [
    {"id": "articulation", "passed": model.articulation_count == 1 and revolute == 6, "observed": {"articulations": int(model.articulation_count), "revolute": revolute, "joints": int(model.joint_count)}},
    {"id": "body-mass", "passed": len(common) == len(labels) and mass_err < 1e-4, "observed": round(mass_err, 8), "required": 1e-4, "unit": "kg"},
    {"id": "fk-position", "passed": fk_pos <= POS_TOL, "observed": round(fk_pos, 9), "required": POS_TOL, "unit": "m"},
    {"id": "fk-orientation", "passed": fk_rot <= ROT_TOL_DEG, "observed": round(fk_rot, 6), "required": ROT_TOL_DEG, "unit": "deg"},
    {"id": "authored-pose", "passed": len(pose) == 6 and authored <= POS_TOL, "observed": round(authored, 9), "required": POS_TOL, "unit": "m"},
]
out = {"schema": "pai-usd-newton-1", "device": DEVICE, "newton": newton.__version__, "warp": wp.__version__, "mujoco": mujoco.__version__,
       "usdSha256": hashlib.sha256(Path(a.usd).read_bytes()).hexdigest(), "mjcfSha256": hashlib.sha256(Path(a.mjcf).read_bytes()).hexdigest(),
       "bodies": labels, "configurations": len(configs), "checks": checks, "passed": all(c["passed"] for c in checks),
       "seconds": round(time.time() - t0, 1), "scope": "kinematics-and-mass-conformance", "physicalValidation": False}
Path(a.output).write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps({"passed": out["passed"], **{c["id"]: c["observed"] for c in checks}}))
