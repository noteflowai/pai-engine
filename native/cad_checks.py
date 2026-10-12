"""Shared native B-Rep checks for NEMA 17 motor-mount brackets (preset recipe and generated code).

Frame contract: millimetres; the motor mounting face is the plane y = 0 with the motor body in y < 0;
the motor axis is parallel to Y through (x = 0, z = motor_axis_z); base fastener holes are vertical (Z).
Every value is measured on the solid. Arbitrary geometry yields failed checks, never a crash.
"""
import importlib.metadata
import json

import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN
from OCP.BRepAdaptor import BRepAdaptor_Surface  # a face's own cylinder, also on trimmed surfaces

NEMA_PITCH, M3_CLEAR = 31.0, 3.4          # NEMA 17 bolt square; ISO 273 medium clearance
DENSITY = 2.70e-3                          # 6061 aluminium, g/mm³
AL, MOTOR = (0.62, 0.67, 0.72), (0.34, 0.37, 0.4)
MAX_PLANAR, MAX_CYLINDRICAL = 160, 80      # bounded pairwise wall search


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True, ensure_ascii=False), flush=True)


class Stages:
    def __init__(self, out):
        self.out, self.index = out, 0
        (out / "stages").mkdir(parents=True, exist_ok=True)

    def __call__(self, stage_id, label, items):
        self.index += 1
        name = f"{self.index:02d}-{stage_id}.glb"
        assy = cq.Assembly()
        for n, shape, color in items:
            assy.add(shape, name=n, color=cq.Color(*color))
        assy.export(str(self.out / "stages" / name))
        event({"type": "stage", "index": self.index, "id": stage_id, "label": label, "file": "stages/" + name, "objects": [n for n, _, _ in items]})


def motor(zc):
    """NEMA 17 envelope: 42.3 mm body, Ø22 × 2 mm pilot boss and Ø5 shaft on the mounting face (y = 0)."""
    return (cq.Workplane("XZ").center(0, zc).rect(42.3, 42.3).extrude(40.0)
            .union(cq.Workplane("XZ").center(0, zc).circle(11.0).extrude(-2.0))
            .union(cq.Workplane("XZ").center(0, zc).circle(2.5).extrude(-24.0)))


def _distance(a, b):
    d = BRepExtrema_DistShapeShape(a, b)
    d.Perform()
    return d.Value()


def _solutions(a, b):
    d = BRepExtrema_DistShapeShape(a, b)
    d.Perform()
    return d.Value(), [(d.PointOnShape1(k), d.PointOnShape2(k)) for k in range(1, d.NbSolution() + 1)]


