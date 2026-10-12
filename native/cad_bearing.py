"""Second part family: pillow-block bearing housing for a 6202 deep-groove ball bearing (CadQuery recipe + B-Rep checks).

    PAI_CADQUERY_PYTHON cad_bearing.py --input input.json --output DIR

Frame contract: millimetres; the base bottom is z = 0, the shaft axis is parallel to Y through (x = 0, z = axisHeight);
the bearing seat opens on the +Y face (the bearing is pressed in from +Y against a shoulder at the -Y side); the two
base bolt holes are vertical (Z), on the X axis. Every value below is measured on the solid, not taken from the recipe.

Checks (pai-cad-checks-1, family "pillow-block"):
  solid-valid           OCCT BRepCheck, one closed solid
  bearing-seat          seat Ø within H7 for the bearing OD (35.000-35.025), coaxial with the axis, seat length ≥ B
  shoulder              shoulder (stop) Ø ≤ D - 2·(outer-ring abutment), shaft passage Ø ≥ shaft + clearance
  min-wall              thinnest material around the bearing seat (seat cylinder to every outer face) ≥ minWallMm
  hole-edge-distance    base bolt hole centre to the outer boundary of the base bottom ≥ factor × d
  mass                  B-Rep volume × 6061 density ≤ maxMassG
  envelope              axis-aligned optimal bounds ≤ maxEnvelopeMm
Scope: nominal geometry; no fit/tolerance stack-up, bearing life, FEA or physical test.
"""
import argparse, json, sys
from pathlib import Path

import cadquery as cq
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import AL, DENSITY, Stages, versions  # noqa: E402
from OCP.BRepAdaptor import BRepAdaptor_Surface  # a face's own cylinder, also on trimmed surfaces

BEARING = {"designation": "6202", "d": 15.0, "D": 35.0, "B": 11.0, "abutment": 1.6}   # ISO 15 / ISO 355 abutment (r_as)
H7 = (0.0, 0.025)                                  # ISO 286 H7 for 30-50 mm
GUSSET = 5.0                                     # 45° gusset leg between column and base
SHAFT_CLEARANCE = 2.0                              # passage Ø ≥ d + 2 mm (non-contact seal / labyrinth gap)
BOLT = {"thread": "M8", "clearance": 9.0}          # ISO 273 medium
BOUNDS = {"width": (60.0, 140.0), "depth": (14.0, 40.0), "baseDepth": (20.0, 60.0), "axisHeight": (22.0, 60.0), "baseThickness": (6.0, 20.0),
          "boltPitch": (40.0, 120.0), "seatDiameter": (34.9, 35.2), "shoulderDiameter": (17.0, 34.0)}
PRESETS = {
    "pillow-block": {"width": 108.0, "depth": 20.0, "baseDepth": 36.0, "axisHeight": 30.0, "baseThickness": 10.0, "boltPitch": 78.0, "seatDiameter": 35.012,
                     "shoulderDiameter": 28.0, "label": "6202 轴承座基准设计"},
    # Lighter: lower the axis to save material; the wall under the bearing becomes 30 - 17.5 = 12.5 → fine, but the
    # thinner top crown (block height = axis + 21) leaves only 3.5 mm over the seat.
    "pillow-block-light": {"width": 108.0, "depth": 20.0, "baseDepth": 36.0, "axisHeight": 30.0, "baseThickness": 10.0, "boltPitch": 78.0, "seatDiameter": 35.012,
                           "shoulderDiameter": 28.0, "crown": 3.5, "label": "轻量化：顶部壁厚 3.5 mm"},
    # Compact footprint: a shorter base with the bolts near its ends (edge distance below 1.5 d).
    "pillow-block-compact": {"width": 88.0, "depth": 20.0, "baseDepth": 36.0, "axisHeight": 30.0, "baseThickness": 10.0, "boltPitch": 76.0, "seatDiameter": 35.012,
                             "shoulderDiameter": 28.0, "label": "紧凑化：底座缩短到 76 mm"},
    # Seat machined to the bearing's nominal OD minus 0.05: an interference outside H7.
    "pillow-block-tight": {"width": 108.0, "depth": 20.0, "baseDepth": 36.0, "axisHeight": 30.0, "baseThickness": 10.0, "boltPitch": 78.0, "seatDiameter": 34.95,
                           "shoulderDiameter": 28.0, "label": "轴承孔 Ø34.95（超出 H7）"},
}


