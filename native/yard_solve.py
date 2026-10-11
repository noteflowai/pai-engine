"""Site admission and yard scheduling with OR-Tools CP-SAT (pai-yard-problem-1 -> pai-yard-plan-1).

A site with limited space receives trucks. Each truck may enter within its arrival window, passes a gate lane, waits
on a staging slot if needed, is handled at a compatible dock door by a crew, and leaves by its latest departure.
Decisions per truck: admitted or not, entry time, dock, handling start, departure.

Model (all times integer minutes):
- entry  : interval [entry, entry + gateMin) on the gate          -> Cumulative(gate lanes)
- onsite : interval [entry, departure) occupying `slots`           -> Cumulative(yard slots)   (space on site)
- handle : one optional interval per compatible dock              -> NoOverlap per dock; exactly one if admitted
           each handling also needs `crew` crews                   -> Cumulative(crews)
- departure = handling end + exitMin <= latestDeparture; entry >= earliest, entry <= latestEntry
Objective (lexicographic, exact): maximise the priority-weighted admitted trucks, then minimise the priority-weighted
waiting (entry - earliest) plus time on site. Deterministic: one worker, fixed seed; `optimal` means proven.

`--baseline` is first-come-first-served for comparison only: trucks in order of earliest arrival, each placed at the
earliest time where gate, a compatible dock, crews and yard space are free; a truck that cannot fit is turned away.
"""
from __future__ import annotations
import argparse, json, resource, sys, time


def load(path):
    with open(path) as f:
        return json.load(f)


def compatible(truck, dock):
    return truck["cargo"] in dock["cargo"] and truck["lengthM"] <= dock["maxLengthM"]


