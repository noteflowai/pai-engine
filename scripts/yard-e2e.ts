/**
 * Site admission artifact end to end, with the real CP-SAT solver: build → own benchmark → release → workflow
 * (schedule → independent verify → condition → controller approval) on the peak scenario, the same instance by
 * first-come-first-served for comparison, and a schedule figure (docs/media/yard-demo.svg) drawn from the verified
 * plans. Synthetic, labelled data; nothing is dispatched. Evidence: .state/evidence/yard-e2e.json.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { yardWorkflow } from "../src/artifacts/samples.js";

const base = configuration();
const state = join(base.state, "yard-e2e", randomUUID());
const config = { ...base, state, controllerEntrypoint: undefined, controllerDatabase: undefined, albAuth: undefined, agentAuth: undefined, publicOrigin: undefined };
const { app } = await createApp(config, {} as never);
const host = `127.0.0.1:${config.port}`;
const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { host, ...(payload === undefined ? {} : { "content-type": "application/json" }) } });
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.json();
};
type Row = { truck: string; admitted: boolean; entry?: number; dock?: string; handleStart?: number; handleEnd?: number; departure?: number };
type Plan = { status: string; plan: Row[]; totals: { admitted: number; priorityAdmitted: number; waitingMin: number; onSiteMin: number; turnedAway: string[] }; solver: Record<string, unknown> };

try {
  if (!config.logisticsPython) throw new Error("PAI_LOGISTICS_PYTHON is required (python3 tools/setup_logistics.py)");
  const REF = "yard-admission@1.0.0";
  assert.equal((await call("POST", "/api/v1/artifacts", { adapter: "yard-admission", version: "1.0.0" })).state, "draft");
  const validated = await call("POST", `/api/v1/artifacts/${REF}/validation`);
  assert.equal(validated.state, "validated", JSON.stringify(validated.validation?.evidence?.expectations));
  await call("POST", `/api/v1/artifacts/${REF}/lifecycle`, { to: "released", reason: "Benchmark verified on synthetic sites" });
  const workflow = await call("POST", "/api/v1/workflows", yardWorkflow(REF));
  const problem = await call("POST", `/api/v1/artifacts/${REF}/samples`, { scenario: "peak", seed: 7 });
  const waiting = await call("POST", "/api/v1/workflow-runs", { requestId: randomUUID(), workflow: workflow.id, inputs: { problem } });
  assert.equal(waiting.state, "waiting-approval", JSON.stringify(waiting.nodes));
  assert.equal(waiting.nodes.verify.status, "valid-schedule");
  const done = await call("POST", `/api/v1/workflow-runs/${waiting.id}/decisions`, { node: "controller", approve: true, reason: "场地调度员核对后确认（合成实例）" });
  assert.equal(done.state, "succeeded");
  const cp = await call("GET", `/api/v1/workflow-runs/${done.id}/data?name=plan`) as Plan;
  // Same instance, first-come-first-served, through the same independent verifier (direct, outside the workflow).
  const dir = join(state, "fcfs"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "p.json"), JSON.stringify(problem));
  execFileSync("python3", ["-I", "native/yard_solve.py", "--problem", join(dir, "p.json"), "--output", join(dir, "fcfs.json"), "--baseline"], { cwd: base.repository });
  execFileSync("python3", ["-I", "native/yard_verify.py", "--problem", join(dir, "p.json"), "--plan", join(dir, "fcfs.json"), "--output", join(dir, "v.json")], { cwd: base.repository });
  const fcfs = JSON.parse(await readFile(join(dir, "fcfs.json"), "utf8")) as Plan;
  assert.equal(JSON.parse(await readFile(join(dir, "v.json"), "utf8")).verdict, "valid-schedule");
  assert.ok(cp.totals.priorityAdmitted >= fcfs.totals.priorityAdmitted);

  await writeFile(join(base.repository, "docs/media/yard-demo.svg"), figure(problem, cp, fcfs));
  const evidence = { schema: "pai-yard-e2e-1", checkedAt: new Date().toISOString(), result: "passed", synthetic: true,
    artifact: { id: REF, digest: validated.digest, benchmark: validated.validation.evidence },
    run: { id: done.id, state: done.state, verify: waiting.nodes.verify.status, usage: done.nodes.schedule.usage?.native },
    peak: { trucks: problem.trucks.length, cpSat: { ...cp.totals, status: cp.status, solver: cp.solver }, firstComeFirstServed: { ...fcfs.totals, status: fcfs.status } } };
  await mkdir(join(base.state, "evidence"), { recursive: true });
  await writeFile(join(base.state, "evidence", "yard-e2e.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ result: "passed", peak: evidence.peak, benchmark: validated.validation.evidence.comparison }));
} finally { await app.close(); await rm(state, { recursive: true, force: true }); }

/** Two dock Gantt charts (CP-SAT vs first-come-first-served) plus yard occupancy against capacity, from verified plans. */
function figure(p: { trucks: { id: string; cargo: string; arrival: [number, number]; priority: number }[]; docks: { id: string }[]; site: { yardSlots: number }; horizonMin: number },
  a: Plan, b: Plan) {
  const W = 1200, left = 70, end = Math.min(p.horizonMin, Math.max(...[...a.plan, ...b.plan].map(r => r.departure ?? 0)) + 20), x = (t: number) => left + (t / end) * (W - left - 20);
  const color: Record<string, string> = { standard: "#2f7d6b", reefer: "#2c6fb0", bulk: "#a2652a" };
  const byId = new Map(p.trucks.map(t => [t.id, t]));
  const gantt = (plan: Plan, top: number, title: string) => {
    const h = 26, rows = p.docks.map((d, i) => `<text x="${left - 10}" y="${top + 34 + i * h + 17}" text-anchor="end" class="l">${d.id}</text>`
      + `<rect x="${left}" y="${top + 34 + i * h}" width="${W - left - 20}" height="${h - 4}" fill="#f2f5f4"/>`).join("");
    const bars = plan.plan.filter(r => r.admitted).map(r => { const i = p.docks.findIndex(d => d.id === r.dock), t = byId.get(r.truck)!;
      return `<rect x="${x(r.handleStart!)}" y="${top + 34 + i * h}" width="${Math.max(2, x(r.handleEnd!) - x(r.handleStart!))}" height="${h - 4}" rx="3" fill="${color[t.cargo] ?? "#666"}"/>`
        + `<text x="${x(r.handleStart!) + 3}" y="${top + 34 + i * h + 15}" class="b">${r.truck}</text>`; }).join("");
    const t = plan.totals;
    return `<text x="${left}" y="${top + 20}" class="h">${title}</text><text x="${W - 20}" y="${top + 20}" text-anchor="end" class="s">入场 ${t.admitted}/${p.trucks.length} 辆 · 优先级分 ${t.priorityAdmitted} · 拒绝 ${t.turnedAway.length} · 总等待 ${t.waitingMin} min</text>${rows}${bars}`;
  };
  const occupancy = (plan: Plan, top: number, stroke: string) => {
    const pts: string[] = [];
    for (let m = 0; m <= end; m += 2) { const use = plan.plan.filter(r => r.admitted && r.entry! <= m && m < r.departure!).reduce((s, r) => s + (byId.get(r.truck) as unknown as { slots: number }).slots, 0);
      pts.push(`${x(m)},${top + 90 - (use / p.site.yardSlots) * 80}`); }
    return `<polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts.join(" ")}"/>`;
  };
  const gh = 34 + p.docks.length * 26 + 20, top2 = gh + 10, top3 = top2 + gh + 10;
  const ticks = Array.from({ length: Math.floor(end / 30) + 1 }, (_, i) => i * 30).map(t => `<text x="${x(t)}" y="${top3 + 110}" text-anchor="middle" class="s">${String(Math.floor(t / 60) + 6).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${top3 + 140}" font-family="Inter, 'Noto Sans SC', sans-serif">
<style>.h{font-size:15px;font-weight:700;fill:#17262c}.s{font-size:12px;fill:#4b5d64}.l{font-size:12px;fill:#17262c}.b{font-size:10px;fill:#fff}</style>
<rect width="100%" height="100%" fill="#fff"/>
${gantt(a, 0, "OR-Tools CP-SAT：准入 + 排队 + 月台分配（独立核验通过）")}
${gantt(b, top2, "先到先服务（FCFS，对照基线，独立核验通过）")}
<text x="${left}" y="${top3 + 4}" class="h">场内占用（堆场车位 ${p.site.yardSlots} 个）</text>
<line x1="${left}" x2="${W - 20}" y1="${top3 + 10}" y2="${top3 + 10}" stroke="#a8461f" stroke-dasharray="4 4"/><text x="${W - 20}" y="${top3 + 8}" text-anchor="end" class="s">容量上限</text>
${occupancy(a, top3, "#1d6b5b")}${occupancy(b, top3, "#999")}
<text x="${left}" y="${top3 + 128}" class="s">绿色 CP-SAT · 灰色 FCFS · 货型：绿 普货 / 蓝 冷链 / 棕 散货 · 合成场地（种子 7，高峰 ${p.trucks.length} 辆 90 分钟内到达），不派车</text>${ticks}
</svg>
`;
}
