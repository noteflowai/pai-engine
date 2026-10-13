"""Resident worker for an artifact's own Python entry point (newline-delimited JSON over stdin/stdout).

    <python> -I engine_worker.py --code DIR --module surrogate_train [--cache load]

Platform harness only: it imports the artifact's module from DIR (the artifact's own, digest-checked bytes) once and,
per request {"id", "argv": [...]} calls the module's entry (default main) with that argv, or {"id", "namespace": {...}}
calls it with an argparse.Namespace of those fields (for modules whose CLI dispatch sits under __main__), and returns
what it printed:
{"id", "ok": true, "stdout": "..."} or {"id", "ok": false, "error": "..."}. Imports (CadQuery/OCCT, PyTorch) and
whatever --cache names (a function of the module, e.g. weight loading) are paid once, so a request costs the work only.
The result is byte-for-byte what the one-shot command prints for the same argv. One request at a time; stdout of the
module is captured per request, so nothing it prints can corrupt the protocol.
"""
import argparse
import contextlib
import functools
import importlib.util
import io
import json
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--code", required=True); ap.add_argument("--module", required=True); ap.add_argument("--entry", default="main")
ap.add_argument("--cache", action="append", default=[], help="module function to memoise across requests (pure, by arguments)")
a = ap.parse_args()
if not a.module.isidentifier():
    raise SystemExit("bad module name")
spec = importlib.util.spec_from_file_location(a.module, Path(a.code) / f"{a.module}.py")
mod = importlib.util.module_from_spec(spec)
sys.argv = [f"{a.module}.py"]
spec.loader.exec_module(mod)  # the module's import-time work (heavy imports) happens here, once
for name in a.cache:
    setattr(mod, name, functools.lru_cache(maxsize=8)(getattr(mod, name)))
out = sys.stdout
print(json.dumps({"ready": True, "module": a.module}), file=out, flush=True)
for line in sys.stdin:
    req = json.loads(line)
    buf = io.StringIO()
    try:
        entry = getattr(mod, a.entry)
        with contextlib.redirect_stdout(buf):
            if "namespace" in req:
                entry(argparse.Namespace(**req["namespace"]))
            else:
                sys.argv = [f"{a.module}.py", *[str(x) for x in req["argv"]]]
                entry()
        reply = {"id": req["id"], "ok": True, "stdout": buf.getvalue()}
    except SystemExit as e:  # argparse errors and explicit refusals of the module
        reply = {"id": req.get("id"), "ok": False, "error": f"exit {e.code}", "stdout": buf.getvalue()}
    except Exception as e:  # noqa: BLE001 — reported to the caller, the worker stays up
        reply = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
    print(json.dumps(reply), file=out, flush=True)