def measure(part, zc, req):
    """Return (checks, volume, mass, size) for a solid against frozen requirements and the motor frame."""
    def inside(p):
        return BRepClass3d_SolidClassifier(part.wrapped, p, 1e-6).State() == TopAbs_IN

    def material_between(p1, p2):
        """Closest points often lie on edges, so the midpoint can be ON a boundary; probe 0.05 mm around it."""
        mid = gp_Pnt((p1.X() + p2.X()) / 2, (p1.Y() + p2.Y()) / 2, (p1.Z() + p2.Z()) / 2)
        if inside(mid):
            return True
        offsets = [(0.05, 0, 0), (-0.05, 0, 0), (0, 0.05, 0), (0, -0.05, 0), (0, 0, 0.05), (0, 0, -0.05)]
        return any(inside(gp_Pnt(mid.X() + a, mid.Y() + b, mid.Z() + c)) for a, b, c in offsets)

    # Holes: cylindrical faces grouped by axis and centre (seam-split faces merge).
    holes = {}
    for f in part.Faces():
        if f.geomType() != "CYLINDER":
            continue
        cyl = BRepAdaptor_Surface(f.wrapped).Cylinder()
        loc, direction = cyl.Axis().Location(), cyl.Axis().Direction()
        axis = "y" if abs(direction.Y()) > 0.99 else "z" if abs(direction.Z()) > 0.99 else "other"
        key = (axis, round(loc.X(), 3), round(loc.Z(), 3) if axis == "y" else round(loc.Y(), 3))
        holes.setdefault(key, {"axis": axis, "d": round(2 * cyl.Radius(), 4), "centre": [key[1], key[2]], "faces": []})["faces"].append(f)
    plate_holes = [h for h in holes.values() if h["axis"] == "y"]
    base_holes = [h for h in holes.values() if h["axis"] == "z"]
    planar = [f for f in part.Faces() if f.geomType() == "PLANE"]
    fronts = [f for f in planar if f.normalAt().y < -0.999]
    bottoms = [f for f in planar if f.normalAt().z < -0.999]
    front = max(fronts, key=lambda f: f.Area()) if fronts else None
    bottom = max(bottoms, key=lambda f: f.Area()) if bottoms else None

    if plate_holes:
        bore = max(plate_holes, key=lambda h: h["d"])
        bolts = [h for h in plate_holes if h is not bore]
        pitches = sorted({round(abs(b["centre"][0] - bore["centre"][0]) * 2, 3) for b in bolts}
                         | {round(abs(b["centre"][1] - bore["centre"][1]) * 2, 3) for b in bolts})
        offset = round(((bore["centre"][0]) ** 2 + (bore["centre"][1] - zc) ** 2) ** 0.5, 3)
    else:
        bore, bolts, pitches, offset = None, [], [], None
    face_y = round(front.Center().y, 3) if front else None
    interface_ok = (bore is not None and bore["d"] >= 22.2 and len(bolts) == 4 and all(abs(b["d"] - M3_CLEAR) <= 0.1 for b in bolts)
                    and all(abs(p - NEMA_PITCH) <= 0.1 for p in pitches) and offset <= 0.1 and face_y is not None and abs(face_y) <= 0.05)

    # Edge distance: fastener hole centre to the outer boundary of its planar mounting face.
    edge_rows = []
    for h, face_ in [(h, front) for h in bolts] + [(h, bottom) for h in base_holes]:
        if face_ is None:
            edge_rows.append({"d": h["d"], "centre": h["centre"], "edgeDistance": 0.0, "required": round(req["edgeDistanceFactor"] * h["d"], 3), "note": "no mounting face"})
            continue
        x, second = h["centre"]
        point = gp_Pnt(x, face_y or 0.0, second) if h["axis"] == "y" else gp_Pnt(x, second, bottom.Center().z)
        e = _distance(BRepBuilderAPI_MakeVertex(point).Vertex(), BRepTools.OuterWire_s(face_.wrapped))
        edge_rows.append({"d": h["d"], "centre": h["centre"], "edgeDistance": round(e, 3), "required": round(req["edgeDistanceFactor"] * h["d"], 3)})
    edge_ok = bool(edge_rows) and all(r["edgeDistance"] + 1e-6 >= r["required"] for r in edge_rows)
    worst_edge = min(edge_rows, key=lambda r: r["edgeDistance"] - r["required"]) if edge_rows else {"edgeDistance": None, "required": None}

    # Wall thickness: opposite-normal planar pairs and hole-to-hole ligaments with material between them.
    cylinders = [f for h in holes.values() for f in h["faces"]]
    walls, bounded = [], len(planar) <= MAX_PLANAR and len(cylinders) <= MAX_CYLINDRICAL
    if bounded:
        for i, a in enumerate(planar):
            na = a.normalAt()
            for b in planar[i + 1:]:
                if na.dot(b.normalAt()) > -0.999:
                    continue
                value, pairs = _solutions(a.wrapped, b.wrapped)
                if value > 1e-6 and any(material_between(p1, p2) for p1, p2 in pairs):
                    walls.append(("plate", value))
        for i, a in enumerate(cylinders):
            for b in cylinders[i + 1:]:
                value, pairs = _solutions(a.wrapped, b.wrapped)
                if value > 1e-6 and any(material_between(p1, p2) for p1, p2 in pairs):
                    walls.append(("ligament", value))
    min_wall = min(walls, key=lambda w: w[1]) if walls else None

    common = cq.Shape.cast(BRepAlgoAPI_Common(part.wrapped, motor(zc).val().wrapped).Shape())
    interference = max(0.0, common.Volume())
    volume = part.Volume()
    mass = volume * DENSITY
    # Staged GLB exports populate triangulations. Default CadQuery bounds may then
    # include mesh margins; acceptance must use the underlying geometric entities.
    bb = Bnd_Box()
    BRepBndLib.AddOptimal_s(part.wrapped, bb, False, False)
    bounds = bb.Get()
    size = [round(bounds[i + 3] - bounds[i], 3) for i in range(3)]
    valid = BRepCheck_Analyzer(part.wrapped).IsValid() and len(part.Solids()) == 1
    event({"type": "measure", "mass": round(mass, 2), "minWall": round(min_wall[1], 3) if min_wall else None, "interference": round(interference, 3)})

    wall_method = (f"Minimum over opposite planar faces and hole ligaments with material between; governing: {min_wall[0]}" if min_wall
                   else "No opposed walls found" if bounded else f"Too many faces for the bounded search (planar ≤ {MAX_PLANAR}, cylindrical ≤ {MAX_CYLINDRICAL})")
    checks = [
        {"id": "solid-valid", "passed": bool(valid), "observed": len(part.Solids()), "required": 1, "unit": "solid", "method": "OCCT BRepCheck_Analyzer; single closed solid"},
        {"id": "nema17-interface", "passed": bool(interface_ok),
         "observed": {"pilotBore": bore["d"] if bore else None, "boltHoles": [b["d"] for b in bolts], "pitch": pitches, "axisOffset": offset, "mountingFaceY": face_y},
         "required": {"pilotBoreMin": 22.2, "boltHole": M3_CLEAR, "pitch": NEMA_PITCH, "axisOffsetMax": 0.1, "mountingFaceY": 0},
         "unit": "mm", "method": "Cylindrical faces measured from the B-Rep; bore coaxial with the motor axis; mounting face on y = 0"},
        {"id": "motor-interference", "passed": interference <= 1e-6 or not req["requireNoInterference"], "observed": round(interference, 3), "required": 0, "unit": "mm3",
         "method": "Boolean common with NEMA 17 body, Ø22 pilot boss and Ø5 shaft"},
        {"id": "min-wall", "passed": bool(min_wall) and min_wall[1] + 1e-6 >= req["minWallMm"], "observed": round(min_wall[1], 3) if min_wall else None,
         "required": req["minWallMm"], "unit": "mm", "method": wall_method},
        {"id": "hole-edge-distance", "passed": edge_ok, "observed": worst_edge["edgeDistance"], "required": worst_edge["required"], "unit": "mm",
         "method": f"Hole centre to outer boundary of its mounting face ≥ {req['edgeDistanceFactor']} × d (DFM rule of thumb)", "holes": edge_rows},
        {"id": "mass", "passed": mass <= req["maxMassG"] + 1e-9, "observed": round(mass, 2), "required": req["maxMassG"], "unit": "g", "method": "B-Rep volume × 6061 aluminium 2.70 g/cm³"},
        {"id": "envelope", "passed": all(s <= m + 1e-6 for s, m in zip(size, req["maxEnvelopeMm"])), "observed": size, "required": req["maxEnvelopeMm"], "unit": "mm",
         "method": "OCCT AddOptimal axis-aligned bounds; triangulation and shape-tolerance enlargement disabled"},
    ]
    return checks, volume, mass, size


def export(body, zc, out):
    cq.exporters.export(body, str(out / "part.step"))
    cq.exporters.export(body, str(out / "part.stl"), tolerance=0.02, angularTolerance=0.1)
    cq.Assembly().add(body, name="Bracket", color=cq.Color(*AL)).export(str(out / "part.glb"))
    (cq.Assembly().add(body, name="Bracket", color=cq.Color(*AL)).add(motor(zc), name="NEMA 17 motor", color=cq.Color(*MOTOR))
     .export(str(out / "assembly.glb")))
    cq.exporters.export(body, str(out / "drawing.svg"), opt={"projectionDir": (1.2, -1.0, 0.9), "showHidden": True, "strokeWidth": 0.25,
                                                            "strokeColor": (30, 60, 70), "hiddenColor": (150, 170, 175), "width": 640, "height": 400})


def versions():
    return {"cadquery": cq.__version__, "ocp": importlib.metadata.version("cadquery-ocp")}
