"""Independently re-import a saved STEP file and report native B-Rep properties."""
import json
import sys
from pathlib import Path

import cadquery as cq
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.BRepAdaptor import BRepAdaptor_Surface  # a face's own cylinder, also on trimmed surfaces

source, target = sys.argv[1], sys.argv[2]
shape = cq.importers.importStep(source).val()
bb = Bnd_Box()
BRepBndLib.AddOptimal_s(shape.wrapped, bb, False, False)
bounds = bb.Get()
cylinders = [f for f in shape.Faces() if f.geomType() == "CYLINDER"]
Path(target).write_text(json.dumps({
    "schema": "pai-cad-reopen-1", "cadquery": cq.__version__, "valid": shape.isValid(), "solids": len(shape.Solids()),
    "volume": round(shape.Volume(), 3), "boundingBox": [round(bounds[i + 3] - bounds[i], 3) for i in range(3)],
    "boundingBoxMethod": "OCCT AddOptimal; useTriangulation=False; useShapeTolerance=False",
    "cylindricalFaces": len(cylinders), "holeDiameters": sorted({round(2 * BRepAdaptor_Surface(f.wrapped).Cylinder().Radius(), 3) for f in cylinders}),
}, indent=2) + "\n")
