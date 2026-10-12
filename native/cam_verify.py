"""Independent check of CAM programs against the part: dexel (Z-map) material-removal simulation per setup.

    PAI_CADQUERY_PYTHON cam_verify.py --step part.step --cam DIR/cam.json --shop dfm-shop.json --output cam-verify.json

Reads only the G-code (G0/G1/G2/G3, G17 G21 G90; anything else is refused) and the tool table, never FreeCAD's
internal state. For each setup in order:
- the part (CadQuery B-Rep) is put in the setup frame of cam.json and rasterised into a height map; holes made in
  later setups are filled, so each setup is judged on what it is supposed to cut;
- the stock height map starts at the bar stock (first setup) or at the result of the earlier setups; every sampled
  tool position lowers it by the tool's shape below its tip (flat end mill, ball nose, 118° drill point);
- gouge: material removed below the part surface by more than gougeTolMm; engagement: material height under the inner half
  of the tool end at a feed sample (overload: a plunge or slot into deep stock); residual: material left above what the end mill can
  reach (grey closing of the part height map with each library tool's end profile, best per cell) by more than residualTolMm; the part-to-
  closing difference is reported as tool-limited (internal corner fillets), not as a program fault where the setup should finish it (part columns plus a 1 mm ring, or the
  footprint of the setup's holes); rapid collision: a G0 move whose tool passes through remaining material.
Lateral resolution is the cell size; cells within 3 cells (0.3 mm) of a vertical wall or edge are not judged. Cycle time is
G1/G2/G3 length at the programmed feeds plus G0 length at the shop rapid rate. Simulation, not a machine test.
"""
import argparse, hashlib, json, math, re, time
from pathlib import Path
import numpy as np
import cadquery as cq
from scipy import ndimage
from OCP.BRepAdaptor import BRepAdaptor_Surface  # a face's own cylinder, also on trimmed surfaces

p = argparse.ArgumentParser()
for k in ("step", "cam", "shop", "output"):
    p.add_argument(f"--{k}", required=True)
p.add_argument("--cell", type=float, default=0.1)
a = p.parse_args()
t0 = time.time()
shop, cam = json.loads(Path(a.shop).read_text()), json.loads(Path(a.cam).read_text())
tools, dfm_holes = shop["cam"], cam["holes"]
GOUGE, RESIDUAL, CELL = 0.02, shop["cam"]["finishToleranceMm"], a.cell
WALL_CELLS = int(__import__("os").environ.get("PAI_CAM_WALL_CELLS", "3"))  # cells either side of a wall that are not judged
part = cq.importers.importStep(a.step).val()


def rot(axis, deg):
    """Right-hand rotation matrix (same convention as cadquery Shape.rotate)."""
    x, y, z = axis; c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg)); C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def filled(shape, holes_to_fill):
    """The part with the given holes filled: a plug of the hole diameter over each matching hole face's axial extent."""
    plugs = []
    for f in shape.Faces():
        if f.geomType() != "CYLINDER":
            continue
        c = BRepAdaptor_Surface(f.wrapped).Cylinder(); d = c.Axis().Direction(); o = c.Axis().Location()
        axis = "XYZ"[int(np.argmax([abs(d.X()), abs(d.Y()), abs(d.Z())]))]
        if not any(abs(2 * c.Radius() - h["diameterMm"]) < 0.05 and h["axis"] == axis for h in holes_to_fill):
            continue
        bb = f.BoundingBox(); i = "XYZ".index(axis)
        lo, hi = [(bb.xmin, bb.xmax), (bb.ymin, bb.ymax), (bb.zmin, bb.zmax)][i]
        base = [o.X(), o.Y(), o.Z()]; base[i] = lo
        v = [0, 0, 0]; v[i] = 1
        plugs.append(cq.Solid.makeCylinder(c.Radius(), hi - lo, cq.Vector(*base), cq.Vector(*v)))
    out = shape
    for plug in plugs:
        out = out.fuse(plug)
    return out


