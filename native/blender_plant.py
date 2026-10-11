"""Controlled native Blender recipe: a production line in a factory hall, with measured layout checks.

Input is a bounded parameter set (no user Python, no uploaded .blend). The recipe builds a factory hall with
CNC cells, articulated 6-axis robots, guarded cells, conveyors, pallet racking, AGVs, a bridge crane and an
inspection-camera gantry, animates the moving equipment (illustrative kinematics, not physics), renders the
scene with Cycles and measures the layout on the static geometry with a BVH:

  footprint-area    hall floor area                                    <= maxFootprintArea
  aisle-clearance   narrowest clear width of the AGV aisle             >= minAisleWidth
  guard-clearance   robot declared reach envelope to nearest guard     >= minGuardClearance
  camera-coverage   every station target is the first hit of its camera ray and inside its frustum
  egress-travel     longest travel from a station along the aisle to an exit  <= maxEgressTravel

Emits PAI_EVENT lines (construction stages, the governing camera ray, Cycles samples). Authoritative artifacts:
scene.blend, scene.glb (with animation), preview.png, inspection.png and checks.json.
Scope: synthetic explicit layout; geometry rules of thumb. No dynamics, joint limits, safety certification,
lighting levels, throughput simulation or measured factory data.
"""
import argparse
import json
import math
from pathlib import Path
import re
import sys

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_gpu import use_render_device  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
spec = json.loads(Path(args.input).read_text())
L, req = spec["layout"], spec["requirements"]
hero = spec.get("render", "preview") == "hero"
out = Path(args.output)
(out / "stages").mkdir(parents=True, exist_ok=True)

BOUNDS = {"stations": (3, 8), "stationPitch": (3.5, 7.0), "aisleWidth": (1.2, 4.5), "guardSize": (2.6, 5.0),
          "rackRows": (1, 4), "cameraHeight": (2.4, 6.5), "agvs": (0, 4)}
for k, (lo, hi) in BOUNDS.items():
    if not lo <= L[k] <= hi:
        raise SystemExit(f"{k}={L[k]} outside [{lo}, {hi}]")
N, PITCH, AISLE, GUARD = int(L["stations"]), float(L["stationPitch"]), float(L["aisleWidth"]), float(L["guardSize"])
RACKS, CAM_H, AGVS = int(L["rackRows"]), float(L["cameraHeight"]), int(L["agvs"])
REACH, ROBOT_Y, REF_GUARD_HALF = 1.45, 1.55, 1.8      # declared reach envelope (m), robot base line, reference guard
LINE_LEN = N * PITCH
X0 = -LINE_LEN / 2 + PITCH / 2                          # first station centre
FENCE_Y = ROBOT_Y + GUARD / 2                            # aisle-side guard panel
RACK_Y = ROBOT_Y + REF_GUARD_HALF + AISLE                # rack face (nominal aisle assumes the reference guard)
CAM_Y = ROBOT_Y + REF_GUARD_HALF + AISLE / 2             # camera gantry above the nominal aisle centre
HALL_X = (-LINE_LEN / 2 - 6.0, LINE_LEN / 2 + 6.0)
HALL_Y = (-5.2, RACK_Y + RACKS * 1.35 + 2.4)
ROOF = 9.0
stage_index = [0]


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True, ensure_ascii=False), flush=True)


def gltf(v):
    return [round(float(v[0]), 4), round(float(v[2]), 4), round(float(-v[1]), 4)]


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for block in (bpy.data.meshes, bpy.data.materials):
    for item in list(block):
        block.remove(item)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.frame_start, scene.frame_end, scene.render.fps = 1, 240, 24
scene.frame_set(1)


# ---------------------------------------------------------------- materials (Cycles detail; glTF keeps PBR constants)
def material(name, color, metallic=0.0, roughness=0.5, emission=None, strength=0.0, alpha=1.0, transmission=0.0, noise=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, alpha)
    nt = mat.node_tree
    p = nt.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    if transmission:
        p.inputs["Transmission Weight"].default_value = transmission
        p.inputs["IOR"].default_value = 1.45
    if emission:
        p.inputs["Emission Color"].default_value = (*emission, 1)
        p.inputs["Emission Strength"].default_value = strength
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
    if noise:
        # Procedural wear: noise drives colour variation and roughness (Cycles only).
        tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 3.0; tex.inputs["Detail"].default_value = 8.0
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].color = (*[c * (1 - noise) for c in color], 1)
        ramp.color_ramp.elements[1].color = (*[min(1.0, c * (1 + noise)) for c in color], 1)
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"]); nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
        rough = nt.nodes.new("ShaderNodeMapRange"); rough.inputs["To Min"].default_value = roughness * 0.7; rough.inputs["To Max"].default_value = min(1.0, roughness * 1.3)
        nt.links.new(tex.outputs["Fac"], rough.inputs["Value"]); nt.links.new(rough.outputs["Result"], p.inputs["Roughness"])
    return mat


