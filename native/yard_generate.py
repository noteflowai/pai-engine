"""Seeded synthetic site-admission instances (pai-yard-problem-1). Labelled synthetic; not a real site.

Scenarios:
  normal    a morning shift: 24 trucks over 4 h, 6 docks (2 reefer), 2 gate lanes, 10 staging slots, 3 crews
  peak      the same site with 40 trucks bunched into a 90-minute peak: space and docks become the bottleneck
  overload  a truck no dock can take (cargo hazmat, no hazmat dock): it can never be admitted -> infeasible to admit all
"""
import argparse, json, random


def instance(seed, scenario):
    rng = random.Random(seed)
    docks = [{"id": f"D{k + 1}", "cargo": ["reefer", "standard"] if k < 2 else ["standard", "bulk"], "maxLengthM": 18.75 if k != 5 else 12.0} for k in range(6)]
    n = 40 if scenario == "peak" else 24
    span = 90 if scenario == "peak" else 240
    trucks = []
    for i in range(n):
        cargo = rng.choices(["standard", "reefer", "bulk"], [6, 2, 2])[0]
        length = rng.choice([12.0, 16.5, 18.75])
        earliest = rng.randrange(0, span)
        handle = rng.choice([20, 30, 40, 45, 60]) if cargo != "bulk" else rng.choice([45, 60, 75])
        trucks.append({"id": f"T{i + 1:02d}", "carrier": rng.choice(["Nordfracht", "Kanto Express", "Rio Cargo", "Atlas Haul"]),
                       "cargo": cargo, "lengthM": length, "slots": 1 if length <= 12 else 2, "crew": 2 if cargo == "bulk" else 1,
                       "arrival": [earliest, earliest + rng.choice([30, 45, 60, 90])], "handleMin": handle,
                       "latestDeparture": earliest + handle + rng.choice([120, 150, 180, 240]), "priority": rng.choice([1, 1, 1, 2, 3])})
    if scenario == "overload":
        trucks[3] = {**trucks[3], "cargo": "hazmat"}
    return {"schema": "pai-yard-problem-1", "synthetic": True, "label": f"synthetic site, scenario {scenario}, seed {seed}",
            "units": {"time": "min", "length": "m"}, "horizonMin": 600,
            "site": {"name": "Synthetic cross-dock site", "yardSlots": 10, "crews": 3, "exitMin": 10},
            "gate": {"lanes": 2, "processMin": 6}, "docks": docks, "trucks": trucks}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7); ap.add_argument("--scenario", choices=["normal", "peak", "overload"], default="normal")
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    with open(a.output, "w") as f:
        json.dump(instance(a.seed, a.scenario), f, indent=1)