def heightmap(shape, R, ztop, grid):
    """Max z of the shape per cell centre in the setup frame (cells without material get -inf)."""
    verts, tris = shape.tessellate(0.005, 0.05)
    V = np.array([[v.x, v.y, v.z] for v in verts]) @ R.T; V[:, 2] -= ztop
    x0, y0, nx, ny = grid
    H = np.full((ny, nx), -np.inf)
    for t in tris:
        P = V[list(t)]
        lo, hi = P.min(0), P.max(0)
        i0, i1 = max(0, int(math.floor((lo[0] - x0) / CELL))), min(nx - 1, int(math.ceil((hi[0] - x0) / CELL)))
        j0, j1 = max(0, int(math.floor((lo[1] - y0) / CELL))), min(ny - 1, int(math.ceil((hi[1] - y0) / CELL)))
        if i1 < i0 or j1 < j0:
            continue
        X, Y = np.meshgrid(x0 + (np.arange(i0, i1 + 1) + 0.5) * CELL, y0 + (np.arange(j0, j1 + 1) + 0.5) * CELL)
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = P
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        w1 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
        w2 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
        w3 = 1 - w1 - w2
        inside = (w1 >= -1e-9) & (w2 >= -1e-9) & (w3 >= -1e-9)
        Z = np.where(inside, w1 * az + w2 * bz + w3 * cz, -np.inf)
        H[j0:j1 + 1, i0:i1 + 1] = np.maximum(H[j0:j1 + 1, i0:i1 + 1], Z)
    return H


def tool_shape(name):
    """(window half-width in cells, height-above-tip function of the radial distance, radius) for a tool name."""
    if name == "endmill":
        r = tools["endmill"]["diameterMm"] / 2; f = lambda rho: np.zeros_like(rho)
    elif name == "ballnose":
        r = tools["ballnose"]["diameterMm"] / 2; f = lambda rho: r - np.sqrt(np.maximum(r * r - rho * rho, 0))
    else:
        d = float(name.split("-", 1)[1]); spec = next(x for x in tools["drills"] if abs(x["diameterMm"] - d) < 0.05)
        r, half = d / 2, math.radians(spec["pointAngleDeg"] / 2); f = lambda rho: rho / math.tan(half)
    k = int(math.ceil(r / CELL)) + 1
    return k, (lambda rho, f=f, r=r: np.where(rho <= r, f(rho), np.inf)), r


WORD = re.compile(r"([A-Z])([-+]?\d*\.?\d+)")


def moves(text):
    """Yield (op, motion, start, end, feed, arc) in program order. Refuses dialects this checker does not model."""
    pos, motion, feed, op = None, None, None, None
    seen = set()
    for raw in text.splitlines():
        if raw.startswith("(Begin operation:"):
            op = raw[len("(Begin operation:"):].strip(" )"); continue
        line = re.sub(r"\(.*?\)", "", raw).strip().upper()
        if not line:
            continue
        words = WORD.findall(line)
        g = [float(v) for k, v in words if k == "G"]
        for code in g:
            if code in (0, 1, 2, 3):
                motion = int(code)
            elif code in (17, 90, 21, 54, 80, 98):
                seen.add(int(code))
            else:
                raise SystemExit(f"unsupported G{code:g} in {raw!r}")
        vals = {k: float(v) for k, v in words if k in "XYZIJKF"}
        if "F" in vals:
            feed = vals["F"]
        if not any(k in vals for k in "XYZ"):
            continue
        if pos is None:
            pos = [vals.get("X", 0.0), vals.get("Y", 0.0), vals.get("Z", 0.0)]
            if motion != 0:
                raise SystemExit("first positioning move must be a rapid")
            continue
        end = [vals.get("X", pos[0]), vals.get("Y", pos[1]), vals.get("Z", pos[2])]
        arc = (vals.get("I", 0.0), vals.get("J", 0.0)) if motion in (2, 3) else None
        yield op, motion, pos, end, feed, arc
        pos = end
    if not {17, 21, 90} <= seen:
        raise SystemExit("program must declare G17 G21 G90")


def samples(start, end, motion, arc, step):
    s, e = np.array(start), np.array(end)
    if arc is None:
        n = max(1, int(math.ceil(np.linalg.norm(e - s) / step)))
        return [s + (e - s) * t for t in np.linspace(0, 1, n + 1)], float(np.linalg.norm(e - s))
    cx, cy = s[0] + arc[0], s[1] + arc[1]; r = math.hypot(s[0] - cx, s[1] - cy)
    a0, a1 = math.atan2(s[1] - cy, s[0] - cx), math.atan2(e[1] - cy, e[0] - cx)
    if motion == 2:  # clockwise
        while a1 >= a0 - 1e-12: a1 -= 2 * math.pi
    else:
        while a1 <= a0 + 1e-12: a1 += 2 * math.pi
    length = math.hypot(abs(a1 - a0) * r, e[2] - s[2])
    n = max(1, int(math.ceil(length / step)))
    return [np.array([cx + r * math.cos(a0 + (a1 - a0) * t), cy + r * math.sin(a0 + (a1 - a0) * t), s[2] + (e[2] - s[2]) * t]) for t in np.linspace(0, 1, n + 1)], length


