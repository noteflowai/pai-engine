"""Cycles device for PAI Blender scripts (ADR 0004).

GPU only when the engine runtime offered one (PAI_GPU=1, set for a container with the NVIDIA CDI device): OptiX,
else CUDA. Otherwise, or if no such device is visible, the CPU. Rendering is presentation and evidence imagery; every
pass/fail check in these scripts is geometric (ray casts, distances), so the device never changes a verdict.
The chosen device is printed to stderr (retained in the run's log).
"""
import os
import sys

import bpy


def use_render_device(scene) -> str:
    if os.environ.get("PAI_GPU") == "1":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.refresh_devices()
            except TypeError:
                continue
            devices = [d for d in prefs.devices if d.type == kind]
            if devices:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                print(f"PAI_RENDER_DEVICE {kind} {devices[0].name}", file=sys.stderr, flush=True)
                return kind
    scene.cycles.device = "CPU"
    print("PAI_RENDER_DEVICE CPU", file=sys.stderr, flush=True)
    return "CPU"