def checked(p):
    out = {}
    for key, (lo, hi) in BOUNDS.items():
        v = float(p[key])
        if not lo <= v <= hi:
            raise ValueError(f"{key} {v} outside [{lo}, {hi}]")
        out[key] = v
    out["crown"] = float(p.get("crown", 8.0))
    if not 2.0 <= out["crown"] <= 20.0:
        raise ValueError("crown outside [2, 20]")
    return out


def build(p, stage):
    """Base plate (baseDepth deep, for bolt edge distance) + a block around the seat (crown = material above the seat), seat from +Y, shoulder at -Y, 2 bolts."""
    p = checked(p)
    W, D, BD, h, t, pitch, seat, shoulder, crown = (p[k] for k in ("width", "depth", "baseDepth", "axisHeight", "baseThickness", "boltPitch", "seatDiameter", "shoulderDiameter", "crown"))
    R = seat / 2
    block_w = seat + 2 * 9.0
    base = cq.Workplane("XY").box(W, BD, t, centered=(True, True, False))
    stage("base", "底座", [("Housing", base, AL)])
    block = cq.Workplane("XY").box(block_w, D, h + R + crown, centered=(True, True, False))
    # Fillet blocks to the base: a 45° gusset on each side of the column (simple, millable from +Z).
    body = base.union(block)
    for sgn in (-1, 1):
        g = (cq.Workplane("XZ").polyline([(sgn * block_w / 2, t), (sgn * (block_w / 2 + GUSSET), t), (sgn * block_w / 2, t + GUSSET)]).close()
             .extrude(D / 2, both=True))
        body = body.union(g)
    stage("block", "轴承座本体", [("Housing", body, AL)])
    shoulder_len = D - BEARING["B"]
    # Workplane("XZ") has its normal along -Y: offset -D/2 is the +Y face, a positive extrude goes towards -Y.
    body = body.cut(cq.Workplane("XZ").workplane(offset=-D / 2).center(0, h).circle(R).extrude(BEARING["B"]))
    body = body.cut(cq.Workplane("XZ").workplane(offset=D / 2).center(0, h).circle(shoulder / 2).extrude(-(D + 1)))
    stage("seat", f"{BEARING['designation']} 轴承孔 Ø{seat} 与止口", [("Housing", body, AL)])
    for x in (-pitch / 2, pitch / 2):
        body = body.cut(cq.Workplane("XY").center(x, 0).circle(BOLT["clearance"] / 2).extrude(t))
    stage("bolts", f"2× {BOLT['thread']} 地脚螺栓孔", [("Housing", body, AL)])
    solids = body.solids().vals()
    part = solids[0] if len(solids) == 1 else body.val()
    return body, part, {**p, "shoulderLength": shoulder_len, "blockWidth": block_w}


def bearing(h, depth):
    """6202 envelope seated against the shoulder (for the assembly view)."""
    return (cq.Workplane("XZ").workplane(offset=-depth / 2).center(0, h).circle(BEARING["D"] / 2).circle(BEARING["d"] / 2)
            .extrude(BEARING["B"]))


def dist(a, b):
    d = BRepExtrema_DistShapeShape(a, b); d.Perform(); return d.Value()


def exact_box(shape):
    """Bounds of the exact B-Rep. cq's BoundingBox() uses AddOptimal with triangulation when a mesh exists, so after a
    GLB export it measured the tessellation (seat length 11.011 instead of 11.000); never use the mesh here."""
    from cadquery.occ_impl.geom import BoundBox
    bb = Bnd_Box(); BRepBndLib.AddOptimal_s(shape.wrapped, bb, False, False)
    return BoundBox(bb)


