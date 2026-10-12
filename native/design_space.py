"""Design spaces of the parametric part families: searched axes and bounds, fixed recipe values, reference design.

One source for physics optimisation (cad_optimize.py) and surrogate datasets (surrogate_dataset.py). Bounds stay inside
the recipes' own validity bounds (cad_recipe.py, cad_bearing.py), so every sampled point is buildable by construction.
"""
FAMILIES = {
    "nema17-bracket": {"bounds": {"thickness": (2.0, 8.0), "width": (46.0, 80.0), "plateHeight": (40.0, 60.0)}, "fixed": {"pilotBore": 22.5},
                       "reference": {"thickness": 4.0, "width": 60.0, "plateHeight": 46.0}, "fea": "fea_bracket.py", "boltDiameter": 5.5},
    # Bounds inside native/cad_bearing.py BOUNDS; the bolts stay inside the base (pitch < width) for the whole box.
    "pillow-block": {"bounds": {"width": (80.0, 120.0), "depth": (14.0, 24.0), "baseThickness": (6.0, 14.0), "boltPitch": (54.0, 76.0)},
                     "fixed": {"baseDepth": 36.0, "axisHeight": 30.0, "seatDiameter": 35.012, "shoulderDiameter": 28.0, "crown": 8.0},
                     "reference": {"width": 108.0, "depth": 20.0, "baseThickness": 10.0, "boltPitch": 76.0}, "fea": "fea_pillow.py", "boltDiameter": 9.0},
}
