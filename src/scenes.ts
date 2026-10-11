import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { command, NativeAdapters, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Feedback, type Project, type Receipt, type DiffResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { nativeRun } from "./kernel/native-run.js";
import { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import type { CadReview } from "./cad.js";
import { familyOf } from "./part-family.js";
import { NativeEvent, type SceneStage } from "./kernel/native-events.js";
export { NativeEvent, type SceneStage } from "./kernel/native-events.js";
import { sandboxArgs } from "./sandbox.js";

export interface SceneRay { origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean; frame: "gltf-y-up" }

export const SceneRequirements = z.object({
  maxFootprintArea: z.number().min(1).max(100),
  targetEnvelopeRadius: z.number().min(0.1).max(10),
  requireTargetVisible: z.boolean(),
}).strict();
/** Factory production-line layout: a bounded parameter set for the native plant recipe (no user code). */
export const PlantLayout = z.object({
  stations: z.number().int().min(3).max(8), stationPitch: z.number().min(3.5).max(7),
  aisleWidth: z.number().min(1.2).max(4.5), guardSize: z.number().min(2.6).max(5),
  rackRows: z.number().int().min(1).max(4), cameraHeight: z.number().min(2.4).max(6.5), agvs: z.number().int().min(0).max(4),
}).strict();
export const PlantRequirements = z.object({
  maxFootprintArea: z.number().min(50).max(5000), minAisleWidth: z.number().min(0.8).max(5),
  minGuardClearance: z.number().min(0).max(2), requireCameraCoverage: z.boolean(), maxEgressTravel: z.number().min(5).max(100),
}).strict();
/** Reference line used as the baseline of every plant review; it is measured natively like any candidate. */
export const PLANT_REFERENCE: z.infer<typeof PlantLayout> = { stations: 4, stationPitch: 5, aisleWidth: 3.2, guardSize: 4.0, rackRows: 2, cameraHeight: 4.5, agvs: 2 };
export const DEFAULT_PLANT_REQUIREMENTS: z.infer<typeof PlantRequirements> = { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 };
/** Robot workcell for MuJoCo (generic 6-axis arm, UR5e-class link lengths): bounded parameters only. */
export const RobotCell = z.object({
  pickDistance: z.number().min(0.25).max(1.1), placeDistance: z.number().min(0.25).max(1.1), pickHeight: z.number().min(0.6).max(1.2), placeHeight: z.number().min(0.6).max(1.2),
  pedestalHeight: z.number().min(0.3).max(1.0), guardClearance: z.number().min(0.1).max(1.5), speedFraction: z.number().min(0.1).max(1.0), jitter: z.number().min(0).max(0.08),
}).strict();
/**
 * End-effector part from the CAD lane: an accepted CAD review of the same project, mounted on the gripper with its exact
 * STL (mass and inertia from the mesh, cross-checked against the B-Rep mass) plus a declared payload (default: a NEMA 17
 * motor, 0.28 kg). The same tool is used for the reference and the candidate cell, so the comparison isolates the cell.
 */
export const RobotTool = z.object({ cadReviewId: Id, payloadKg: z.number().min(0).max(3).default(0.28) }).strict();
export const RobotRequirements = z.object({ maxCycleSeconds: z.number().min(1).max(60), minSuccessRate: z.number().min(0).max(1) }).strict();
export const ROBOT_REFERENCE: z.infer<typeof RobotCell> = { pickDistance: 0.55, placeDistance: 0.55, pickHeight: 0.85, placeHeight: 0.85, pedestalHeight: 0.7, guardClearance: 0.4, speedFraction: 0.5, jitter: 0.03 };
export const DEFAULT_ROBOT_REQUIREMENTS: z.infer<typeof RobotRequirements> = { maxCycleSeconds: 6, minSuccessRate: 0.9 };
export const ROBOT_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
export const ROBOT_CHECKS = ["reach", "collision-free", "cycle-time", "success-rate"] as const;
export const PLANT_CHECKS = ["footprint-area", "aisle-clearance", "guard-clearance", "camera-coverage", "egress-travel"] as const;
const Common = { requestId: Id, projectRevision: z.number().int().positive(), feedbackId: Id.optional() };
export const SceneRequest = z.union([
  z.object({ ...Common, variant: z.enum(["clear", "occluded"]), requirements: SceneRequirements }).strict(),
  z.object({ ...Common, variant: z.literal("plant"), layout: PlantLayout, requirements: PlantRequirements }).strict(),
  z.object({ ...Common, variant: z.literal("robot-cell"), cell: RobotCell, requirements: RobotRequirements, tool: RobotTool.optional() }).strict(),
]);
export type SceneRequestValue = z.infer<typeof SceneRequest>;
export const SceneChecks = z.union([
  z.object({
    schema: z.literal("pai-blender-checks-1"), blenderVersion: z.string(), variant: z.enum(["clear", "occluded"]),
    checks: z.array(z.object({ id: z.enum(["footprint-area", "declared-target-envelope", "camera-visibility"]),
      passed: z.boolean() }).passthrough()).length(3),
    scope: z.literal("generated-static-geometry"), physicalValidation: z.literal(false),
  }).passthrough(),
  z.object({
    schema: z.literal("pai-blender-plant-checks-1"), blenderVersion: z.string(), variant: z.literal("plant"), layout: PlantLayout,
    checks: z.array(z.object({ id: z.enum(PLANT_CHECKS), passed: z.boolean() }).passthrough()).length(5),
    scope: z.literal("generated-static-geometry"), physicalValidation: z.literal(false),
  }).passthrough(),
  z.object({
    schema: z.literal("pai-robot-cell-checks-1"), engine: z.string(), variant: z.literal("robot-cell"), cell: RobotCell,
    checks: z.array(z.object({ id: z.enum(ROBOT_CHECKS), passed: z.boolean() }).passthrough()).length(4),
    trials: z.array(z.object({ seed: z.number().int(), success: z.boolean(), reached: z.boolean(), collisionFree: z.boolean(), cycleSeconds: z.number() }).strict()).min(1).max(32),
    successRate: z.number(), scope: z.literal("rigid-body-simulation"), physicalValidation: z.literal(false),
  }).passthrough(),
]);
export interface SceneReview {
  id: string; projectId: string; projectRevision: number; request: SceneRequestValue;
  requirementDigest: string; state: "running" | "completed" | "failed" | "interrupted"; error?: string;
  createdAt: string; finishedAt?: string; feedbackId?: string; verdict?: "accepted-static-scene" | "rejected";
  baseline?: z.infer<typeof SceneChecks>; candidate?: z.infer<typeof SceneChecks>; diff?: DiffResult;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>; rays?: Partial<Record<"baseline" | "candidate", SceneRay>>;
  scope: "generated-static-geometry" | "rigid-body-simulation"; physicalValidation: false;
  /** Robot cells with a CAD end-effector: provenance and the native mass cross-check. */
  tool?: { cadReviewId: string; stlSha256: string; brepMassG: number; mujocoMassG?: number; payloadKg: number; motorAxisMm: number };
  /** OpenUSD export summary (UsdPhysics bodies, joints, validators run). */
  usd?: { usdVersion: string; rigidBodies: number; joints: string[]; validators: number;
    /** Cross-engine conformance of the exported USD: Newton imports it and matches the MJCF kinematics and masses. */
    newton?: { version: string; passed: boolean; configurations: number; fkPositionM: number; fkOrientationDeg: number; checks: { id: string; passed: boolean }[] } | { error: string } };
  /** Conformance of the simulated arm with the official model Strands Robots loads (pinned Menagerie, offline, sim only). */
  robots?: { robot: string; strandsRobots: string; menagerieCommit: string; passed: boolean; configurations: number; isolation: "bwrap-unshare-all";
    checks: { id: string; passed: boolean; observed: unknown; limit?: number; unit?: string }[] } | { error: string };
}
export type PlantLayoutValue = z.infer<typeof PlantLayout>;
export type PlantRequirementsValue = z.infer<typeof PlantRequirements>;
export type WorkcellScene = SceneReview & { request: Extract<SceneRequestValue, { variant: "clear" | "occluded" }> };
export type PlantScene = SceneReview & { request: Extract<SceneRequestValue, { variant: "plant" }> };
export const isPlant = (s: SceneReview): s is PlantScene => s.request.variant === "plant";
/** Derived hall size of the native plant recipe (metres); the same formula as native/blender_plant.py. */
export const plantHall = (l: PlantLayoutValue) => ({ x: l.stations * l.stationPitch + 12, y: 10.95 + l.aisleWidth + 1.35 * l.rackRows });
/** Identity of a scene candidate: recipe, its layout parameters and the static requirements. */
export const sceneKey = (r: SceneRequestValue) => `${r.variant}:${canonical(r.variant === "plant" ? r.layout : r.variant === "robot-cell" ? { cell: r.cell, tool: r.tool ?? null } : null)}:${canonical(r.requirements)}`;
export const isRobotCell = (s: SceneReview): s is SceneReview & { request: Extract<SceneRequestValue, { variant: "robot-cell" }> } => s.request.variant === "robot-cell";
export function sceneCaseText(run: SceneReview) {
  if (run.request.variant === "plant") {
    return `# Blender factory production-line layout review\n\nDecision: ${run.verdict ?? "pending"}; layout: ${canonical(run.request.layout)}.\n`
      + `Native Blender: ${run.candidate?.blenderVersion ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
      + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
      + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
      + "Scope: synthetic explicit factory recipe measured with native ray casts (aisle, guard, camera coverage, egress). Illustrative animation only; no dynamics, joint limits, throughput, lighting levels, safety certification or measured plant data.\n";
  }
  return `# Blender workcell design review\n\nDecision: ${run.verdict ?? "pending"}; variant: ${run.request.variant}.\n`
    + `Native Blender: ${run.candidate?.blenderVersion ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
    + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: generated static geometry from an explicit synthetic recipe; editable .blend and GLB artifacts. No dynamics, joint reachability, measured factory twin, manufacturability or physical validation.\n";
}
function checksXml(value: z.infer<typeof SceneChecks>) {
  const n = value.checks.length, suite = value.variant === "plant" ? "plant.layout" : value.variant === "robot-cell" ? "robot.cell" : "workcell.static";
  if (new Set(value.checks.map(c => c.id)).size !== n) throw new DomainError("SCENE_CHECK_COVERAGE", "Native check IDs must be unique");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${suite}" tests="${n}">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="${suite}" name="${c.id}">${c.passed ? "" : '<failure message="Native static geometry check failed"/>'}</testcase>`).join("")
    + "</testsuite>\n";
}
export async function reviewScene(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<SceneReview> {
  const request = SceneRequest.parse(input);
  const publish: LiveBus["publish"] = (key, event) => live?.publish(key, event);
  if (request.variant === "robot-cell" ? !config.physicsPython : !config.blender) {
    throw request.variant === "robot-cell" ? new DomainError("PHYSICS_NOT_CONFIGURED", "Robot simulation needs the pinned physics toolchain (npm run setup:physics)", 503)
      : new DomainError("BLENDER_NOT_CONFIGURED", "Set PAI_BLENDER to a native Blender executable", 503);
  }
  const record: SceneReview = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision,
    request, requirementDigest: sha256(canonical({ projectRequirements: project.requirements, sceneRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), feedbackId: request.feedbackId,
    receipts: [], sourceDigests: {}, files: {}, scope: "generated-static-geometry", physicalValidation: false };
  const directory = join(config.state, "scenes", record.id);
  return nativeRun({ store, live, project, kind: "scene-review", evidenceKind: "blender-scene", request, record, failure: "BLENDER_FAILED",
    recheck: { message: "Scene recheck must bind the same feedback and unchanged static constraints", sameRequirements: original => canonical(original.request.requirements) === canonical(request.requirements) },
    work: async record => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const plant = request.variant === "plant", robot = request.variant === "robot-cell";
      const script = join(config.repository, plant ? "native/blender_plant.py" : robot ? "native/robot_sim.py" : "native/blender_workcell.py");
      const engine = robot ? config.physicsPython! : config.blender!;
      const adapters = new NativeAdapters(config);
      const scriptHash = sha256(await readFile(script));
      const nativeBefore = await adapters.sourceDigests();
      const engineKey = robot ? "physics-python" : "blender-binary";
      record.sourceDigests = { ...nativeBefore, [plant ? "blender-plant.py" : robot ? "robot-sim.py" : "blender-workcell.py"]: scriptHash, [engineKey]: sha256(await readFile(engine)),
        ...(robot ? { "physics-lock": sha256(await readFile(join(config.repository, "native/physics-requirements.txt"))) } : {}) };
      let toolInput: { stl: string; sha256: string; brepMassG: number; motorAxisMm: number; payloadKg: number } | undefined;
      if (robot && request.tool) {
        // Only an accepted part of this project, and only the exact file its review measured.
        const cad = store.get<CadReview>("cad-review", request.tool.cadReviewId);
        if (!cad || cad.projectId !== project.id || cad.state !== "completed" || cad.verdict !== "accepted-cad-part") {
          throw new DomainError("TOOL_NOT_ACCEPTED", "The end-effector must be an accepted CAD part of this project", 422);
        }
        // The gripper mount assumes the bracket frame (motor axis); other part families have no tool interface yet.
        if (familyOf(cad.request) !== "nema17-bracket") throw new DomainError("TOOL_FAMILY", "Only a NEMA 17 bracket can be mounted on the gripper", 422);
        const stl = join(config.state, "cad", cad.id, "candidate", "part.stl");
        const stlSha256 = sha256(await readFile(stl));
        const brepMassG = Number(cad.candidate?.checks.find(c => c.id === "mass")?.observed);
        const motorAxisMm = Number((cad.candidate as { parameters?: { motorAxisHeight?: number } } | undefined)?.parameters?.motorAxisHeight ?? cad.sandbox?.motorAxisZ);
        if (stlSha256 !== cad.files["candidate/part.stl"]) throw new DomainError("TOOL_DIGEST", "The CAD part file differs from its review record", 422);
        if (!(brepMassG > 0) || !(motorAxisMm > 0)) throw new DomainError("TOOL_CONTEXT", "The CAD part does not declare its mass and motor axis", 422);
        toolInput = { stl, sha256: stlSha256, brepMassG, motorAxisMm, payloadKg: request.tool.payloadKg };
        record.tool = { cadReviewId: cad.id, stlSha256, brepMassG, payloadKg: request.tool.payloadKg, motorAxisMm };
        record.sourceDigests["tool-stl"] = stlSha256;
      }
      const cellOf = (name: "baseline" | "candidate") => name === "baseline" ? ROBOT_REFERENCE : (request as { cell: z.infer<typeof RobotCell> }).cell;
      for (const [name, variant] of [["baseline", plant ? "plant" : robot ? "robot-cell" : "clear"], ["candidate", request.variant]] as const) {
        const target = join(directory, name);
        const label = robot ? `MuJoCo ${name === "baseline" ? "参考工作单元" : "候选工作单元"}（${ROBOT_SEEDS.length} 个种子 · 速度 ${Math.round(cellOf(name).speedFraction * 100)}%）` : plant ? `Blender ${name === "baseline" ? "参考产线" : "候选产线"}（${(name === "baseline" ? PLANT_REFERENCE : (request as { layout: z.infer<typeof PlantLayout> }).layout).stations} 工位）`
          : `Blender ${name === "baseline" ? "基准" : "候选"}场景（${variant === "occluded" ? "遮挡" : "无遮挡"}）`;
        publish(request.requestId, { kind: "step", id: `blender-${name}`, label, status: "running", which: name });
        let observed = Promise.resolve();
        const observe = (line: string) => {
          if (!line.startsWith("PAI_EVENT ")) return;
          observed = observed.then(async () => {
            const parsed = NativeEvent.safeParse((() => { try { return JSON.parse(line.slice(10)); } catch { return undefined; } })());
            if (!parsed.success) return;
            const e = parsed.data;
            if (e.type === "stage") {
              const digest = sha256(await readFile(join(target, e.file)));
              const stage: SceneStage = { index: e.index, id: e.id, label: e.label, file: e.file, sha256: digest, objects: e.objects };
              record.stages = { ...record.stages, [name]: [...(record.stages?.[name] ?? []), stage] };
              store.put("scene-review", record);
              publish(request.requestId, { kind: "stage", which: name, index: e.index, id: e.id, label: e.label, objects: e.objects,
                url: `/api/scenes/${record.id}/stages/${name}/${e.index}`, sha256: digest });
            } else if (e.type === "ray") {
              const { type: _type, ...ray } = e;
              record.rays = { ...record.rays, [name]: { ...ray, frame: "gltf-y-up" } };
              store.put("scene-review", record);
              publish(request.requestId, { kind: "ray", which: name, origin: e.origin, target: e.target, hit: e.hit, firstHit: e.firstHit, visible: e.visible });
            } else {
              publish(request.requestId, { kind: "render", which: name, sample: e.sample, samples: e.samples });
            }
          }).catch(() => { /* Presentation events never fail the native review. */ });
        };
        await writePrivate(join(directory, `${name}-input.json`), JSON.stringify(robot
          ? { cell: cellOf(name), requirements: request.requirements, seeds: ROBOT_SEEDS, ...(toolInput ? { tool: toolInput } : {}) }
          : plant
          ? { variant, layout: name === "baseline" ? PLANT_REFERENCE : (request as { layout: unknown }).layout, requirements: request.requirements, render: name === "baseline" ? "preview" : "hero" }
          : { variant, requirements: request.requirements }));
        const args = robot ? ["-I", script, "--input", join(directory, `${name}-input.json`), "--output", target]
          : ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", script,
            "--", "--input", join(directory, `${name}-input.json`), "--output", target];
        const r = await command(engine, args, config.repository, undefined, plant ? 900_000 : robot ? 300_000 : 120_000, observe);
        await observed;
        await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
        await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
        record.receipts.push({ adapter: robot ? "mujoco-native" : "blender-native", command: [robot ? "python" : "blender", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
          exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: { "script": scriptHash } });
        store.put("scene-review", record);
        publish(request.requestId, { kind: "step", id: `blender-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name,
          detail: `exit ${r.exitCode}` });
        if (r.exitCode !== 0) throw new DomainError("BLENDER_FAILED", "Native scene production failed; retain receipts and inspect local artifacts", 422);
        record[name] = SceneChecks.parse(JSON.parse(await readFile(join(target, "checks.json"), "utf8")));
        if (record[name]!.variant !== variant) throw new DomainError("SCENE_CONTEXT", "Native scene variant mismatch");
        const measured = record[name]!;
        if (plant && (measured.variant !== "plant" || canonical(measured.layout) !== canonical(name === "baseline" ? PLANT_REFERENCE : (request as { layout: unknown }).layout))) {
          throw new DomainError("SCENE_CONTEXT", "Native plant layout differs from the requested layout");
        }
        if (robot && (measured.variant !== "robot-cell" || canonical(measured.cell) !== canonical(cellOf(name)))) {
          throw new DomainError("SCENE_CONTEXT", "Native robot cell differs from the requested cell");
        }
        await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(record[name]!), { mode: 0o600, flag: "wx" });
        if (robot) {
          const m = record[name] as { tool?: { stlSha256: string; mujocoMassG: number } | null; usd?: SceneReview["usd"] };
          if (toolInput && (m.tool?.stlSha256 !== toolInput.sha256)) throw new DomainError("SCENE_CONTEXT", "Native simulation mounted a different tool");
          if (toolInput && name === "candidate") record.tool = { ...record.tool!, mujocoMassG: m.tool!.mujocoMassG };
          if (m.usd) record.usd = { usdVersion: m.usd.usdVersion, rigidBodies: m.usd.rigidBodies, joints: m.usd.joints, validators: m.usd.validators };
          if (name === "candidate" && config.newtonPython && record.usd) record.usd.newton = await newtonCheck(config, record, target, request.requestId, publish);
          if (name === "candidate" && config.robotsPython && config.robotsAssets) record.robots = await robotsCheck(config, record, target, request.requestId, publish);
        }
        for (const file of robot ? ["robot.json", "scene.xml", "scene.usda", "robot.glb", "checks.json", ...(toolInput ? ["tool.stl"] : []),
            ...(name === "candidate" && record.usd?.newton && "passed" in record.usd.newton ? ["newton.json"] : []),
            ...(name === "candidate" && record.robots && "passed" in record.robots ? ["robots.json"] : [])] : ["scene.blend", "scene.glb", "preview.png", "checks.json", ...(plant ? ["inspection.png"] : [])]) {
          record.files[`${name}/${file}`] = sha256(await readFile(join(target, file)));
        }
        store.put("scene-review", record);
      }
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选", status: "running" });
      const diff = await adapters.diff(directory);
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选", status: "done", detail: `blocking ${diff.value.blocking_changes}` });
      const lost = record.baseline!.checks.filter(c => c.passed && !record.candidate!.checks.find(n => n.id === c.id)!.passed).length;
      if (diff.value.blocking_changes !== lost || diff.value.gate_passed !== (lost === 0)) throw new DomainError("SCENE_DIFF_MISMATCH", "Native geometry and independent comparison disagree");
      if (sha256(await readFile(script)) !== scriptHash || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())
          || record.sourceDigests[engineKey] !== sha256(await readFile(engine))) throw new DomainError("SOURCE_CHANGED", "Native verifier changed during scene production");
      record.diff = diff.value; record.receipts.push(diff.receipt);
      if (robot) record.scope = "rigid-body-simulation";
      return record.candidate!.checks.every(c => c.passed) ? "accepted-static-scene" : "rejected";
    } });
}

/**
 * Model conformance, not a design check: Strands Robots resolves the arm by name and loads the official MuJoCo
 * Menagerie model (pinned commit, offline); the script compares joints, limits, flange kinematics, reach and link mass
 * with the MJCF PAI simulated. It runs without network (bubblewrap) when available, never in hardware mode, and never
 * changes the verdict; a failing comparison is shown as a finding.
 */
async function robotsCheck(config: Config, record: SceneReview, target: string, requestId: string, publish: LiveBus["publish"]): Promise<NonNullable<SceneReview["robots"]>> {
  const label = "Strands Robots 对照官方 UR5e 模型（关节、限位、正运动学、可达范围、质量）";
  const fail = (code: string, detail: string) => {
    publish(requestId, { kind: "step", id: "strands-robots", label, status: "failed", which: "candidate", detail: code });
    return { error: `${code}: ${detail}` };
  };
  publish(requestId, { kind: "step", id: "strands-robots", label, status: "running", which: "candidate" });
  // A conformance record must never decide the review: every failure here becomes a finding, not an exception.
  try {
    const script = join(config.repository, "native/robots_crosscheck.py"), scratch = join(target, ".robots"), output = join(scratch, "robots.json");
    await mkdir(scratch, { mode: 0o700 });
    const pins = JSON.parse(await readFile(join(config.repository, "tools/runtime-pins.json"), "utf8")).strandsRobots as { version: string; menagerie: { commit: string } };
    const python = config.robotsPython!, venv = dirname(dirname(python));
    // Same isolation as generated CAD code: no network, clean environment, private state hidden; only target is writable.
    const argv = ["/usr/bin/env", "MUJOCO_GL=disable", "STRANDS_MESH=false", `ROBOT_DESCRIPTIONS_CACHE=${config.robotsAssets}`,
      python, "-I", script, "--mjcf", join(target, "scene.xml"), "--robot", "ur5e", "--assets", config.robotsAssets!, "--commit", pins.menagerie.commit, "--output", output];
    const bwrap = config.bwrap ?? "bwrap";
    const r = await command(bwrap, sandboxArgs(config, { python, venv, native: join(config.repository, "native") },
      { readOnly: [config.robotsAssets!, target], writable: [scratch] }, argv), "/", undefined, 300_000);
    record.receipts.push({ adapter: "strands-robots", command: ["bwrap", "--unshare-all", "python", "robots_crosscheck.py", "--robot", "ur5e"], startedAt: r.startedAt, finishedAt: r.finishedAt,
      exitCode: r.exitCode, stdoutSha256: sha256(r.stdout),
      sourceDigests: { script: sha256(await readFile(script)), lock: sha256(await readFile(join(config.repository, "native/robots-requirements.txt"))), menagerie: pins.menagerie.commit } });
    if (r.exitCode !== 0) return fail("ROBOTS_CROSSCHECK_FAILED", `isolated run exited ${r.exitCode}; see the retained receipt`);
    const j = JSON.parse(await readFile(output, "utf8")) as { robot: string; strandsRobots: string; menagerieCommit: string; passed: boolean; configurations: number; mode: string;
      checks: { id: string; passed: boolean; observed: unknown; limit?: number; unit?: string }[] };
    if (j.strandsRobots !== pins.version || j.menagerieCommit !== pins.menagerie.commit || j.mode !== "sim") return fail("ROBOTS_PIN_MISMATCH", "Strands Robots, Menagerie or mode differs from the pins");
    // Copied by this (trusted) process: the sandbox could never touch the files the review hashes.
    await writeFile(join(target, "robots.json"), JSON.stringify(j, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const failed = j.checks.filter(c => !c.passed).map(c => c.id);
    publish(requestId, { kind: "step", id: "strands-robots", label, status: j.passed ? "done" : "failed", which: "candidate",
      detail: j.passed ? `${j.configurations} 个构型一致` : `不一致：${failed.join("、")}` });
    return { robot: j.robot, strandsRobots: j.strandsRobots, menagerieCommit: j.menagerieCommit, passed: j.passed, configurations: j.configurations,
      isolation: "bwrap-unshare-all", checks: j.checks };
  } catch { return fail("ROBOTS_CROSSCHECK_ERROR", "the cross-check could not complete; see the retained receipt"); }
}

/**
 * Export conformance, not a design check: the candidate's OpenUSD is imported by Newton (the engine behind Isaac Lab's
 * Newton backend) and compared with the MJCF PAI simulated (articulation, masses, FK at 33 configurations). The result
 * is recorded with a receipt; it never changes the verdict, and a failure is shown, not hidden.
 */
async function newtonCheck(config: Config, record: SceneReview, target: string, requestId: string, publish: LiveBus["publish"]) {
  const script = join(config.repository, "native/usd_newton_check.py"), label = "Newton 交叉校验 OpenUSD（关节树、质量、33 个构型的正运动学）";
  publish(requestId, { kind: "step", id: "newton-usd", label, status: "running", which: "candidate" });
  const args = [script, "--usd", join(target, "scene.usda"), "--mjcf", join(target, "scene.xml"), "--output", join(target, "newton.json")];
  const r = await command(config.newtonPython!, args, tmpdir(), undefined, 300_000);
  record.receipts.push({ adapter: "newton-usd", command: ["python", "usd_newton_check.py"], startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode,
    stdoutSha256: sha256(r.stdout), sourceDigests: { script: sha256(await readFile(script)), lock: sha256(await readFile(join(config.repository, "native/newton-requirements.txt"))) } });
  if (r.exitCode !== 0) {
    publish(requestId, { kind: "step", id: "newton-usd", label, status: "failed", which: "candidate", detail: `exit ${r.exitCode}` });
    return { error: `Newton could not import the USD (exit ${r.exitCode}): ${r.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}` };
  }
  const j = JSON.parse(await readFile(join(target, "newton.json"), "utf8")) as { newton: string; passed: boolean; configurations: number; checks: { id: string; passed: boolean; observed: unknown }[] };
  const obs = (id: string) => Number(j.checks.find(c => c.id === id)?.observed);
  publish(requestId, { kind: "step", id: "newton-usd", label, status: j.passed ? "done" : "failed", which: "candidate",
    detail: `Newton ${j.newton} · 位置偏差 ${(obs("fk-position") * 1000).toFixed(4)} mm` });
  return { version: j.newton, passed: j.passed, configurations: j.configurations, fkPositionM: obs("fk-position"), fkOrientationDeg: obs("fk-orientation"),
    checks: j.checks.map(c => ({ id: c.id, passed: c.passed })) };
}