def measure(part, h, req):
    cyl = []
    for f in part.Faces():
        if f.geomType() == "CYLINDER":
            c = BRepAdaptor_Surface(f.wrapped).Cylinder(); ax = c.Axis(); dr, lo = ax.Direction(), ax.Location()
            axis = "y" if abs(dr.Y()) > 0.99 else "z" if abs(dr.Z()) > 0.99 else "other"
            cyl.append({"face": f, "axis": axis, "d": round(2 * c.Radius(), 4), "x": lo.X(), "y": lo.Y(), "z": lo.Z(), "bb": exact_box(f)})
    along = [c for c in cyl if c["axis"] == "y"]
    seat = max(along, key=lambda c: c["d"]) if along else None
    shoulder = min(along, key=lambda c: c["d"]) if len(along) > 1 else None
    bolts = [c for c in cyl if c["axis"] == "z"]
    lo_d, hi_d = BEARING["D"] + H7[0], BEARING["D"] + H7[1]
    seat_len = round(seat["bb"].ylen, 3) if seat else 0.0
    offset = round(((seat["x"]) ** 2 + (seat["z"] - h) ** 2) ** 0.5, 4) if seat else None
    seat_ok = bool(seat) and lo_d - 1e-6 <= seat["d"] <= hi_d + 1e-6 and seat_len + 1e-6 >= BEARING["B"] and offset is not None and offset <= 0.02
    max_shoulder = BEARING["D"] - 2 * BEARING["abutment"] * 2   # outer ring must bear on ≥ 2 r_as of shoulder land
    min_passage = BEARING["d"] + SHAFT_CLEARANCE
    shoulder_ok = bool(shoulder) and min_passage - 1e-6 <= shoulder["d"] <= max_shoulder + 1e-6
    # Wall around the seat: 72 radial rays from the shaft axis at mid-seat; on each, the material between the seat
    # surface and the first exit (OCCT line/shape intersection). Directions that never leave material within 200 mm
    # (towards the base) count their full run, so the governing value is the thinnest real wall.
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.gp import gp_Lin, gp_Dir
    import math as _m
    wall, wall_at = None, None
    if seat:
        ix = IntCurvesFace_ShapeIntersector(); ix.Load(part.wrapped, 1e-6)
        ymid = seat["bb"].ymin + seat["bb"].ylen / 2
        for k in range(72):
            a_ = 2 * _m.pi * k / 72; d_ = (_m.cos(a_), 0.0, _m.sin(a_))
            ix.Perform(gp_Lin(gp_Pnt(seat["x"], ymid, seat["z"]), gp_Dir(*d_)), 0.0, 200.0)
            ts = sorted(ix.WParameter(i) for i in range(1, ix.NbPnt() + 1))
            ts = [t_ for t_ in ts if t_ > seat["d"] / 2 - 0.01]
            if len(ts) >= 2:
                w = ts[1] - ts[0]
                if wall is None or w < wall:
                    wall, wall_at = w, round(_m.degrees(a_))
    bottoms = [f for f in part.Faces() if f.geomType() == "PLANE" and f.normalAt().z < -0.999]
    bottom = max(bottoms, key=lambda f: f.Area()) if bottoms else None
    edges = []
    for b in bolts:
        if bottom is None:
            edges.append({"d": b["d"], "centre": [round(b["x"], 3), round(b["y"], 3)], "edgeDistance": 0.0, "required": round(req["edgeDistanceFactor"] * b["d"], 3)}); continue
        e = dist(BRepBuilderAPI_MakeVertex(gp_Pnt(b["x"], b["y"], 0.0)).Vertex(), BRepTools.OuterWire_s(bottom.wrapped))
        edges.append({"d": b["d"], "centre": [round(b["x"], 3), round(b["y"], 3)], "edgeDistance": round(e, 3), "required": round(req["edgeDistanceFactor"] * b["d"], 3)})
    edge_ok = len(edges) == 2 and all(r["edgeDistance"] + 1e-6 >= r["required"] for r in edges)
    worst = min(edges, key=lambda r: r["edgeDistance"] - r["required"]) if edges else {"edgeDistance": None, "required": None}
    volume = part.Volume(); mass = volume * DENSITY
    bb = Bnd_Box(); BRepBndLib.AddOptimal_s(part.wrapped, bb, False, False); g = bb.Get()
    size = [round(g[i + 3] - g[i], 3) for i in range(3)]
    valid = BRepCheck_Analyzer(part.wrapped).IsValid() and len(part.Solids()) == 1
    return [
        {"id": "solid-valid", "passed": bool(valid), "observed": len(part.Solids()), "required": 1, "unit": "solid", "method": "OCCT BRepCheck_Analyzer; single closed solid"},
        {"id": "bearing-seat", "passed": seat_ok, "observed": {"seatDiameter": seat["d"] if seat else None, "seatLength": seat_len, "axisOffset": offset},
         "required": {"seatDiameter": [lo_d, hi_d], "seatLengthMin": BEARING["B"], "axisOffsetMax": 0.02}, "unit": "mm",
         "method": f"Largest Y-axis cylinder measured on the B-Rep: Ø within H7 for the {BEARING['designation']} OD {BEARING['D']} mm, length ≥ B, coaxial with the declared axis"},
        {"id": "shoulder", "passed": shoulder_ok, "observed": shoulder["d"] if shoulder else None, "required": [min_passage, max_shoulder], "unit": "mm",
         "method": f"Smallest Y-axis cylinder: shaft passage ≥ d + {SHAFT_CLEARANCE} mm, and the outer ring keeps ≥ 2 r_as of shoulder land (ISO 355)"},
        {"id": "min-wall", "passed": wall is not None and wall + 1e-6 >= req["minWallMm"], "observed": round(wall, 3) if wall is not None else None,
         "required": req["minWallMm"], "unit": "mm", "method": "Thinnest material between the bearing seat and the outside on 72 radial rays from the shaft axis at mid-seat (OCCT line/shape intersection)", "at": wall_at},
        {"id": "hole-edge-distance", "passed": edge_ok, "observed": worst["edgeDistance"], "required": worst["required"], "unit": "mm",
         "method": f"Base bolt hole centre to the outer boundary of the base bottom ≥ {req['edgeDistanceFactor']} × d", "holes": edges},
        {"id": "mass", "passed": mass <= req["maxMassG"] + 1e-9, "observed": round(mass, 2), "required": req["maxMassG"], "unit": "g", "method": "B-Rep volume × 6061 aluminium 2.70 g/cm³"},
        {"id": "envelope", "passed": all(s <= m + 1e-6 for s, m in zip(size, req["maxEnvelopeMm"])), "observed": size, "required": req["maxEnvelopeMm"], "unit": "mm",
         "method": "OCCT AddOptimal axis-aligned bounds"},
    ], volume, mass, size