M = {
    "floor": material("Concrete floor", (0.42, 0.43, 0.42), roughness=0.62, noise=0.18),
    "line": material("Safety yellow marking", (0.95, 0.72, 0.05), roughness=0.4),
    "walk": material("Walkway green", (0.16, 0.42, 0.28), roughness=0.5),
    "steel": material("Structural steel", (0.20, 0.24, 0.27), metallic=0.7, roughness=0.42),
    "clad": material("Wall cladding", (0.70, 0.73, 0.74), metallic=0.4, roughness=0.5, noise=0.05),
    "machine": material("Machine enclosure", (0.86, 0.88, 0.89), metallic=0.2, roughness=0.35),
    "machine_dark": material("Machine graphite", (0.11, 0.12, 0.13), metallic=0.3, roughness=0.45),
    "glass": material("Machine window glass", (0.75, 0.85, 0.9), roughness=0.05, transmission=1.0, alpha=0.35),
    "robot": material("Robot orange", (0.98, 0.42, 0.04), metallic=0.25, roughness=0.32),
    "robot_dark": material("Robot joint graphite", (0.09, 0.09, 0.1), metallic=0.5, roughness=0.4),
    "guard": material("Guard mesh", (0.14, 0.15, 0.16), metallic=0.6, roughness=0.5, alpha=0.45),
    "post": material("Guard post yellow", (0.96, 0.75, 0.06), metallic=0.3, roughness=0.4),
    "conveyor": material("Conveyor aluminium", (0.62, 0.64, 0.66), metallic=0.85, roughness=0.3),
    "belt": material("Conveyor belt", (0.05, 0.06, 0.06), roughness=0.8),
    "rack_up": material("Rack upright blue", (0.07, 0.22, 0.55), metallic=0.4, roughness=0.4),
    "rack_beam": material("Rack beam orange", (0.92, 0.35, 0.05), metallic=0.4, roughness=0.4),
    "pallet": material("Pallet wood", (0.55, 0.38, 0.2), roughness=0.75, noise=0.2),
    "carton": material("Carton", (0.62, 0.45, 0.27), roughness=0.85, noise=0.15),
    "agv": material("AGV body", (0.12, 0.13, 0.14), metallic=0.4, roughness=0.4),
    "agv_top": material("AGV deck yellow", (0.96, 0.78, 0.08), roughness=0.4),
    "beacon": material("Beacon", (0.1, 0.9, 0.6), emission=(0.1, 1.0, 0.6), strength=6.0),
    "lamp": material("High-bay LED", (1, 1, 1), emission=(1.0, 0.96, 0.9), strength=18.0),
    "camera": material("Camera housing", (0.15, 0.16, 0.17), metallic=0.5, roughness=0.3),
    "target": material("Workpiece aluminium", (0.82, 0.84, 0.86), metallic=0.9, roughness=0.22),
    "screen": material("HMI screen", (0.05, 0.2, 0.3), emission=(0.15, 0.6, 0.9), strength=3.0),
    "crane": material("Crane yellow", (0.95, 0.68, 0.05), metallic=0.4, roughness=0.4),
}


# ---------------------------------------------------------------- geometry builders
class Batch:
    """Accumulates many boxes/cylinders into one mesh object (few objects, fast export, BVH-friendly)."""
    def __init__(self, name, mat):
        self.name, self.mat, self.bm = name, mat, bmesh.new()

    def box(self, center, size, rot_z=0.0):
        m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rot_z, 4, "Z") @ Matrix.Diagonal((*size, 1))
        bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        return self

    def cyl(self, center, radius, depth, axis="Z", segments=20):
        rot = {"Z": Matrix.Identity(4), "X": Matrix.Rotation(math.pi / 2, 4, "Y"), "Y": Matrix.Rotation(math.pi / 2, 4, "X")}[axis]
        m = Matrix.Translation(Vector(center)) @ rot
        bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=depth, matrix=m)
        return self

    def done(self, parent=None):
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh); self.bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = False
        mesh.materials.append(self.mat)
        obj = bpy.data.objects.new(self.name, mesh)
        scene.collection.objects.link(obj)
        if parent:
            obj.parent = parent
        return obj