def panel(name, H, T, gouge, residual, limited, judged_region):
    """Shaded relief of the simulated stock (light from the upper left) with findings painted over it: red gouge,
    orange residual, blue tool-limited material. Rows flipped so +Y is up, as seen from the spindle."""
    from PIL import Image, ImageDraw
    gy, gx = np.gradient(H, CELL)
    shade = np.clip(0.55 + 0.45 * (-gx * 0.7 + gy * 0.7) / np.sqrt(1 + gx * gx + gy * gy), 0, 1)
    lo, hi = float(np.percentile(H, 1)), float(H.max())
    height = (H - lo) / max(hi - lo, 1e-6)
    rgb = np.stack([0.55 + 0.35 * height, 0.62 + 0.30 * height, 0.70 + 0.25 * height], -1) * shade[..., None]
    for mask, colour in ((limited, (0.25, 0.45, 0.95)), (residual, (1.0, 0.55, 0.0)), (gouge, (0.9, 0.1, 0.1))):
        rgb[mask] = colour
    im = Image.fromarray((np.clip(rgb, 0, 1)[::-1] * 255).astype(np.uint8))
    scale = max(1, int(560 / max(im.size)))
    im = im.resize((im.size[0] * scale, im.size[1] * scale), Image.NEAREST)
    canvas = Image.new("RGB", (im.size[0] + 20, im.size[1] + 44), "white"); canvas.paste(im, (10, 34))
    d = ImageDraw.Draw(canvas)
    d.text((10, 8), f"setup {name}: {int(gouge.sum())} gouge / {int(residual.sum())} residual cells; red gouge, orange residual, blue left where no tool reaches", fill=(20, 30, 40))
    return canvas