def solve(p, time_limit, strategy):
    from ortools.sat.python import cp_model
    H = p["horizonMin"]
    m = cp_model.CpModel()
    trucks, docks = p["trucks"], p["docks"]
    gate, site = p["gate"], p["site"]
    admitted, entry, depart, handles, onsite, gate_iv, crew_iv = {}, {}, {}, {}, {}, {}, {}
    for t in trucks:
        i = t["id"]
        a = m.NewBoolVar(f"adm_{i}")
        admitted[i] = a
        e = m.NewIntVar(0, H, f"entry_{i}")
        d = m.NewIntVar(0, H, f"depart_{i}")
        entry[i], depart[i] = e, d
        m.Add(e >= t["arrival"][0]).OnlyEnforceIf(a)
        m.Add(e <= t["arrival"][1]).OnlyEnforceIf(a)
        m.Add(d <= t["latestDeparture"]).OnlyEnforceIf(a)
        gate_iv[i] = m.NewOptionalFixedSizeIntervalVar(e, gate["processMin"], a, f"gate_{i}")
        size = m.NewIntVar(0, H, f"stay_{i}")
        onsite[i] = m.NewOptionalIntervalVar(e, size, d, a, f"onsite_{i}")
        options = []
        for k, dock in enumerate(docks):
            if not compatible(t, dock):
                continue
            b = m.NewBoolVar(f"at_{i}_{k}")
            s = m.NewIntVar(0, H, f"start_{i}_{k}")
            iv = m.NewOptionalFixedSizeIntervalVar(s, t["handleMin"], b, f"handle_{i}_{k}")
            m.Add(s >= e + gate["processMin"]).OnlyEnforceIf(b)
            m.Add(d == s + t["handleMin"] + site["exitMin"]).OnlyEnforceIf(b)
            options.append((k, b, s, iv))
            crew_iv.setdefault(i, []).append(iv)
        handles[i] = options
        m.Add(sum(b for _, b, _, _ in options) == 1).OnlyEnforceIf(a)
        m.Add(sum(b for _, b, _, _ in options) == 0).OnlyEnforceIf(a.Not())
        if not options:
            m.Add(a == 0)
    for k in range(len(docks)):
        m.AddNoOverlap([iv for i in handles for (kk, _, _, iv) in handles[i] if kk == k])
    m.AddCumulative(list(gate_iv.values()), [1] * len(gate_iv), gate["lanes"])
    m.AddCumulative([onsite[t["id"]] for t in trucks], [t["slots"] for t in trucks], site["yardSlots"])
    crew_list = [(iv, t["crew"]) for t in trucks for iv in crew_iv.get(t["id"], [])]
    if crew_list:
        m.AddCumulative([c[0] for c in crew_list], [c[1] for c in crew_list], site["crews"])

    weight = {t["id"]: t["priority"] for t in trucks}
    admitted_score = sum(weight[i] * admitted[i] for i in admitted)
    # waiting and time on site are 0 for turned-away trucks
    wait_terms = []
    for t in trucks:
        i = t["id"]
        w = m.NewIntVar(0, H, f"wait_{i}")
        m.Add(w == entry[i] - t["arrival"][0]).OnlyEnforceIf(admitted[i])
        m.Add(w == 0).OnlyEnforceIf(admitted[i].Not())
        stay = m.NewIntVar(0, H, f"stayc_{i}")
        m.Add(stay == depart[i] - entry[i]).OnlyEnforceIf(admitted[i])
        m.Add(stay == 0).OnlyEnforceIf(admitted[i].Not())
        wait_terms.append(weight[i] * w + stay)
    secondary = sum(wait_terms)
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1 if strategy == "deterministic" else 8
    solver.parameters.random_seed = 7
    t0 = time.time()
    # Budget in CP-SAT's deterministic time (work units), so one worker with a fixed seed gives the same schedule on
    # every run; wall time is only a safety stop, and hitting it makes the result non-replayable.
    det = time_limit / 2
    solver.parameters.max_deterministic_time = det
    wall_cap = time_limit * 4
    # Phase 1: most priority-weighted admissions. Phase 2: fix that, minimise weighted waiting + time on site.
    m.Maximize(admitted_score)
    solver.parameters.max_time_in_seconds = wall_cap
    s1 = solver.Solve(m)
    wall_hit = solver.WallTime() >= wall_cap * 0.98
    if s1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": {cp_model.INFEASIBLE: "infeasible", cp_model.MODEL_INVALID: "error"}.get(s1, "timeout" if solver.DeterministicTime() >= det * 0.98 or wall_hit else "unknown"),
                "plan": None, "proven": False, "seconds": time.time() - t0, "phases": [solver.StatusName(s1)]}
    best = int(round(solver.ObjectiveValue()))
    proven1 = s1 == cp_model.OPTIMAL
    m.Add(admitted_score >= best)
    m.ClearObjective()
    m.Minimize(secondary)
    hint = {v: solver.Value(v) for v in list(admitted.values()) + list(entry.values()) + list(depart.values())}
    for v, val in hint.items():
        m.AddHint(v, val)
    solver.parameters.max_time_in_seconds = wall_cap
    s2 = solver.Solve(m)
    wall_hit = wall_hit or solver.WallTime() >= wall_cap * 0.98
    if s2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": "timeout", "plan": None, "proven": False, "seconds": time.time() - t0, "phases": [solver.StatusName(s1), solver.StatusName(s2)]}
    plan = []
    for t in trucks:
        i = t["id"]
        if not solver.Value(admitted[i]):
            plan.append({"truck": i, "admitted": False})
            continue
        k, s = next((k, solver.Value(s)) for k, b, s, _ in handles[i] if solver.Value(b))
        plan.append({"truck": i, "admitted": True, "entry": solver.Value(entry[i]), "dock": docks[k]["id"], "handleStart": s,
                     "handleEnd": s + t["handleMin"], "departure": solver.Value(depart[i])})
    return {"status": "solved", "plan": plan, "proven": proven1 and s2 == cp_model.OPTIMAL, "seconds": time.time() - t0, "wallStopped": wall_hit,
            "phases": [solver.StatusName(s1), solver.StatusName(s2)], "objective": {"admittedScore": best, "secondary": int(round(solver.ObjectiveValue()))}}