def box(name, center, size, mat, parent=None, rot_z=0.0):
    """Single part: mesh around its own origin, object placed at `center` (relative to parent)."""
    obj = Batch(name, mat).box((0, 0, 0), size, rot_z).done(parent)
    obj.location = center
    return obj


def cyl(name, center, radius, depth, mat, parent=None, axis="Z", segments=24):
    obj = Batch(name, mat).cyl((0, 0, 0), radius, depth, axis, segments).done(parent)
    obj.location = center
    return obj


def empty(name, location, parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = location
    scene.collection.objects.link(e)
    if parent:
        e.parent = parent
    return e


def stage(stage_id, label, objects):
    stage_index[0] += 1
    name = f"{stage_index[0]:02d}-{stage_id}.glb"
    bpy.ops.export_scene.gltf(filepath=str(out / "stages" / name), export_format="GLB", export_animations=False, export_apply=False)
    names = [o.name for o in objects if o.type == "MESH"]
    event({"type": "stage", "index": stage_index[0], "id": stage_id, "label": label, "file": "stages/" + name, "objects": names[:32]})


static = []          # obstacles for the layout BVH (moving equipment is excluded)
fences = []          # guard panels for the reach-envelope check
targets = []

# ---------------------------------------------------------------- 1 hall
hx0, hx1 = HALL_X
hy0, hy1 = HALL_Y
cx, cy = (hx0 + hx1) / 2, (hy0 + hy1) / 2
floor = box("Hall floor", (cx, cy, -0.1), (hx1 - hx0, hy1 - hy0, 0.2), M["floor"])
cols = Batch("Hall columns", M["steel"])
col_x = [hx0 + 0.3 + i * 6.0 for i in range(int((hx1 - hx0 - 0.6) // 6.0) + 1)]
for x in col_x:
    for y in (hy0 + 0.3, hy1 - 0.3):
        cols.box((x, y, ROOF / 2), (0.36, 0.36, ROOF))
columns = cols.done()
walls = Batch("Hall walls", M["clad"]).box((cx, hy1, ROOF / 2), (hx1 - hx0, 0.12, ROOF)).box((hx0, cy, ROOF / 2 - 1.2), (0.12, hy1 - hy0, ROOF - 2.4)).done()
truss = Batch("Roof trusses", M["steel"])
for x in col_x:
    truss.box((x, cy, ROOF), (0.25, hy1 - hy0, 0.5))
for y in (hy0 + 0.3, hy1 - 0.3, cy):
    truss.box((cx, y, ROOF + 0.35), (hx1 - hx0, 0.18, 0.18))
trusses = truss.done()
marks = Batch("Floor markings", M["line"])
marks.box((0, FENCE_Y + 0.12, 0.004), (LINE_LEN + 2, 0.1, 0.008)).box((0, RACK_Y - 0.12, 0.004), (LINE_LEN + 2, 0.1, 0.008))
for x in (hx0 + 2.5, hx1 - 2.5):     # exit hatching
    for k in range(8):
        marks.box((x, CAM_Y - 1.2 + k * 0.35, 0.004), (2.4, 0.12, 0.008), rot_z=0.6)
markings = marks.done()
walkway = box("Pedestrian walkway", (cx, hy0 + 1.3, 0.003), (hx1 - hx0 - 1, 1.2, 0.006), M["walk"])
doors = Batch("Exit doors", M["walk"]).box((hx0 + 0.07, CAM_Y, 1.4), (0.06, 2.4, 2.8)).box((hx1 - 0.07, CAM_Y, 1.4), (0.06, 2.4, 2.8)).done()
static += [columns, walls]
stage("hall", f"厂房 {hx1 - hx0:.0f} m × {hy1 - hy0:.0f} m：柱网、桁架、地标线", [floor, columns, walls, trusses, markings, walkway, doors])

# ---------------------------------------------------------------- 2 production line
conv = Batch("Conveyor frame", M["conveyor"]).box((0, 0, 0.82), (LINE_LEN + 2, 0.9, 0.12))
for x in [-LINE_LEN / 2 - 0.8 + i * 1.6 for i in range(int((LINE_LEN + 2) // 1.6) + 1)]:
    conv.box((x, -0.38, 0.4), (0.08, 0.08, 0.8)).box((x, 0.38, 0.4), (0.08, 0.08, 0.8))
conveyor = conv.done()
belt = box("Conveyor belt", (0, 0, 0.9), (LINE_LEN + 2, 0.72, 0.03), M["belt"])
rollers = Batch("Conveyor rollers", M["conveyor"])
for i in range(int(LINE_LEN + 2) * 3):
    rollers.cyl((-LINE_LEN / 2 - 1 + i / 3, 0, 0.86), 0.035, 0.78, axis="Y", segments=10)
rollers_obj = rollers.done()
for i in range(N):
    x = X0 + i * PITCH
    targets.append(box(f"Station {i + 1} workpiece", (x + 1.1, 0, 1.0), (0.32, 0.26, 0.16), M["target"]))
static += [conveyor, belt]
stage("line", f"{N} 工位输送线 {LINE_LEN:.0f} m，滚筒与工件", [conveyor, belt, rollers_obj, *targets])

# ---------------------------------------------------------------- 3 CNC cells
machines = []
for i in range(N):
    x = X0 + i * PITCH
    shell = Batch(f"CNC {i + 1} enclosure", M["machine"]).box((x, -2.55, 1.15), (2.6, 2.0, 2.3)).box((x - 1.55, -2.0, 1.0), (0.45, 0.6, 2.0))
    dark = Batch(f"CNC {i + 1} frame", M["machine_dark"]).box((x, -2.55, 0.08), (2.7, 2.1, 0.16)).box((x, -2.55, 2.36), (2.62, 2.02, 0.12)).box((x + 1.38, -1.7, 1.25), (0.12, 0.32, 0.5))
    machines += [shell.done(), dark.done(), box(f"CNC {i + 1} window", (x + 0.1, -1.54, 1.3), (1.3, 0.02, 0.9), M["glass"]),
                 box(f"CNC {i + 1} HMI", (x + 1.38, -1.53, 1.3), (0.26, 0.02, 0.2), M["screen"])]
static += machines
stage("machines", f"{N} 台 CNC 加工中心（玻璃观察窗、HMI）", machines)


# ---------------------------------------------------------------- 4 articulated robots
def robot(i, x):
    base = cyl(f"Robot {i} base", (x, ROBOT_Y, 0.2), 0.34, 0.4, M["robot_dark"])
    turret = empty(f"Robot {i} J1", (x, ROBOT_Y, 0.4))
    cyl(f"Robot {i} turret", (0, 0, 0.2), 0.29, 0.4, M["robot"], turret)
    shoulder = empty(f"Robot {i} J2", (0.12, 0, 0.46), turret)
    cyl(f"Robot {i} shoulder", (0, 0, 0), 0.17, 0.36, M["robot_dark"], shoulder, axis="Y")
    box(f"Robot {i} upper arm", (0, 0, 0.48), (0.22, 0.24, 0.96), M["robot"], shoulder)
    elbow = empty(f"Robot {i} J3", (0, 0, 0.96), shoulder)
    cyl(f"Robot {i} elbow", (0, 0, 0), 0.14, 0.3, M["robot_dark"], elbow, axis="Y")
    box(f"Robot {i} forearm", (0.42, 0, 0), (0.86, 0.17, 0.17), M["robot"], elbow)
    wrist = empty(f"Robot {i} J5", (0.86, 0, 0), elbow)
    cyl(f"Robot {i} wrist", (0.05, 0, 0), 0.08, 0.14, M["robot_dark"], wrist, axis="X")
    box(f"Robot {i} gripper", (0.16, 0, -0.05), (0.08, 0.2, 0.08), M["robot_dark"], wrist)
    box(f"Robot {i} finger L", (0.22, 0.07, -0.12), (0.04, 0.03, 0.12), M["conveyor"], wrist)
    box(f"Robot {i} finger R", (0.22, -0.07, -0.12), (0.04, 0.03, 0.12), M["conveyor"], wrist)
    # Home pose (frame 1, used for every check): facing the conveyor, arm raised.
    poses = [(1, -1.5708, -0.35, 1.05, 0.0), (40, -1.05, 0.25, 0.55, 0.6), (60, -1.05, 0.38, 0.62, 0.6),
             (100, -2.1, 0.1, 0.75, -0.4), (140, -1.5708, -0.35, 1.05, 0.0)]
    phase = (i * 17) % 40
    for f, j1, j2, j3, j5 in poses:
        frame = 1 if f == 1 else min(240, f + phase)
        turret.rotation_euler = (0, 0, j1); shoulder.rotation_euler = (0, j2, 0); elbow.rotation_euler = (0, j3, 0); wrist.rotation_euler = (j5, 0, 0)
        for obj in (turret, shoulder, elbow, wrist):
            obj.keyframe_insert("rotation_euler", frame=frame)
    for f, j1, j2, j3, j5 in poses[:1]:
        turret.rotation_euler = (0, 0, j1); shoulder.rotation_euler = (0, j2, 0); elbow.rotation_euler = (0, j3, 0); wrist.rotation_euler = (j5, 0, 0)
    return base


robots = []
for i in range(N):
    robots.append(robot(i + 1, X0 + i * PITCH))
scene.frame_set(1)
robot_meshes = [o for o in scene.objects if o.name.startswith("Robot") and o.type == "MESH"]
static += robot_meshes
stage("robots", f"{N} 台六轴机器人（关节层级，取放动作）", robot_meshes)

# ---------------------------------------------------------------- 5 guarding
panels, posts = Batch("Guard mesh panels", M["guard"]), Batch("Guard posts", M["post"])
half = GUARD / 2
for i in range(N):
    x = X0 + i * PITCH
    panels.box((x, FENCE_Y, 1.1), (GUARD, 0.04, 2.0))
    for side in (-1, 1):
        y0, y1 = 0.55, FENCE_Y
        panels.box((x + side * half, (y0 + y1) / 2, 1.1), (0.04, y1 - y0, 2.0))
        for yy in (y0, y1):
            posts.box((x + side * half, yy, 1.1), (0.07, 0.07, 2.2))
guard_panels, guard_posts = panels.done(), posts.done()
fences += [guard_panels, guard_posts]
static += fences
stage("guards", f"安全围栏 {GUARD:.1f} m × {FENCE_Y - 0.55:.1f} m（三面，输送线侧开口）", [guard_panels, guard_posts])

# ---------------------------------------------------------------- 6 storage
storage = []
levels = (0.15, 1.75, 3.35, 4.95)
for r in range(RACKS):
    y = RACK_Y + 0.55 + r * 1.35
    up, beam, pal, car = Batch(f"Rack row {r + 1} uprights", M["rack_up"]), Batch(f"Rack row {r + 1} beams", M["rack_beam"]), Batch(f"Rack row {r + 1} pallets", M["pallet"]), Batch(f"Rack row {r + 1} cartons", M["carton"])
    bays = max(2, int(LINE_LEN // 2.8))
    x_start = -bays * 2.8 / 2
    for b in range(bays + 1):
        for yy in (y - 0.5, y + 0.5):
            up.box((x_start + b * 2.8, yy, 3.0), (0.1, 0.1, 6.0))
    for lv in levels[1:]:
        for yy in (y - 0.5, y + 0.5):
            beam.box((0, yy, lv), (bays * 2.8, 0.08, 0.14))
    for b in range(bays):
        for li, lv in enumerate(levels):
            if (b + li + r) % 5 == 4:
                continue
            for k in (-0.65, 0.65):
                px = x_start + b * 2.8 + 1.4 + k
                pal.box((px, y, lv + 0.08), (1.2, 0.8, 0.14))
                car.box((px, y, lv + 0.15 + 0.45), (1.1, 0.75, 0.9 - 0.15 * ((b + li) % 3)))
    storage += [up.done(), beam.done(), pal.done(), car.done()]
static += storage
stage("storage", f"{RACKS} 排货架（{len(levels)} 层托盘位）", storage)

# ---------------------------------------------------------------- 7 logistics (moving: excluded from layout BVH)
movers = []
aisle_mid = (FENCE_Y + RACK_Y) / 2
for a in range(AGVS):
    body = box(f"AGV {a + 1}", (0, 0, 0.18), (1.25, 0.82, 0.3), M["agv"])
    box(f"AGV {a + 1} deck", (0, 0, 0.17), (1.2, 0.78, 0.04), M["agv_top"], body)
    cyl(f"AGV {a + 1} lidar", (0.55, 0, 0.24), 0.06, 0.1, M["camera"], body)
    cyl(f"AGV {a + 1} beacon", (-0.5, 0.3, 0.32), 0.04, 0.12, M["beacon"], body)
    box(f"AGV {a + 1} load", (0, 0, 0.44), (1.0, 0.7, 0.5), M["carton"], body)
    span = LINE_LEN / 2 + 2
    lane = aisle_mid + (0.35 if a % 2 else -0.35)
    start = -span + (a * 2 * span / max(AGVS, 1))
    for f, x in ((1, start), (120, -start if abs(start) > 1 else span), (240, start)):
        body.location = (x, lane, 0.18)
        body.keyframe_insert("location", frame=f)
    movers.append(body)
cartons = []
for c in range(N * 2):
    carton = box(f"Line carton {c + 1}", (0, 0, 1.05), (0.42, 0.34, 0.26), M["carton"])
    x0 = -LINE_LEN / 2 - 0.8 + c * (LINE_LEN + 1.6) / (N * 2)
    for f, dx in ((1, 0), (240, LINE_LEN / 2)):
        carton.location = (x0 + dx if x0 + dx < LINE_LEN / 2 + 0.8 else x0 + dx - LINE_LEN - 1.6, 0, 1.05) if f == 240 else (x0, 0, 1.05)
        carton.keyframe_insert("location", frame=f)
    cartons.append(carton)
rails = Batch("Crane runway", M["crane"]).box((cx, hy0 + 0.7, 7.2), (hx1 - hx0, 0.3, 0.4)).box((cx, hy1 - 0.7, 7.2), (hx1 - hx0, 0.3, 0.4)).done()
bridge = box("Crane bridge", (0, cy, 7.55), (0.6, hy1 - hy0 - 1.2, 0.6), M["crane"])
box("Crane hoist", (0, -1.0, -0.6), (0.7, 0.9, 0.6), M["steel"], bridge)
for f, x in ((1, hx0 + 4), (120, hx1 - 4), (240, hx0 + 4)):
    bridge.location = (x, cy, 7.55)
    bridge.keyframe_insert("location", frame=f)
scene.frame_set(1)
for action in bpy.data.actions:
    for fc in getattr(action, "fcurves", []):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR" if action.name.startswith(("AGV", "Line carton", "Crane")) else "BEZIER"
stage("logistics", f"{AGVS} 台 AGV、输送线物料、桥式起重机（动画）", [*movers, *cartons, rails, bridge])

# ---------------------------------------------------------------- 8 sensing and lighting
gantry = Batch("Camera gantry", M["steel"]).box((0, CAM_Y, CAM_H + 0.25), (LINE_LEN + 1, 0.16, 0.16))
for x in [-LINE_LEN / 2 + k * (LINE_LEN / 3) for k in range(4)]:
    gantry.box((x, CAM_Y, (CAM_H + 0.25 + ROOF) / 2), (0.06, 0.06, ROOF - CAM_H - 0.25))
gantry_obj = gantry.done()
cams, cam_objs = [], []
for i, t in enumerate(targets):
    origin = Vector((t.location.x, CAM_Y, CAM_H))
    housing = box(f"Station {i + 1} camera", (origin.x, origin.y, origin.z + 0.08), (0.18, 0.22, 0.14), M["camera"])
    cams.append(origin); cam_objs.append(housing)
lamps = Batch("High-bay LED panels", M["lamp"])
for x in col_x[:-1]:
    for y in (-1.0, aisle_mid, RACK_Y + RACKS * 0.7):
        lamps.box((x + 3, y, ROOF - 0.5), (1.2, 0.45, 0.06))
lamp_obj = lamps.done()
static += [gantry_obj]
stage("sensing", f"{N} 台检测相机（龙门 {CAM_H:.1f} m）与高棚灯", [gantry_obj, *cam_objs, lamp_obj])


# ---------------------------------------------------------------- measurements on static geometry (frame 1 pose)
def bvh(objects):
    verts, polys, owner = [], [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        ev = obj.evaluated_get(depsgraph)
        mesh = ev.to_mesh()
        mw = ev.matrix_world
        base = len(verts)
        verts += [mw @ v.co for v in mesh.vertices]
        for p in mesh.polygons:
            polys.append([base + k for k in p.vertices]); owner.append(obj.name)
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys), owner


scene.frame_set(1)
bpy.context.view_layer.update()
world_tree, world_owner = bvh(static + targets)
fence_tree, _ = bvh(fences)

area = (hx1 - hx0) * (hy1 - hy0)
widths = []
for k in range(41):
    x = -LINE_LEN / 2 + 0.5 + k * (LINE_LEN - 1.0) / 40
    for z in (0.35, 1.0, 1.7):
        o = Vector((x, aisle_mid, z))
        up = world_tree.ray_cast(o, Vector((0, 1, 0)), 30)[3]
        dn = world_tree.ray_cast(o, Vector((0, -1, 0)), 30)[3]
        widths.append(((up or 30) + (dn or 30), x, z))
aisle_min = min(widths)
guard_min = []
for i in range(N):
    o = Vector((X0 + i * PITCH, ROBOT_Y, 1.0))
    d = min((fence_tree.ray_cast(o, Vector((math.cos(a), math.sin(a), 0)), 20)[3] or 20) for a in [k * math.pi / 18 for k in range(36)]
            if math.sin(a) > -0.25)   # the open conveyor side is bounded by the line itself
    guard_min.append(d - REACH)
rays, covered = [], 0
cam_data = bpy.data.cameras.new("Inspection lens"); cam_data.lens = 20
for i, (origin, t) in enumerate(zip(cams, targets)):
    target = t.location.copy()
    direction = (target - origin).normalized()
    loc, normal, index, dist = world_tree.ray_cast(origin, direction, 50)
    first = world_owner[index] if index is not None else None
    probe = bpy.data.objects.new(f"probe {i}", cam_data); scene.collection.objects.link(probe)
    probe.location = origin; probe.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    s = world_to_camera_view(scene, probe, target)
    bpy.data.objects.remove(probe)
    ok = first == t.name and s.z > 0 and 0 <= s.x <= 1 and 0 <= s.y <= 1
    covered += ok
    rays.append({"station": i + 1, "origin": gltf(origin), "target": gltf(target), "hit": gltf(loc) if loc else None, "firstHit": first, "visible": ok})
exit_x = (hx0 + 0.07, hx1 - 0.07)
egress = max(min(abs(t.location.x - ex) for ex in exit_x) + abs(t.location.y - CAM_Y) for t in targets)
governing = next((r for r in rays if not r["visible"]), rays[len(rays) // 2])
event({"type": "ray", "origin": governing["origin"], "target": governing["target"], "hit": governing["hit"], "firstHit": governing["firstHit"], "visible": governing["visible"]})
checks = [
    {"id": "footprint-area", "passed": area <= req["maxFootprintArea"] + 1e-9, "observed": round(area, 1), "required": req["maxFootprintArea"], "unit": "m2",
     "method": "Hall floor bounding area"},
    {"id": "aisle-clearance", "passed": aisle_min[0] + 1e-9 >= req["minAisleWidth"], "observed": round(aisle_min[0], 3), "required": req["minAisleWidth"], "unit": "m",
     "at": {"x": round(aisle_min[1], 2), "z": aisle_min[2]}, "method": "BVH ray casts across the AGV aisle at 41 stations × 3 heights; moving equipment excluded"},
    {"id": "guard-clearance", "passed": min(guard_min) + 1e-9 >= req["minGuardClearance"], "observed": round(min(guard_min), 3), "required": req["minGuardClearance"], "unit": "m",
     "perRobot": [round(g, 3) for g in guard_min], "method": f"36 horizontal rays from each robot base to the guard; minus declared reach envelope {REACH} m (not joint-limit reachability)"},
    {"id": "camera-coverage", "passed": covered == N or not req["requireCameraCoverage"], "observed": covered, "required": N if req["requireCameraCoverage"] else 0, "unit": "stations",
     "rays": rays, "method": "First BVH hit of each inspection-camera ray is the station workpiece, and the workpiece projects into the camera frustum"},
    {"id": "egress-travel", "passed": egress <= req["maxEgressTravel"] + 1e-9, "observed": round(egress, 2), "required": req["maxEgressTravel"], "unit": "m",
     "method": "Longest rectilinear travel from a station along the aisle to the nearer exit door"},
]

# ---------------------------------------------------------------- world, render, artifacts
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
sky = world.node_tree.nodes.new("ShaderNodeTexSky")
try:
    sky.sky_type = "MULTIPLE_SCATTERING"
except TypeError:
    sky.sky_type = "NISHITA"
sky.sun_elevation, sky.sun_rotation = math.radians(32), math.radians(205)
world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.25
sun_data = bpy.data.lights.new("Sun", "SUN"); sun_data.energy = 2.2; sun_data.angle = math.radians(1.5)
sun = bpy.data.objects.new("Sun", sun_data); scene.collection.objects.link(sun); sun.rotation_euler = (math.radians(55), 0, math.radians(205))
for x in col_x[1:-1:2]:
    ld = bpy.data.lights.new(f"Bay light {x:.0f}", "AREA"); ld.energy = 500; ld.shape = "RECTANGLE"; ld.size, ld.size_y = 4.0, 6.0
    lo = bpy.data.objects.new(ld.name, ld); scene.collection.objects.link(lo); lo.location = (x + 3, (FENCE_Y + 0.0) / 2, ROOF - 0.7)
cam = bpy.data.objects.new("Hero camera", bpy.data.cameras.new("Hero lens"))
scene.collection.objects.link(cam)
cam.data.lens = 17
cam.location = (hx1 - 1.2, hy0 + 0.9, 6.6)
look = Vector((cx - 5.0, 3.2, 0.2))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
scene.render.engine = "CYCLES"
use_render_device(scene)
scene.cycles.samples = 16 if hero else 12
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.render.threads_mode = "FIXED"; scene.render.threads = 4
scene.render.resolution_x, scene.render.resolution_y = (960, 540) if hero else (640, 360)
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = -0.6
scene["pai_scope"] = "generated factory layout; synthetic explicit recipe; illustrative kinematics; no physics or certification"
scene["pai_layout"] = json.dumps(L, sort_keys=True)
scene["pai_requirements"] = json.dumps(req, sort_keys=True)
bpy.ops.export_scene.gltf(filepath=str(out / "scene.glb"), export_format="GLB", export_animations=True, export_apply=False)
# Roof with skylight strips: in the .blend and renders only, so the interactive viewport can look inside.
roof = Batch("Roof panels (render only)", M["clad"])
for i, x in enumerate(col_x[:-1]):
    roof.box((x + 1.5, cy, ROOF + 0.55), (3.0, hy1 - hy0, 0.08)).box((x + 5.1, cy, ROOF + 0.55), (1.8, hy1 - hy0, 0.08))
roof.done()
shell = Batch("Front and side cladding (render only)", M["clad"])
shell.box((cx, hy0, 5.6), (hx1 - hx0, 0.12, 6.8)).box((hx1, cy, 5.6), (0.12, hy1 - hy0, 6.8))
shell.done()
Batch("Hall apron (render only)", M["floor"]).box((cx, cy, -0.25), (200, 200, 0.1)).done()
bpy.ops.wm.save_as_mainfile(filepath=str(out / "scene.blend"))
last = [-1]


def progress(text):
    m = re.search(r"Sample (\d+)/(\d+)", text or "")
    if m and int(m.group(1)) != last[0]:
        last[0] = int(m.group(1))
        event({"type": "render", "sample": int(m.group(1)), "samples": int(m.group(2))})


bpy.app.handlers.render_stats.append(progress)
scene.render.filepath = str(out / "preview.png")
bpy.ops.render.render(write_still=True)
# Inspection view: what the governing station camera actually sees.
icam = bpy.data.objects.new("Inspection view", bpy.data.cameras.new("Inspection view lens"))
scene.collection.objects.link(icam)
icam.data.lens = 20
station = governing["station"] - 1
icam.location = cams[station]
icam.rotation_euler = (targets[station].location - cams[station]).to_track_quat("-Z", "Y").to_euler()
scene.camera = icam
scene.cycles.samples = 10
scene.render.resolution_x, scene.render.resolution_y = 480, 300
scene.render.filepath = str(out / "inspection.png")
bpy.ops.render.render(write_still=True)
bpy.app.handlers.render_stats.remove(progress)
result = {
    "schema": "pai-blender-plant-checks-1", "blenderVersion": bpy.app.version_string, "variant": spec["variant"], "units": "metres",
    "layout": L, "derived": {"lineLength": LINE_LEN, "hall": [round(hx1 - hx0, 2), round(hy1 - hy0, 2)], "fenceY": FENCE_Y, "rackFaceY": RACK_Y,
                             "cameraY": CAM_Y, "reachEnvelope": REACH, "objects": len(scene.objects), "animatedObjects": len(movers) + len(cartons) + 1 + 4 * N},
    "checks": checks, "scope": "generated-static-geometry", "physicalValidation": False,
    "dimensionsSource": "Synthetic explicit factory recipe; not a measured plant",
}
(out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"variant": spec["variant"], "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
