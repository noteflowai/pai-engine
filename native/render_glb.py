"""Render a result GLB (e.g. FEA von Mises vertex colours) to a PNG for visual review, with native Blender.

    blender --background --factory-startup --python render_glb.py -- --input fea.glb --output fea.png [--title "..."]

Cycles (CPU), the GLB's own vertex colours (COLOR_0) as unlit emission, so the image shows the solver's field and
nothing invented. Two views (isometric and front) side by side. The colour scale is
not drawn: it lives in the result JSON (e.g. fea.json colorScaleMaxMPa), which the reviewer receives as text.
Deterministic: fixed resolution, camera from the bounding box, fixed sample count and seed.
"""
import json, sys
from pathlib import Path
import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_gpu import use_render_device  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
args = {argv[i].lstrip("-"): argv[i + 1] for i in range(0, len(argv) - 1, 2)}
src, out = Path(args["input"]), Path(args["output"])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(src))
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not objs:
    raise SystemExit("no mesh in GLB")
pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre, size = (lo + hi) / 2, max((hi - lo).length, 1e-6)
scene = bpy.context.scene
# Cycles (headless: no GPU context for Workbench/EEVEE); on the GPU when the runtime offers one, else the CPU. Each mesh shows its COLOR_0 as pure
# emission: the pixel is the solver's colour, unlit and unshaded; Freestyle draws the silhouette for shape.
scene.render.engine = "CYCLES"
scene.cycles.samples, scene.cycles.use_denoising = 16, False
use_render_device(scene)
for o in objs:
    mat = bpy.data.materials.new("field"); mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    attr, emit, output = nodes.new("ShaderNodeVertexColor"), nodes.new("ShaderNodeEmission"), nodes.new("ShaderNodeOutputMaterial")
    attr.layer_name = o.data.color_attributes[0].name if o.data.color_attributes else ""
    links.new(attr.outputs["Color"], emit.inputs["Color"]); links.new(emit.outputs["Emission"], output.inputs["Surface"])
    o.data.materials.clear(); o.data.materials.append(mat)
scene.render.use_freestyle = True
scene.render.line_thickness_mode, scene.render.line_thickness = "ABSOLUTE", 1.0
lineset = scene.view_layers[0].freestyle_settings.linesets.new("outline")
lineset.select_by_visibility, lineset.select_silhouette, lineset.select_border, lineset.select_crease = True, True, True, True
lineset.linestyle = bpy.data.linestyles.new("outline")
lineset.linestyle.color, lineset.linestyle.thickness = (0.15, 0.15, 0.15), 1.0
scene.world = bpy.data.worlds.new("bg"); scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
# Standard view transform: the vertex colours are the solver's colour map and must not be tone-mapped.
scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
scene.render.resolution_x, scene.render.resolution_y = 640, 480
scene.render.image_settings.file_format = "PNG"
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam); scene.camera = cam
cam.data.type, cam.data.ortho_scale = "ORTHO", size * 1.15
frames = []
for name, direction in (("iso", Vector((1, -1, 0.8))), ("front", Vector((0, -1, 0)))):
    d = direction.normalized()
    cam.location = centre + d * size * 3
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    path = out.with_name(f"{out.stem}-{name}.png")
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    frames.append(path)
# Side by side into one PNG.
images = [bpy.data.images.load(str(p)) for p in frames]
w, h = images[0].size
combo = bpy.data.images.new("combo", w * len(images), h)
pixels = [0.0] * (w * len(images) * h * 4)
for k, im in enumerate(images):
    px = list(im.pixels)
    for row in range(h):
        dst = (row * w * len(images) + k * w) * 4
        pixels[dst:dst + w * 4] = px[row * w * 4:(row + 1) * w * 4]
combo.pixels = pixels
combo.filepath_raw, combo.file_format = str(out), "PNG"
combo.save()
for p in frames:
    p.unlink()
print(json.dumps({"output": str(out), "views": ["iso", "front"], "size": [w * len(images), h], "objects": len(objs)}))
