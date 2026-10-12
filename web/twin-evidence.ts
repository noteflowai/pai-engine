/**
 * Yard digital twin, recorded run (docs/evidence/yard-twin.json; native/yard_twin.py, real CP-SAT re-planning on sensor
 * events, both final schedules verified independently). Kept equal to the evidence file by tests/twin-evidence.test.ts.
 */
export const TWIN = {
  recordedAt: "2026-10-11T05:18:14.055Z", synthetic: true, replans: 5,
  disturbances: "3 辆车晚到（门岗车牌识别）· D4 月台停用 30 分钟（门磁）",
  fcfs: {"admitted": 16, "turnedAway": 8, "priorityAdmitted": 24, "reeferAdmitted": 4, "waitingMin": 432, "avgTurnaroundMin": 102.8, "dockUtilisation": 0.241},
  cpSat: {"admitted": 24, "turnedAway": 0, "priorityAdmitted": 38, "reeferAdmitted": 5, "waitingMin": 545, "avgTurnaroundMin": 66, "dockUtilisation": 0.31},
} as const;
