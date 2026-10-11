"""Controlled native scene recipe and geometry checks. No user Python/Blend uploads.

Emits one `PAI_EVENT {json}` stdout line per construction stage, the native ray result and
Cycles sample progress. Staged GLBs are presentation snapshots of the same native scene; the
authoritative artifacts remain scene.blend, scene.glb, preview.png and checks.json.
"""
import argparse
import json
import math
from pathlib import Path
import re
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_gpu import use_render_device  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
spec = json.loads(Path(args.input).read_text())
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
(output / "stages").mkdir(exist_ok=True)
stage_index = [0]


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


def gltf(v):
    """Blender Z-up world coordinates to glTF/three.js Y-up coordinates."""
    return [round(float(v[0]), 5), round(float(v[2]), 5), round(float(-v[1]), 5)]


def stage(stage_id, label, objects):
    stage_index[0] += 1
    name = f"{stage_index[0]:02d}-{stage_id}.glb"
    bpy.ops.export_scene.gltf(filepath=str(output / "stages" / name), export_format="GLB")
    event({"type": "stage", "index": stage_index[0], "id": stage_id, "label": label,
           "file": "stages/" + name, "objects": [o.name for o in objects]})


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0


def material(name, color, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = (*color, 1)
    node.inputs["Metallic"].default_value = metallic
    node.inputs["Roughness"].default_value = 0.45
    return mat


steel = material("Steel", (0.13, 0.23, 0.28), 0.6)
green = material("Robot teal", (0.12, 0.48, 0.38), 0.35)
floor_mat = material("Floor", (0.38, 0.46, 0.43))
target_mat = material("Target orange", (0.95, 0.34, 0.11))
wall_mat = material("Occluder", (0.55, 0.63, 0.6))


def box(name, location, dimensions, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


floor = box("Workcell footprint", (0, 0, -0.08), (4, 3, 0.16), floor_mat)
stage("footprint", "工作单元占地 4m × 3m", [floor])
robot = [box("Robot pedestal", (-0.6, 0, 0.35), (0.6, 0.6, 0.7), steel),
         box("Robot column illustration", (-0.6, 0, 0.95), (0.23, 0.23, 0.55), green),
         box("Robot arm illustration", (-0.1, 0, 1.22), (1.12, 0.18, 0.18), green)]
stage("robot", "机器人示意（非 URDF/关节模型）", robot)
table = box("Work table", (0.6, 0, 0.4), (1.0, 0.8, 0.8), steel)
target = box("Target", (0.6, 0, 0.95), (0.22, 0.22, 0.3), target_mat)
stage("fixtures", "工作台与目标", [table, target])
camera_location = Vector((3.6, -4.8, 3.4))
target_point = target.location.copy()
if spec["variant"] == "occluded":
    middle = camera_location.lerp(target_point, 0.48)
    stage("occluder", "候选布局中的遮挡物", [box("Visibility obstruction", middle, (1.8, 0.45, 1.9), wall_mat)])

bpy.ops.object.camera_add(location=camera_location)
camera = bpy.context.object
camera.name = "Inspection camera"
camera.rotation_euler = (target_point - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 38
scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(2, -3, 6))
key = bpy.context.object
key.data.energy = 1000
key.data.shape = "DISK"
key.data.size = 5
scene.world.color = (0.35, 0.35, 0.35)
scene.render.engine = "CYCLES"
use_render_device(scene)
scene.cycles.samples = 12
scene.render.threads_mode = "FIXED"
scene.render.threads = 4
scene.render.resolution_x = 640
scene.render.resolution_y = 400
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "AgX"
bpy.context.view_layer.update()

depsgraph = bpy.context.evaluated_depsgraph_get()
direction = (target_point - camera.location).normalized()
hit, location, normal, index, obj, matrix = scene.ray_cast(depsgraph, camera.location, direction)
screen = world_to_camera_view(scene, camera, target_point)
visible = bool(hit and obj and obj.name == target.name and screen.z > 0 and 0 <= screen.x <= 1 and 0 <= screen.y <= 1)
event({"type": "ray", "origin": gltf(camera.location), "target": gltf(target_point),
       "hit": gltf(location) if hit else None, "firstHit": obj.name if hit and obj else None, "visible": visible})
area = float(floor.dimensions.x * floor.dimensions.y)
distance = math.dist((-0.6, 0), (target.location.x, target.location.y))
requirements = spec["requirements"]
checks = [
    {"id": "footprint-area", "passed": area <= requirements["maxFootprintArea"] + 1e-8,
     "observed": area, "required": requirements["maxFootprintArea"], "unit": "m2"},
    {"id": "declared-target-envelope", "passed": distance <= requirements["targetEnvelopeRadius"] + 1e-8,
     "observed": distance, "required": requirements["targetEnvelopeRadius"], "unit": "m",
     "scope": "Declared static envelope only; not joint reachability or path planning"},
    {"id": "camera-visibility", "passed": visible or not requirements["requireTargetVisible"],
     "observed": visible, "required": requirements["requireTargetVisible"],
     "firstHit": obj.name if hit and obj else None, "method": "Native Blender ray cast and camera projection"},
]
scene["pai_scope"] = "generated-static-geometry; synthetic recipe; no dynamics or physical validation"
scene["pai_requirements"] = json.dumps(requirements, sort_keys=True)
bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"))
bpy.ops.export_scene.gltf(filepath=str(output / "scene.glb"), export_format="GLB")
scene.render.filepath = str(output / "preview.png")
last_sample = [-1]


def render_progress(text):
    match = re.search(r"Sample (\d+)/(\d+)", text or "")
    if match and int(match.group(1)) != last_sample[0]:
        last_sample[0] = int(match.group(1))
        event({"type": "render", "sample": int(match.group(1)), "samples": int(match.group(2))})


bpy.app.handlers.render_stats.append(render_progress)
bpy.ops.render.render(write_still=True)
bpy.app.handlers.render_stats.remove(render_progress)
result = {
    "schema": "pai-blender-checks-1", "blenderVersion": bpy.app.version_string,
    "variant": spec["variant"], "units": "metres", "checks": checks,
    "scope": "generated-static-geometry", "physicalValidation": False,
    "dimensionsSource": "Synthetic explicit workcell recipe; not a measured factory",
}
(output / "checks.json").write_text(json.dumps(result, indent=2) + "\n")
