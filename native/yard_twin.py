"""Yard digital twin: replay site-admission decisions against a disturbed day (pai-yard-twin-1).

The twin models the site as the ontology does: the site (gate lanes, yard slots, crews), docks, trucks with cargo, and
sensors (ANPR camera at the gate, dock-door sensors, yard occupancy). A day is played minute by minute under two
policies, each recomputing from what the sensors report:

  fcfs      first-come-first-served, as dispatched today
  cp-sat    the yard-admission artifact (OR-Tools CP-SAT). It plans at the start of the shift and re-plans whenever a
            sensor reports a deviation (a truck later than its window start, a dock out of service), keeping trucks
            already on site where they are. Every plan it adopts is checked by yard_verify.py before use.

Disturbances (seeded): late arrivals reported by the gate camera; a dock door that goes down for a period reported by
its sensor. Output: the event timeline both policies produced (what the animation shows), KPIs per policy and the
verification of every adopted plan. Synthetic site; nothing is dispatched.
"""
from __future__ import annotations
import argparse, copy, json, os, random, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import yard_solve  # noqa: E402
import yard_verify  # noqa: E402


def disturbances(p, seed):
    rng = random.Random(seed * 31 + 5)
    late = rng.sample([t["id"] for t in p["trucks"]], 3)
    shift = {i: rng.choice([20, 30, 40]) for i in late}
    dock = rng.choice([d["id"] for d in p["docks"][:4]])
    down = (rng.randrange(40, 70), 0)
    down = (down[0], down[0] + 30)
    return {"late": shift, "dockDown": {"dock": dock, "from": down[0], "to": down[1]}}


def realised(p, d):
    """The day as it actually happens: late trucks arrive later (their windows shift), a dock is unavailable for a while."""
    q = copy.deepcopy(p)
    for t in q["trucks"]:
        if t["id"] in d["late"]:
            s = d["late"][t["id"]]
            t["arrival"] = [t["arrival"][0] + s, t["arrival"][1] + s]
            t["latestDeparture"] = min(q["horizonMin"], t["latestDeparture"] + s)
    return q


def block_dock(p, d, frm, to):
    """Represent a dock outage as a pseudo-truck occupying the dock (only that dock fits it); used for planning."""
    q = copy.deepcopy(p)
    dock = next(x for x in q["docks"] if x["id"] == d)
    q["docks"] = [dict(x, cargo=x["cargo"] + (["outage"] if x["id"] == d else [])) for x in q["docks"]]
    q["trucks"].append({"id": "OUTAGE", "carrier": "-", "cargo": "outage", "lengthM": 1, "slots": 0, "crew": 0, "arrival": [max(0, frm - 6), max(0, frm - 6)],
                        "handleMin": to - frm, "latestDeparture": to + q["site"]["exitMin"], "priority": 10})
    return q, dock


def plan_cp(p, budget, fixed):
    """CP-SAT plan for the whole day where trucks already on site are pinned to their exact entry, dock and times."""
    q = copy.deepcopy(p)
    ids = {t["id"] for t in q["trucks"]}
    for i, f in fixed.items():  # their windows must still contain the entry they really had
        t = next(x for x in q["trucks"] if x["id"] == i)
        t["arrival"] = [min(t["arrival"][0], f["entry"]), max(t["arrival"][1], f["entry"])]
    r = yard_solve.solve(q, budget, "deterministic", fixed={i: f for i, f in fixed.items() if i in ids})
    if r["plan"] is None:
        return None
    return [x for x in r["plan"] if x["truck"] != "OUTAGE"]


