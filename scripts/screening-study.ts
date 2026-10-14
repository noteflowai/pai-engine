/**
 * Screening study: does surrogate screening pick better model-written variants than an unscreened pick?
 *
 * Groups of code variants (seeded perturbations of the bracket template: plate thickness, width, rib thickness and rib
 * leg, so most parts are off the recipe the surrogate was trained on) are screened exactly as the autopilot screens
 * them; then EVERY variant is reviewed natively (CalculiX), which gives the ground truth the policies are scored on:
 *   - screened: the variant the screening chose;
 *   - unscreened: one variant at random (expected value over the group);
 *   - oracle: the lightest variant CalculiX accepted.
 * The released bracket surrogate is copied (read-only) from the live store into this throw-away state and its own
 * acceptance is re-run on the copy. Runs with the release's code: tools/hosted_e2e.sh (E2E=screening-study).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL, type CadReview } from "../src/cad.js";
import { adapterOf, artifactFiles, getArtifact } from "../src/artifacts/registry.js";
import { DatabaseSync } from "node:sqlite";
import { screenVariants } from "../src/surrogate-screen.js";
import { closeAllWorkers } from "../src/kernel/engine-runtime.js";

const config = configuration();
const state = config.state;
const GROUPS = Number(process.env.STUDY_GROUPS ?? 5), PER = 4, SEED = 20261014;
const { app, store } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const post = async <T>(url: string, body: unknown) => { const r = await app.inject({ method: "POST", url, headers, payload: JSON.stringify(body) }); assert.ok(r.statusCode < 300, r.body); return r.json() as T; };
try {
  // The released artifact itself: its stored records copied read-only from the live database (an immutable version
  // cannot be rebuilt from a newer release's sources), then its own acceptance re-run on the copy.
  const live = new DatabaseSync(process.env.PAI_LIVE_DB ?? "/var/lib/pai/data/state/workbench.sqlite", { readOnly: true });
  const REF = process.env.STUDY_ARTIFACT ?? "structural-surrogate-bracket@1.0.0";
  const row = live.prepare("SELECT body FROM documents WHERE kind='artifact' AND id=?").get(REF) as { body: string } | undefined;
  assert.ok(row, `${REF} is not in the live store`);
  const released = JSON.parse(row.body);
  assert.equal(released.state, "released");
  store.insert("artifact", released);
  for (const f of live.prepare("SELECT body FROM documents WHERE kind='artifact-file' AND id LIKE ?").all(`${REF}/%`) as { body: string }[]) store.insert("artifact-file", JSON.parse(f.body));
  live.close();
  const a = getArtifact(store, REF);
  const recheck = await adapterOf(a.manifest.adapter).validate({ config, directory: await mkdir(join(state, "recheck"), { recursive: true }).then(() => join(state, "recheck")),
    files: artifactFiles(store, a), manifest: a.manifest });
  assert.equal(recheck.passed, true, "the copied artifact passes its own acceptance again");

  // Seeded variants of the template (mulberry32).
  let s = SEED; const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const u = (lo: number, hi: number) => Math.round((lo + (hi - lo) * rnd()) * 100) / 100;
  const template = await readFile(join(config.repository, "native/cad_template.py"), "utf8");
  const variant = () => { const v = { T: u(3.0, 5.5), W: u(52, 70), RIB: u(3, 7), LEG: u(14, 28) };
    return { v, code: template.replace("T = 4.0  ", `T = ${v.T}  `).replace("W = 60.0 ", `W = ${v.W} `).replace("RIB, RIB_LEG = 4.0, 20.0", `RIB, RIB_LEG = ${v.RIB}, ${v.LEG}`) }; };

  const project = await post<{ id: string }>("/api/projects", { title: "Screening study", intendedDecision: "Score surrogate screening against native reviews of every variant",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL };
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    const vs = Array.from({ length: PER }, (_, i) => ({ stepId: `g${g + 1}v${i + 1}`, ...variant() }));
    const t0 = Date.now();
    const screening = await screenVariants(store, config, "nema17-bracket", requirements, vs.map(v => ({ stepId: v.stepId, code: v.code })), join(state, "screen", `g${g + 1}`));
    const screenSeconds = (Date.now() - t0) / 1000;
    assert.ok(screening);
    const truth = [];
    for (const v of vs) {
      const t1 = Date.now();
      const r = await post<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "generated", requirements, source: { language: "cadquery-2.8", code: v.code } });
      const failed = r.candidate?.checks.filter(c => !c.passed).map(c => c.id) ?? [];
      const obs = (id: string) => Number(r.candidate?.checks.find(c => c.id === id)?.observed);
      const sc = screening!.variants.find(x => x.stepId === v.stepId)!;
      truth.push({ stepId: v.stepId, params: v.v, state: r.state, accepted: r.verdict === "accepted-cad-part", failed, massG: obs("mass"),
        deflectionMm: obs("max-deflection"), stressMPa: obs("max-stress"), reviewSeconds: (Date.now() - t1) / 1000,
        screenClass: sc.class, chosen: sc.chosen, prediction: sc.prediction });
    }
    const chosen = truth.find(t => t.chosen), accepted = truth.filter(t => t.accepted);
    groups.push({ group: g + 1, screenSeconds, variants: truth, screened: chosen ? { stepId: chosen.stepId, accepted: chosen.accepted, massG: chosen.massG } : null,
      unscreened: { acceptRate: accepted.length / PER, meanAcceptedMassG: accepted.length ? accepted.reduce((x, t) => x + t.massG, 0) / accepted.length : null },
      oracle: accepted.length ? { stepId: [...accepted].sort((x, y) => x.massG - y.massG)[0].stepId, massG: Math.min(...accepted.map(t => t.massG)) } : null });
    console.log(JSON.stringify({ group: g + 1, screened: groups.at(-1)!.screened, accepted: accepted.length, oracle: groups.at(-1)!.oracle }));
  }
  const all = groups.flatMap(g => g.variants);
  const predicted = all.filter(t => t.prediction && Number.isFinite(t.deflectionMm));
  const rel = (p: number, m: number) => Math.abs(p - m) / Math.abs(m);
  const median = (xs: number[]) => { const q = [...xs].sort((x, y) => x - y); return q.length ? q[Math.floor((q.length - 1) / 2)] : null; };
  const summary = {
    groups: groups.length, variants: all.length,
    screenedPickAccepted: groups.filter(g => g.screened?.accepted).length,
    unscreenedExpectedAccepted: Math.round(groups.reduce((x, g) => x + g.unscreened.acceptRate, 0) * 100) / 100,
    screenedPickIsOracle: groups.filter(g => g.oracle && g.screened?.stepId === g.oracle.stepId).length,
    groupsWithAnAccepted: groups.filter(g => g.oracle).length,
    massGapToOracleG: groups.filter(g => g.oracle && g.screened?.accepted).map(g => Math.round((g.screened!.massG - g.oracle!.massG) * 1000) / 1000),
    classVsTruth: Object.fromEntries(["likely-pass", "unknown", "likely-fail", "geometry-fail"].map(k => [k, { n: all.filter(t => t.screenClass === k).length, accepted: all.filter(t => t.screenClass === k && t.accepted).length }])),
    surrogateOffRecipe: { n: predicted.length, inDomain: predicted.filter(t => t.prediction!.inDomain).length,
      medianRelError: { deflectionMm: median(predicted.map(t => rel(t.prediction!.deflectionMm, t.deflectionMm))), stressMPa: median(predicted.map(t => rel(t.prediction!.stressMPa, t.stressMPa))), mass: median(predicted.map(t => rel(t.prediction!.mass, t.massG))) } },
    seconds: { screeningPerVariant: Math.round(groups.reduce((x, g) => x + g.screenSeconds, 0) / all.length * 10) / 10, reviewPerVariant: Math.round(all.reduce((x, t) => x + t.reviewSeconds, 0) / all.length * 10) / 10 },
  };
  await mkdir(join(state, "evidence"), { recursive: true });
  await writeFile(join(state, "evidence", "screening-study.json"), JSON.stringify({ schema: "pai-screening-study-1", result: "completed", seed: SEED, artifact: getArtifact(store, a.id).digest,
    perGroup: PER, requirements, summary, groups, rule: "ground truth = native review of every variant; the screening never saw those results", synthetic: true }, null, 1) + "\n");
  console.log(JSON.stringify(summary));
} finally { closeAllWorkers(); await app.close(); }