def fcfs(p):
    """First-come-first-served: earliest arrival first, earliest feasible start; minute-by-minute capacity tables."""
    H = p["horizonMin"]
    gate, site, docks = p["gate"], p["site"], p["docks"]
    gate_use, yard_use, crew_use = [0] * (H + 1), [0] * (H + 1), [0] * (H + 1)
    dock_busy = {d["id"]: [False] * (H + 1) for d in docks}
    plan = []
    for t in sorted(p["trucks"], key=lambda t: (t["arrival"][0], t["id"])):
        placed = None
        for e in range(t["arrival"][0], t["arrival"][1] + 1):
            if any(gate_use[x] >= gate["lanes"] for x in range(e, min(H, e + gate["processMin"]))):
                continue
            for d in docks:
                if not compatible(t, d):
                    continue
                for s in range(e + gate["processMin"], H - t["handleMin"] - site["exitMin"] + 1):
                    end = s + t["handleMin"]
                    dep = end + site["exitMin"]
                    if dep > t["latestDeparture"]:
                        break
                    if any(dock_busy[d["id"]][x] for x in range(s, end)) or any(crew_use[x] + t["crew"] > site["crews"] for x in range(s, end)):
                        continue
                    if any(yard_use[x] + t["slots"] > site["yardSlots"] for x in range(e, dep)):
                        continue
                    placed = (e, d["id"], s, end, dep)
                    break
                if placed:
                    break
            if placed:
                break
        if not placed:
            plan.append({"truck": t["id"], "admitted": False})
            continue
        e, dk, s, end, dep = placed
        for x in range(e, e + gate["processMin"]):
            gate_use[x] += 1
        for x in range(e, dep):
            yard_use[x] += t["slots"]
        for x in range(s, end):
            crew_use[x] += t["crew"]
            dock_busy[dk][x] = True
        plan.append({"truck": t["id"], "admitted": True, "entry": e, "dock": dk, "handleStart": s, "handleEnd": end, "departure": dep})
    return sorted(plan, key=lambda r: [x["id"] for x in p["trucks"]].index(r["truck"]))


def totals(p, plan):
    by = {t["id"]: t for t in p["trucks"]}
    adm = [r for r in plan if r["admitted"]]
    return {"admitted": len(adm), "turnedAway": [r["truck"] for r in plan if not r["admitted"]],
            "priorityAdmitted": sum(by[r["truck"]]["priority"] for r in adm),
            "waitingMin": sum(r["entry"] - by[r["truck"]]["arrival"][0] for r in adm),
            "onSiteMin": sum(r["departure"] - r["entry"] for r in adm),
            "lastDeparture": max((r["departure"] for r in adm), default=0)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--problem", required=True); ap.add_argument("--output", required=True)
    ap.add_argument("--baseline", action="store_true"); ap.add_argument("--time-limit", type=float, default=20)
    ap.add_argument("--strategy", choices=["deterministic", "parallel"], default="deterministic")
    a = ap.parse_args()
    p = load(a.problem)
    t0 = time.time()
    if a.baseline:
        plan = fcfs(p)
        out = {"status": "feasible" if all(r["admitted"] for r in plan) else "partial", "plan": plan,
               "solver": {"name": "first-come-first-served", "proven": False, "replayable": True}}
    else:
        r = solve(p, a.time_limit, a.strategy)
        if r["plan"] is None:
            out = {"status": r["status"], "plan": [], "solver": {"name": "or-tools cp-sat", "proven": False, "phases": r["phases"], "replayable": False}}
        else:
            all_in = all(x["admitted"] for x in r["plan"])
            out = {"status": ("optimal" if r["proven"] else "feasible") if all_in else ("partial-optimal" if r["proven"] else "partial"), "plan": r["plan"],
                   "solver": {"name": "or-tools cp-sat", "proven": r["proven"], "phases": r["phases"], "objective": r["objective"],
                              # One worker, fixed seed, deterministic-time budget: the same schedule on every run, unless the wall-time safety stop fired.
                              "replayable": a.strategy == "deterministic" and not r["wallStopped"], "strategy": a.strategy, "deterministicBudget": a.time_limit}}
    out = {"schema": "pai-yard-plan-1", **out, "totals": totals(p, out["plan"]) if out["plan"] else None,
           "usage": {"wallSeconds": round(time.time() - t0, 3), "cpuSeconds": round(resource.getrusage(resource.RUSAGE_SELF).ru_utime, 3),
                     "maxRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}
    with open(a.output, "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps({"status": out["status"], "totals": out["totals"]}))


if __name__ == "__main__":
    sys.exit(main())