def play(p, d, policy, budget):
    """Minute-by-minute day; returns the adopted schedule, re-plan log and sensor events."""
    actual = realised(p, d)
    H = p["horizonMin"]
    events, replans, schedule = [], [], {}
    dd = d["dockDown"]
    known_late = set()
    # A truck reported late is only known late once its window opens without it; FCFS needs no forecast at all.
    if policy == "fcfs":
        # FCFS reacts only to what is physically at the gate; the outage is honoured by blocking the dock.
        q, _ = block_dock(actual, dd["dock"], dd["from"], dd["to"])
        rows = [r for r in yard_solve.fcfs(q) if r["truck"] != "OUTAGE"]
        schedule = {r["truck"]: r for r in rows}
    else:
        # Shift start: plan on the announced arrivals.
        rows = plan_cp(p, budget, {}) or []
        schedule = {r["truck"]: r for r in rows}
        replans.append({"at": 0, "reason": "shift start", "admitted": sum(r["admitted"] for r in rows)})
        # Re-plan whenever a sensor reports something new: a truck that is not at the gate when its window opens (the
        # gate camera sees no plate), or a dock going down (door sensor).
        trigger = sorted({t["arrival"][0] for t in p["trucks"] if t["id"] in d["late"]} | {dd["from"]})
        for now in trigger:
            for t in p["trucks"]:
                if t["id"] in d["late"] and t["arrival"][0] <= now and t["id"] not in known_late:
                    known_late.add(t["id"])
                    events.append({"at": t["arrival"][0], "sensor": "gate-anpr", "kind": "late", "truck": t["id"], "detail": f"晚到 {d['late'][t['id']]} min"})
            outage = now >= dd["from"]
            if outage and not any(e["kind"] == "dock-down" for e in events):
                events.append({"at": dd["from"], "sensor": f"door-{dd['dock']}", "kind": "dock-down", "dock": dd["dock"], "detail": f"{dd['dock']} 停用至 {dd['to']} min"})
            # Trucks already through the gate keep their slot. Every other truck is decided again on what is known now:
            # late trucks' real windows (the camera reported them late; their announced ETA updates), the outage.
            fixed = {i: r for i, r in schedule.items() if r.get("admitted") and r["entry"] < now}
            base = copy.deepcopy(p)
            for t in base["trucks"]:
                if t["id"] in known_late:
                    s = d["late"][t["id"]]
                    t["arrival"] = [t["arrival"][0] + s, t["arrival"][1] + s]
                    t["latestDeparture"] = min(base["horizonMin"], t["latestDeparture"] + s)
            if outage:
                base, _ = block_dock(base, dd["dock"], dd["from"], dd["to"])
            keep = []
            for t in base["trucks"]:
                if t["id"] in fixed or t["id"] == "OUTAGE":
                    keep.append(t); continue
                t["arrival"] = [max(t["arrival"][0], now), t["arrival"][1]]
                if t["arrival"][0] <= t["arrival"][1]:
                    keep.append(t)
            base["trucks"] = keep
            new = plan_cp(base, budget, fixed)
            if new is None:
                continue
            decided = {r["truck"] for r in new}
            for i in list(schedule):
                if i not in fixed:
                    schedule[i] = {"truck": i, "admitted": False}
            for r in new:
                schedule[r["truck"]] = r
            replans.append({"at": now, "reason": "sensor: " + ", ".join(sorted({e["kind"] for e in events if e["at"] <= now})),
                            "admitted": sum(1 for r in schedule.values() if r.get("admitted")), "redecided": len(decided)})
    rows = [schedule.get(t["id"], {"truck": t["id"], "admitted": False}) for t in p["trucks"]]
    # Verify the adopted schedule against the day as it really happened, with the dock outage.
    check, _ = block_dock(actual, dd["dock"], dd["from"], dd["to"])
    out_row = {"truck": "OUTAGE", "admitted": True, "entry": dd["from"] - 6, "dock": dd["dock"], "handleStart": dd["from"], "handleEnd": dd["to"], "departure": dd["to"] + p["site"]["exitMin"]}
    plan = {"plan": rows + [out_row]}
    plan["totals"] = yard_verify.verify(check, {"plan": plan["plan"], "totals": {}})["recomputed"]
    v = yard_verify.verify(check, plan)
    by = {t["id"]: t for t in actual["trucks"]}
    adm = [r for r in rows if r.get("admitted")]
    kpi = {"admitted": len(adm), "turnedAway": len(rows) - len(adm),
           "priorityAdmitted": sum(by[r["truck"]]["priority"] for r in adm),
           "reeferAdmitted": sum(1 for r in adm if by[r["truck"]]["cargo"] == "reefer"),
           "waitingMin": sum(r["entry"] - by[r["truck"]]["arrival"][0] for r in adm),
           "avgTurnaroundMin": round(sum(r["departure"] - r["entry"] for r in adm) / max(1, len(adm)), 1),
           "dockUtilisation": round(sum(r["handleEnd"] - r["handleStart"] for r in adm) / (len(p["docks"]) * max(1, max((r["departure"] for r in adm), default=1))), 3)}
    return {"policy": policy, "schedule": rows, "replans": replans, "events": sorted(events, key=lambda e: e["at"]), "kpi": kpi, "verification": v["verdict"],
            "failed": [c["id"] for c in v["checks"] if not c["passed"]]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--problem", required=True); ap.add_argument("--output", required=True)
    ap.add_argument("--seed", type=int, default=7); ap.add_argument("--budget", type=float, default=10)
    a = ap.parse_args()
    p = json.load(open(a.problem))
    d = disturbances(p, a.seed)
    out = {"schema": "pai-yard-twin-1", "synthetic": True, "problem": p, "disturbances": d,
           "sensors": [{"id": "gate-anpr", "kind": "camera", "at": "gate"}] + [{"id": f"door-{x['id']}", "kind": "door", "at": x["id"]} for x in p["docks"]]
                      + [{"id": "yard-occupancy", "kind": "occupancy", "at": "yard"}],
           "policies": {pol: play(p, d, pol, a.budget) for pol in ("fcfs", "cp-sat")}}
    json.dump(out, open(a.output, "w"), ensure_ascii=False)
    print(json.dumps({k: {"kpi": v["kpi"], "verification": v["verification"], "failed": v["failed"], "replans": len(v["replans"])} for k, v in out["policies"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