panels = []
order = [s["setup"] for s in cam["setups"]]
results, stock_after = [], None
for idx, setup in enumerate(cam["setups"]):
    R = rot(setup["rotation"]["axis"], setup["rotation"]["degrees"]); ztop = setup["zTop"]
    later = [h for h in dfm_holes if order.index(h["setup"]) > idx]
    mine = [h for h in dfm_holes if h["setup"] == setup["setup"]]
    # the grid covers the stock in this frame plus a tool radius
    V = np.array([[v.x, v.y, v.z] for v in part.tessellate(0.05, 0.2)[0]]) @ R.T
    al = shop["stockAllowanceMm"]; pad = al + max(tools["endmill"]["diameterMm"], tools["ballnose"]["diameterMm"]) + 1
    x0, y0 = V[:, 0].min() - pad, V[:, 1].min() - pad
    nx, ny = int(math.ceil((V[:, 0].max() + pad - x0) / CELL)), int(math.ceil((V[:, 1].max() + pad - y0) / CELL))
    grid = (x0, y0, nx, ny)
    target = heightmap(filled(part, later) if later else part, R, ztop, grid)
    zbottom = float(V[:, 2].min() - ztop)
    if idx == 0:
        H = np.full((ny, nx), zbottom)
        X, Y = np.meshgrid(x0 + (np.arange(nx) + 0.5) * CELL, y0 + (np.arange(ny) + 0.5) * CELL)
        inside = (X >= V[:, 0].min() - al) & (X <= V[:, 0].max() + al) & (Y >= V[:, 1].min() - al) & (Y <= V[:, 1].max() + al)
        H[inside] = al  # bar stock: part top + allowance in this frame
    else:
        H = heightmap(filled(part, later + mine), R, ztop, grid)
    H = np.where(np.isfinite(H), H, zbottom); T = np.where(np.isfinite(target), target, zbottom)
    region_before = H - T > RESIDUAL
    # judge cells away from vertical walls only
    wall = np.zeros_like(T, dtype=bool)
    dz = np.maximum(np.abs(np.diff(T, axis=0, prepend=T[:1])), np.abs(np.diff(T, axis=1, prepend=T[:, :1])))
    wall |= dz > 0.5
    for _ in range(WALL_CELLS):
        wall = wall | np.roll(wall, 1, 0) | np.roll(wall, -1, 0) | np.roll(wall, 1, 1) | np.roll(wall, -1, 1)
    judged = ~wall & (T > zbottom + 1e-6)
    gcode = (Path(a.cam).parent / setup["file"]).read_text()
    if hashlib.sha256(gcode.encode()).hexdigest() != setup["sha256"]:
        raise SystemExit(f"{setup['file']} differs from cam.json")
    counters, drill_ix, tool_of_op = {}, 0, {}
    xc, yc = x0 + (np.arange(nx) + 0.5) * CELL, y0 + (np.arange(ny) + 0.5) * CELL
    drill_tools = [o["tool"] for o in setup["operations"] if o["op"] == "DrillOp"]
    shapes = {}
    cut_mm, rapid_mm, minutes, rapid_hits, nsamples = 0.0, 0.0, 0.0, 0, 0
    per_op = {}
    for op, motion, s, e, feed, arc in moves(gcode):
        if op not in tool_of_op:
            kind = re.sub(r"_\d+$", "", op or "")
            if kind == "DrillOp":
                tool_of_op[op] = drill_tools[drill_ix]; drill_ix += 1
            else:
                tool_of_op[op] = {"AdaptiveOp": "endmill", "FaceOp": "endmill", "MillFaceOp": "endmill", "ProfileOp": "endmill", "HelixOp": "endmill", "Raster3D": "ballnose"}.get(kind, "endmill")
        tool = tool_of_op[op]
        if tool not in shapes:
            shapes[tool] = tool_shape(tool)
        k, prof, r = shapes[tool]
        pts, length = samples(s, e, motion, arc, CELL / 2)
        st0 = per_op.setdefault(op, {"rapidCollisions": 0, "gougeSamples": 0})
        if motion == 0:
            rapid_mm += length; dt = length / shop["rapidMmPerMin"]
        else:
            cut_mm += length; dt = length / max(feed or 1.0, 1.0)
        minutes += dt; st0["minutes"] = round(st0.get("minutes", 0.0) + dt, 3)
        for q in pts:
            i, j = int(math.floor((q[0] - x0) / CELL)), int(math.floor((q[1] - y0) / CELL))
            i0, i1, j0, j1 = i - k, i + k + 1, j - k, j + k + 1
            if i0 < 0 or j0 < 0 or i1 > nx or j1 > ny:
                continue  # outside the stock window: cuts air
            win = H[j0:j1, i0:i1]
            rho = np.hypot(xc[i0:i1][None, :] - q[0], yc[j0:j1][:, None] - q[1])  # exact distance to cell centres
            envelope = q[2] + prof(rho)
            nsamples += 1
            st = per_op.setdefault(op, {"rapidCollisions": 0, "gougeSamples": 0})
            if motion == 0:
                if np.any(win > envelope + GOUGE):
                    rapid_hits += 1; st["rapidCollisions"] += 1
                    if len(st.setdefault("rapidExamples", [])) < 2:
                        st["rapidExamples"].append({"from": [round(v, 3) for v in s], "to": [round(v, 3) for v in e], "at": [round(float(v), 3) for v in q],
                                                    "materialAbove": round(float(np.max(win - envelope)), 3)})
            else:
                if not tool.startswith("drill"):
                    # end-of-tool engagement (inner half of the radius): a plunge or slot into deep stock; side cuts of
                    # thin slivers at the periphery are a normal finishing load and are not counted
                    depth = float(np.max(np.where(rho <= r / 2, win - envelope, 0.0)))
                    if depth > st.get("maxEngagementMm", 0.0):
                        st["maxEngagementMm"] = round(depth, 3); st["tool"] = tool
                        st["engagementAt"] = {"tip": [round(float(v), 3) for v in q], "from": [round(v, 3) for v in s], "motion": motion}
                bad = (envelope < T[j0:j1, i0:i1] - GOUGE) & judged[j0:j1, i0:i1]
                if np.any(bad):
                    st["gougeSamples"] += 1
                    if len(st.setdefault("examples", [])) < 3:
                        jj, ii = np.argwhere(bad)[0]
                        st["examples"].append({"tip": [round(float(v), 3) for v in q], "cell": [round(x0 + (i0 + ii + 0.5) * CELL, 2), round(y0 + (j0 + jj + 0.5) * CELL, 2)],
                                               "toolBottomAtCell": round(float(envelope[jj, ii]), 3), "partTop": round(float(T[j0 + jj, i0 + ii]), 3)})
                np.minimum(win, envelope, out=win)
    gouge = (H < T - GOUGE) & judged
    if idx == 0:
        region = (T > zbottom + 1e-6)
        ring = region.copy()
        for _ in range(int(round(1.0 / CELL))):
            ring = ring | np.roll(ring, 1, 0) | np.roll(ring, -1, 0) | np.roll(ring, 1, 1) | np.roll(ring, -1, 1)
        region = ring
    else:
        region = region_before
    if idx > 0:
        # Secondary setups make holes; a single-height dexel cannot see the empty space behind a wall, so each hole is
        # judged down to its own far end, not to whatever lies below it.
        Tj = T.copy()
        for h in mine:
            for f in part.Faces():
                if f.geomType() != "CYLINDER":
                    continue
                c = BRepAdaptor_Surface(f.wrapped).Cylinder()
                if abs(2 * c.Radius() - h["diameterMm"]) > 0.05:
                    continue
                F = np.array([[v.x, v.y, v.z] for v in f.tessellate(0.01, 0.1)[0]]) @ R.T
                if np.ptp(F[:, 0]) > 2 * c.Radius() + 0.1 or np.ptp(F[:, 1]) > 2 * c.Radius() + 0.1:
                    continue  # not along this setup's axis
                cx, cy, far = F[:, 0].mean(), F[:, 1].mean(), F[:, 2].min() - ztop
                X, Y = np.meshgrid(xc, yc)
                inside = np.hypot(X - cx, Y - cy) <= c.Radius()
                Tj[inside] = np.maximum(Tj[inside], far)
        T = Tj
    # The best a flat end mill of radius r can leave from this side is the morphological closing of the part height map
    # with the tool disc (dilation: where the tool can descend; erosion: what it sweeps). Material between the part and
    # that closing is tool-limited (e.g. the R = r fillet in a sharp vertical internal corner): reported, not blamed on
    # the program. Material above the closing is a programming fault.
    def closing(radius, ball):
        """Lowest material a tool of this radius can leave from this side: grey closing of the part height map with
        the tool's end profile (flat or ball) as structuring element (dilation = tip height, erosion = swept surface)."""
        kk = int(math.ceil(radius / CELL))
        I, J = np.meshgrid(np.arange(-kk, kk + 1), np.arange(-kk, kk + 1)); rho = np.hypot(I, J) * CELL
        disc = rho <= radius
        h = np.where(disc, radius - np.sqrt(np.maximum(radius * radius - rho * rho, 0)) if ball else 0.0, 0.0)
        tip = ndimage.grey_dilation(T, footprint=disc, structure=-h, mode="nearest")
        return ndimage.grey_erosion(tip, footprint=disc, structure=-h, mode="nearest")
    rr = tools["endmill"]["diameterMm"] / 2
    # best of the library per cell (flat end mill and ball nose), since the program may use either there
    reach = np.minimum(closing(rr, False), closing(tools["ballnose"]["diameterMm"] / 2, True)) if idx == 0 else T
    limited = (reach > T + RESIDUAL) & region & ~wall
    T_part, T = T, np.maximum(T, reach)
    # Tolerance map: flat faces (horizontal) must be finished to finishToleranceMm; on sloped faces z-level / raster
    # finishing leaves cusps, judged against slopeCuspToleranceMm (both reviewed in dfm-shop.json).
    gy, gx = np.gradient(T, CELL)  # the surface to be achieved: part, or the curved tool-limited corner shape
    sloped = ndimage.binary_dilation(np.hypot(gx, gy) > 0.05, iterations=WALL_CELLS)  # slope edges belong to the slope
    tol = np.where(sloped, shop["cam"]["slopeCuspToleranceMm"], RESIDUAL)
    residual = (H > T + tol) & region & ~wall
    res_example = None
    if residual.any():
        # where the worst material is left, and the extent of the cells left by more than 1 mm
        jj, ii = np.unravel_index(np.argmax(np.where(residual, H - T, -np.inf)), H.shape)
        big = residual & (H - T > 1.0)
        clusters = {}
        for jj2, ii2 in np.argwhere(residual):
            key = (round(float(xc[ii2]) / 2) * 2, round(float(yc[jj2]) / 2) * 2)
            c = clusters.setdefault(key, [0, 0.0, float(T[jj2, ii2]), float(xc[ii2]), float(yc[jj2]), bool(sloped[jj2, ii2]), float(tol[jj2, ii2])]); c[0] += 1; c[1] = max(c[1], float(H[jj2, ii2] - T[jj2, ii2]))
        top = sorted(clusters.items(), key=lambda kv: -kv[1][0])[:8]
        res_example = {"clusters": [{"x": k[0], "y": k[1], "cells": v[0], "maxMm": round(v[1], 3), "partZ": round(v[2], 2), "first": [round(v[3], 2), round(v[4], 2)], "sloped": v[5], "tol": v[6]} for k, v in top], "worst": {"cell": [round(float(xc[ii]), 2), round(float(yc[jj]), 2)], "stock": round(float(H[jj, ii]), 3), "part": round(float(T[jj, ii]), 3)},
                       "over1mm": {"cells": int(big.sum()), "x": [round(float(xc[np.argwhere(big)[:, 1]].min()), 2), round(float(xc[np.argwhere(big)[:, 1]].max()), 2)] if big.any() else None,
                                   "y": [round(float(yc[np.argwhere(big)[:, 0]].min()), 2), round(float(yc[np.argwhere(big)[:, 0]].max()), 2)] if big.any() else None}}
    panels.append(panel(setup["setup"], H, T, gouge, residual, limited & (H > T_part + RESIDUAL), region | (idx > 0)))
    results.append({"setup": setup["setup"], "samples": nsamples, "cells": int(nx * ny), "cellMm": CELL,
                    "gougeCells": int(gouge.sum()), "maxGougeMm": round(float((T - H)[gouge].max()), 4) if gouge.any() else 0.0,
                    "residualCells": int(residual.sum()), "maxResidualMm": round(float((H - T)[residual].max()), 4) if residual.any() else 0.0,
                    "residualAreaMm2": round(float(residual.sum()) * CELL * CELL, 2), "residualExample": res_example,
                    "toolLimited": {"areaMm2": round(float(limited.sum()) * CELL * CELL, 2), "maxHeightMm": round(float((reach - T_part)[limited].max()), 3) if limited.any() else 0.0,
                                    "tools": ["endmill", "ballnose"], "meaning": "material no tool in the library can remove from this side (internal corner fillets)"},
                    "rapidCollisions": rapid_hits, "byOperation": per_op, "cuttingMm": round(cut_mm, 1), "rapidMm": round(rapid_mm, 1), "minutes": round(minutes, 2)})