def export(body, h, depth, out):
    cq.exporters.export(body, str(out / "part.step"))
    cq.exporters.export(body, str(out / "part.stl"), tolerance=0.02, angularTolerance=0.1)
    cq.Assembly().add(body, name="Housing", color=cq.Color(*AL)).export(str(out / "part.glb"))
    (cq.Assembly().add(body, name="Housing", color=cq.Color(*AL)).add(bearing(h, depth), name=f"{BEARING['designation']} bearing", color=cq.Color(0.34, 0.37, 0.4))
     .export(str(out / "assembly.glb")))
    cq.exporters.export(body, str(out / "drawing.svg"), opt={"projectionDir": (1.2, -1.0, 0.9), "showHidden": True, "strokeWidth": 0.25,
                                                            "strokeColor": (30, 60, 70), "hiddenColor": (150, 170, 175), "width": 640, "height": 400})


def depth_of(part):
    """Housing depth along Y, measured (the bearing view is placed against the +Y face)."""
    return part.BoundingBox().ylen


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--input", required=True); ap.add_argument("--output", required=True); args = ap.parse_args()
    spec = json.loads(Path(args.input).read_text()); req, out = spec["requirements"], Path(args.output)
    params = spec["parameters"] if spec["variant"] == "parametric" else PRESETS[spec["variant"]]
    label = "参数化候选" if spec["variant"] == "parametric" else PRESETS[spec["variant"]]["label"]
    stage = Stages(out)
    body, part, p = build(params, stage)
    h = p["axisHeight"]
    stage("bearing", f"装配检查：{BEARING['designation']} 轴承", [("Housing", body, AL), (f"{BEARING['designation']} bearing", bearing(h, p["depth"]), (0.34, 0.37, 0.4))])
    checks, volume, mass, size = measure(part, h, req)
    export(body, h, p["depth"], out)
    result = {"schema": "pai-cad-checks-1", "family": "pillow-block", "variant": spec["variant"], "variantLabel": label, "units": "mm", **versions(),
              "material": "6061 aluminium (2.70 g/cm³, nominal)", "bearing": BEARING,
              "parameters": {k: p[k] for k in ("width", "depth", "baseDepth", "axisHeight", "baseThickness", "boltPitch", "seatDiameter", "shoulderDiameter", "crown")},
              "volume": round(volume, 3), "mass": round(mass, 3), "boundingBox": size, "checks": checks,
              "scope": "parametric-part-geometry", "physicalValidation": False,
              "limits": "Nominal geometry and fit rules; no tolerance stack-up, bearing life, FEA or physical test"}
    (out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"variant": spec["variant"], "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
