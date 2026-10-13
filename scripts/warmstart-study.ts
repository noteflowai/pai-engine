// Paired study on the hosted site: physics optimisation cold vs warm-started from the released structural surrogate's
// measured dataset, at the same CalculiX budget, per part family and seed. Every number in the report is a CalculiX
// measurement made in that run (prior rows only train the GP, they are never counted as found).
// Usage: node --import tsx scripts/warmstart-study.ts <out.json> [seeds=1,2,3]
// Signs in with the private administrator login (.state/deploy/admin-login.json, never printed); creates one design
// task per family, runs the optimisations on AWS Batch, archives the tasks afterwards (records are kept).
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { FAMILY_DEFAULTS, FAMILY_STRUCTURAL, type CadFamily } from "../src/cad.js";
import { DEFAULT_OPTIMIZE_BUDGET } from "../src/optimize.js";

const SITE = "https://pai.oneai.host", out = process.argv[2] ?? "warmstart-study.json";
const seeds = (process.argv[3] ?? "1,2,3").split(",").map(Number);
const login = JSON.parse(await readFile(".state/deploy/admin-login.json", "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
async function signIn() {
  await page.goto(SITE, { timeout: 60_000 });
  if (await page.locator('input[name="username"]:visible').count()) {
    await page.locator('input[name="username"]:visible').first().fill(login.username);
    await page.locator('input[name="password"]:visible').first().fill(login.password);
    await page.locator('input[name="signInSubmitButton"]:visible').first().click();
  }
  await page.waitForURL(`${SITE}/**`);
}
await signIn();
// The ALB session expires during a multi-hour study: an HTML answer means sign in again and repeat the request.
// Repeating is safe: reads are reads, and every write carries its own requestId (the server returns the same record).
const call = async (m: "GET" | "POST", url: string, data?: unknown, again = true): Promise<any> => {
  const r = await page.request.fetch(`${SITE}/api${url}`, { method: m, headers: { Origin: SITE }, data, timeout: 300_000, maxRedirects: 0 });
  const text = await r.text();
  if (again && (r.status() >= 300 && r.status() < 400 || text.trimStart().startsWith("<"))) { await signIn(); return call(m, url, data, false); }
  const body = JSON.parse(text); if (r.status() >= 300) throw new Error(`${m} ${url}: ${r.status()} ${JSON.stringify(body).slice(0, 300)}`); return body;
};
type Point = { index: number; origin: string; fidelity: string; feasible: boolean | null; mass?: number; deflectionMm?: number };
type Run = { id: string; state: string; error?: string; warmStart?: { points: number; sources: string[] };
  result?: { points: Point[]; feasibleCount: number; lightestFeasible: number | null; warmStart?: { points: number; extraRounds: number; lightestPriorMassG: number | null } } };

async function optimise(projectId: string, family: CadFamily, warm: boolean, seed: number) {
  const t0 = Date.now();
  // Resumable: a run of this task with the same family, seed and warm start (completed or still running) is reused, never repeated.
  const state = await call("GET", "/state");
  const prior = (state.cadOptimizations ?? []).filter((o: any) => o.projectId === projectId && o.request.family === family && o.request.seed === seed
    && o.request.warmStart === warm && ["completed", "running"].includes(o.state)).at(-1);
  let r: Run = prior ? await call("GET", `/cad-optimizations/${prior.id}`) : await call("POST", `/projects/${projectId}/cad-optimizations`, { requestId: randomUUID(), projectRevision: 1, family, seed, warmStart: warm, solver: "batch",
    budget: DEFAULT_OPTIMIZE_BUDGET, requirements: { ...FAMILY_DEFAULTS[family], structural: FAMILY_STRUCTURAL[family] } });
  while (r.state === "running" && Date.now() - t0 < 3_600_000) { await page.waitForTimeout(10_000); r = await call("GET", `/cad-optimizations/${r.id}`); }
  const pts = r.result?.points ?? [], solved = pts.filter(p => p.fidelity === "fea");
  const best = pts.find(p => p.index === r.result?.lightestFeasible);
  // Solves until the run's final best was first reached (index order is measurement order).
  const reachedAt = best ? solved.filter(p => p.index <= best.index).length : null;
  return { recordId: r.id, family, seed, warm, state: r.state, error: r.error ?? null, solves: solved.length, feasible: r.result?.feasibleCount ?? 0,
    lightestFeasibleMassG: best?.mass ?? null, solvesToBest: reachedAt, priorPoints: r.result?.warmStart?.points ?? 0, priorSources: r.warmStart?.sources ?? [],
    lightestPriorMassG: r.result?.warmStart?.lightestPriorMassG ?? null, minutes: Math.round((Date.now() - t0) / 600) / 100 };
}

const runs: Awaited<ReturnType<typeof optimise>>[] = [], projects: string[] = [];
try {
  for (const family of ["nema17-bracket", "pillow-block"] as CadFamily[]) {
    const title = `部署核验：热启动配对研究（${family}）`;
    const existing = (await call("GET", "/state")).projects.filter((x: { title: string }) => x.title === title)
      .sort((a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const p = existing ?? await call("POST", "/projects", { title, intendedDecision: "同一 CalculiX 预算下比较冷启动与用代理模型数据集热启动的寻优结果",
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
    projects.push(p.id);
    for (const seed of seeds) {
      // Cold and warm of the same seed run side by side: same budget, same queue conditions.
      const pair = await Promise.all([optimise(p.id, family, false, seed), optimise(p.id, family, true, seed)]);
      runs.push(...pair);
      console.log(JSON.stringify(pair.map(r => [r.family, r.seed, r.warm ? "warm" : "cold", r.state, r.lightestFeasibleMassG, r.solvesToBest, r.priorPoints])));
    }
  }
} finally {
  for (const id of projects) await call("POST", `/projects/${id}/archive`, { archived: true, reason: "热启动配对研究的核验任务，非业务；只隐藏，记录保留" }).catch(() => undefined);
  const summary = Object.fromEntries(["nema17-bracket", "pillow-block"].map(f => {
    const pairs = seeds.map(s => [runs.find(r => r.family === f && r.seed === s && !r.warm), runs.find(r => r.family === f && r.seed === s && r.warm)]).filter(([c, w]) => c && w) as [typeof runs[0], typeof runs[0]][];
    const both = pairs.filter(([c, w]) => c.lightestFeasibleMassG !== null && w.lightestFeasibleMassG !== null);
    return [f, { pairs: pairs.length, warmLighter: both.filter(([c, w]) => w.lightestFeasibleMassG! < c.lightestFeasibleMassG! - 1e-9).length,
      equal: both.filter(([c, w]) => Math.abs(w.lightestFeasibleMassG! - c.lightestFeasibleMassG!) <= 1e-9).length,
      coldLighter: both.filter(([c, w]) => c.lightestFeasibleMassG! < w.lightestFeasibleMassG! - 1e-9).length,
      massDeltaG: both.map(([c, w]) => Math.round((w.lightestFeasibleMassG! - c.lightestFeasibleMassG!) * 1000) / 1000),
      solvesToBest: { cold: pairs.map(([c]) => c.solvesToBest), warm: pairs.map(([, w]) => w.solvesToBest) },
      noFeasible: { cold: pairs.filter(([c]) => c.lightestFeasibleMassG === null).length, warm: pairs.filter(([, w]) => w.lightestFeasibleMassG === null).length } }];
  }));
  await writeFile(out, JSON.stringify({ schema: "pai-warmstart-study-1", site: SITE, checkedAt: new Date().toISOString(), budget: DEFAULT_OPTIMIZE_BUDGET, seeds, solver: "aws-batch",
    rule: "found = measured by CalculiX in that run; prior rows only train the GP", summary, runs }, null, 1) + "\n");
  console.log(JSON.stringify(summary));
  await browser.close();
}