total = round(sum(r["minutes"] for r in results), 2)
limit = {"endmill": tools["endmill"]["maxAxialMm"], "ballnose": tools["ballnose"]["maxAxialMm"]}
over = [(r["setup"], op, v["maxEngagementMm"]) for r in results for op, v in r["byOperation"].items() if v.get("maxEngagementMm", 0) > limit.get(v.get("tool"), 1e9) + GOUGE]
checks = [
    {"id": "no-gouge", "passed": all(r["gougeCells"] == 0 for r in results), "observed": max(r["maxGougeMm"] for r in results), "required": GOUGE, "unit": "mm"},
    {"id": "no-residual", "passed": all(r["residualCells"] == 0 for r in results), "observed": max(r["maxResidualMm"] for r in results),
     "required": {"flat": RESIDUAL, "sloped": shop["cam"]["slopeCuspToleranceMm"]}, "unit": "mm"},
    {"id": "tool-engagement", "passed": not over, "observed": max((x[2] for x in over), default=0.0), "required": limit, "unit": "mm axial",
     "method": "Material height under the inner half of the tool end at any feed sample (plunge/slot overload; drilling excluded); limits in dfm-shop.json", "over": over[:5]},
    {"id": "no-rapid-collision", "passed": all(r["rapidCollisions"] == 0 for r in results), "observed": sum(r["rapidCollisions"] for r in results), "required": 0, "unit": "samples"},
]
out = {"schema": "pai-cam-verify-1", "method": "dexel height-map material removal per setup", "setups": results, "cycleMinutes": total,
       "checks": checks, "passed": all(c["passed"] for c in checks), "seconds": round(time.time() - t0, 1), "physicalValidation": False}
# Picture of the simulated result for review (panels side by side); presentation only, recorded with the report.
from PIL import Image
sheet = Image.new("RGB", (sum(p.size[0] for p in panels), max(p.size[1] for p in panels)), "white")
x = 0
for p_ in panels:
    sheet.paste(p_, (x, 0)); x += p_.size[0]
sheet.save(Path(a.output).with_name("cam-sim.png"))
out["picture"] = "cam-sim.png"
Path(a.output).write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps({"passed": out["passed"], "cycleMinutes": total, **{c["id"]: c["observed"] for c in checks},
                  "setups": [(r["setup"], r["gougeCells"], r["residualCells"], r["rapidCollisions"]) for r in results], "seconds": out["seconds"]}))
