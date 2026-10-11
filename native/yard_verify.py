"""Independent verifier for site-admission plans (standard library only; shares no code with yard_solve.py).

Recomputes, minute by minute: every truck appears once; admitted trucks enter within their arrival window, pass the gate
before handling, are handled at a compatible dock for exactly their handling time, leave exitMin after handling and by
their latest departure; dock handlings never overlap; gate lanes, yard slots and crews are never exceeded; the reported
totals match. Verdict: valid-schedule | rejected (with every failed check).
"""
import argparse, json, resource, time


def verify(p, plan):
    by = {t["id"]: t for t in p["trucks"]}
    docks = {d["id"]: d for d in p["docks"]}
    H = p["horizonMin"]
    gate, site = p["gate"], p["site"]
    problems = {k: [] for k in ["each-truck-once", "arrival-window", "dock-compatible", "handling-time", "gate-before-handling",
                                "departure", "dock-no-overlap", "gate-capacity", "yard-capacity", "crew-capacity", "totals"]}
    rows = plan.get("plan") or []
    ids = [r.get("truck") for r in rows]
    if sorted(ids) != sorted(by) or len(set(ids)) != len(ids):
        problems["each-truck-once"].append("plan must list every truck exactly once")
    gate_use, yard_use, crew_use = [0] * (H + 2), [0] * (H + 2), [0] * (H + 2)
    dock_use = {k: [None] * (H + 2) for k in docks}
    for r in rows:
        t = by.get(r.get("truck"))
        if not t or not r.get("admitted"):
            continue
        e, s, end, dep, dk = r["entry"], r["handleStart"], r["handleEnd"], r["departure"], r["dock"]
        if not (t["arrival"][0] <= e <= t["arrival"][1]): problems["arrival-window"].append(f"{t['id']} enters at {e}, window {t['arrival']}")
        d = docks.get(dk)
        if not d or t["cargo"] not in d["cargo"] or t["lengthM"] > d["maxLengthM"]: problems["dock-compatible"].append(f"{t['id']} cannot use {dk}")
        if end - s != t["handleMin"]: problems["handling-time"].append(f"{t['id']} handled {end - s} min, needs {t['handleMin']}")
        if s < e + gate["processMin"]: problems["gate-before-handling"].append(f"{t['id']} handled before the gate finishes")
        if dep != end + site["exitMin"] or dep > t["latestDeparture"] or dep > H: problems["departure"].append(f"{t['id']} leaves at {dep}")
        if not (0 <= e and dep <= H): continue
        for x in range(e, e + gate["processMin"]): gate_use[x] += 1
        for x in range(e, dep): yard_use[x] += t["slots"]
        for x in range(s, end):
            crew_use[x] += t["crew"]
            if d:
                if dock_use[dk][x] is not None: problems["dock-no-overlap"].append(f"{dk} used by {dock_use[dk][x]} and {t['id']} at {x}")
                dock_use[dk][x] = t["id"]
    for name, use, cap in [("gate-capacity", gate_use, gate["lanes"]), ("yard-capacity", yard_use, site["yardSlots"]), ("crew-capacity", crew_use, site["crews"])]:
        over = [x for x, u in enumerate(use) if u > cap]
        if over: problems[name].append(f"{max(use)} > {cap} at minute {over[0]}")
    adm = [r for r in rows if r.get("admitted")]
    want = {"admitted": len(adm), "turnedAway": [r["truck"] for r in rows if not r.get("admitted")],
            "priorityAdmitted": sum(by[r["truck"]]["priority"] for r in adm if r["truck"] in by),
            "waitingMin": sum(r["entry"] - by[r["truck"]]["arrival"][0] for r in adm if r["truck"] in by),
            "onSiteMin": sum(r["departure"] - r["entry"] for r in adm), "lastDeparture": max((r["departure"] for r in adm), default=0)}
    if (plan.get("totals") or {}) != want: problems["totals"].append("reported totals differ from the recomputed ones")
    for k in problems: problems[k] = problems[k][:5]
    checks = [{"id": k, "passed": not v, "problems": v} for k, v in problems.items()]
    peak = {"gateLanes": max(gate_use), "yardSlots": max(yard_use), "crews": max(crew_use)}
    return {"schema": "pai-yard-verification-1", "verdict": "valid-schedule" if all(c["passed"] for c in checks) else "rejected", "checks": checks,
            "recomputed": want, "peakUse": peak, "capacity": {"gateLanes": gate["lanes"], "yardSlots": site["yardSlots"], "crews": site["crews"]}}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--problem", required=True); ap.add_argument("--plan", required=True); ap.add_argument("--output", required=True)
    a = ap.parse_args()
    t0 = time.time()
    out = verify(json.load(open(a.problem)), json.load(open(a.plan)))
    out["usage"] = {"wallSeconds": round(time.time() - t0, 3), "cpuSeconds": round(resource.getrusage(resource.RUSAGE_SELF).ru_utime, 3),
                    "maxRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    json.dump(out, open(a.output, "w"), indent=1)
    print(json.dumps({"verdict": out["verdict"], "failed": [c["id"] for c in out["checks"] if not c["passed"]]}))
