import { randomUUID } from "node:crypto";
import type { RecordKind } from "./ontology/kinds.js";
import { z } from "zod";
import { CreateProject, Id, ReviewRequest, type Project, type CandidateId } from "./contracts.js";
import type { Suggestion } from "./decider.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { DEFAULT_FACTORY_CRITERIA, FactoryCriteriaRequest, FactoryReviewRequest, REVIEWED_SAMPLE,
  type FactoryCriteria, type FactoryCriteriaValues } from "./factory.js";
import { DEFAULT_PLANT_REQUIREMENTS, isPlant, PLANT_REFERENCE, PlantLayout, PlantRequirements, plantHall, SceneRequest,
  type PlantLayoutValue, type PlantRequirementsValue, type PlantScene, type SceneReview, type WorkcellScene } from "./scenes.js";
import type { Store } from "./store.js";
import { CadRequest, DEFAULT_CAD_REQUIREMENTS, type CadReview } from "./cad.js";

/**
 * AI-native entry that stays inside professional contracts.
 *
 * A message becomes typed, schema-validated tool plans — the "intent IR". Plans show every
 * requirement change against the frozen state, carry no authority, and run only after the
 * user confirms them through the same routes as the classic forms. Deterministic parsing is
 * always available; a model is used only through the existing controller and budget gate.
 */
export const AssistantInput = z.object({
  requestId: Id, projectId: Id.optional(), message: z.string().trim().min(1).max(2000),
}).strict();
export type PlanTool = "create-project" | "update-requirements" | "scene-review" | "plant-layout" | "robot-cell" | "robot-review" | "cad-review" | "cad-code" | "cad-sweep" | "cad-optimize" | "aero-body"
  | "factory-criteria" | "factory-review" | "model-proposal";
export interface PlanChange { field: string; from: unknown; to: unknown; direction: "new" | "same" | "tightened" | "relaxed" | "changed" }
export interface ToolPlan {
  id: string; tool: PlanTool; title: string; route: string; method: "POST" | "PATCH";
  payload: Record<string, unknown>; dependsOn?: string; changes: PlanChange[]; warnings: string[];
  requiresConfirmation: true; evidence: string;
}
export interface AssistantPlan {
  id: string; requestId: string; projectId?: string; projectRevision?: number; message: string; createdAt: string;
  interpretation: string[]; plans: ToolPlan[]; unmatched: boolean;
  authority: "none"; model: { used: boolean; reason: string };
  /** Strands Decider routing suggestion when the rules found no tool (src/decider.ts); never executed. */
  suggestion?: Suggestion;
  /** AI-engine runs: the decision model's triage in front of the large model (src/ai.ts). */
  triage?: { skippedModel: boolean; hinted: boolean; agreement: boolean | null; relaxMismatch: boolean };
  /** Model-sourced plans: executor outcome, engine receipts and any human reconciliation. */
  source?: "rules" | "model" | "external";
  external?: { agent: string; via: "mcp"; verified?: boolean; clientId?: string; session?: string };
  state?: "running" | "done" | "reconcile" | "deferred" | "blocked" | "invalid-output" | "interrupted";
  ai?: {
    action?: string; reason?: string; effects?: string; reportSha256?: string; error?: string;
    engine?: { profile: string; provider: string; model: string | null; engineVersion: string | null; modelEvidence: string | null };
    attempts: { profile: string; provider: string; status: string; errorKind: string | null; model: string | null }[];
    /** The maintainer's judgment, and how the executor settled each unknown-effect attempt (its ledger, its checks). */
    reconciliation?: { reason: string; at: string; actor: string; settlements?: { attemptId: string; profile: string; state: string; blockers?: string[] }[] };
  };
  answer?: { text: string; citations: { handle: string; kind: RecordKind; id: string; label: string }[] };
  finishedAt?: string;
  confirmations: { planId: string; recordKind: RecordKind; recordId: string; at: string; match: "as-proposed" | "edited-before-execution" }[];
}
export const PreflightStep = z.object({ planId: z.string().regex(/^p[0-9]{1,2}$/) }).strict();
export const ConfirmPlan = z.object({
  planId: z.string().regex(/^p[0-9]{1,2}$/), recordKind: z.enum(["project", "scene-review", "review", "factory-criteria", "factory-review", "proposal", "cad-review", "cad-sweep", "cad-optimize", "aero-review"]),
  recordId: Id,
  /** Set when the step ran under a maintainer's autonomy grant instead of a per-step click. */
  grantId: Id.optional(),
}).strict();

const num = (text: string, pattern: RegExp) => { const m = pattern.exec(text); return m ? Number(m[1]) : undefined; };
export function compare(field: string, from: unknown, to: unknown, stricter: "higher" | "lower" | "true"): PlanChange {
  if (from === undefined) return { field, from: null, to, direction: "new" };
  if (canonical(from) === canonical(to)) return { field, from, to, direction: "same" };
  if (typeof from === "number" && typeof to === "number") {
    const tighter = stricter === "higher" ? to > from : to < from;
    return { field, from, to, direction: tighter ? "tightened" : "relaxed" };
  }
  if (typeof from === "boolean" && typeof to === "boolean" && stricter === "true") return { field, from, to, direction: to ? "tightened" : "relaxed" };
  return { field, from, to, direction: "changed" };
}
/** Removing a frozen requirement block (structural, dfm, dfm.cam) relaxes it; adding one tightens. */
function block(field: string, from: unknown, to: unknown): PlanChange[] {
  if (from === undefined && to === undefined) return [];
  if (from !== undefined && to === undefined) return [{ field, from: canonical(from), to: null, direction: "relaxed" }];
  if (from === undefined) return [{ field, from: null, to: canonical(to), direction: "tightened" }];
  return [];
}
type CadReq = { maxMassG: number; minWallMm: number; edgeDistanceFactor: number; requireNoInterference: boolean; maxEnvelopeMm: number[];
  structural?: { forceN: number; leverMm: number; safetyFactor: number; maxDeflectionMm: number; direction?: string; maxBoreDistortionMm?: number };
  dfm?: { maxSetups: number; maxUnitCostEur: number; cam?: { maxCycleMinutes: number } } };
/**
 * Every frozen CAD requirement compared with the previous one (or the lane defaults), the single source the autonomy
 * guard reads: geometry limits, envelope per axis, structural load case, DFM limits and the CAM cycle limit.
 */
export function cadRequirementChanges(was: CadReq | undefined, now: CadReq): PlanChange[] {
  const s0 = was?.structural, s1 = now.structural, d0 = was?.dfm, d1 = now.dfm;
  return [compare("maxMassG", was?.maxMassG, now.maxMassG, "lower"), compare("minWallMm", was?.minWallMm, now.minWallMm, "higher"),
    compare("edgeDistanceFactor", was?.edgeDistanceFactor, now.edgeDistanceFactor, "higher"),
    compare("requireNoInterference", was?.requireNoInterference, now.requireNoInterference, "true"),
    ...now.maxEnvelopeMm.map((v, i) => compare(`maxEnvelopeMm[${i}]`, was?.maxEnvelopeMm[i], v, "lower")),
    ...block("structural", s0, s1),
    ...(s0 && s1 ? [compare("structural.forceN", s0.forceN, s1.forceN, "higher"), compare("structural.leverMm", s0.leverMm, s1.leverMm, "higher"),
      compare("structural.safetyFactor", s0.safetyFactor, s1.safetyFactor, "higher"), compare("structural.maxDeflectionMm", s0.maxDeflectionMm, s1.maxDeflectionMm, "lower"),
      ...(s0.maxBoreDistortionMm !== undefined || s1.maxBoreDistortionMm !== undefined ? [compare("structural.maxBoreDistortionMm", s0.maxBoreDistortionMm, s1.maxBoreDistortionMm, "lower")] : []),
      // A different load direction is a different load case: neither stricter nor looser, so it is flagged as changed.
      ...(s0.direction !== s1.direction ? [{ field: "structural.direction", from: s0.direction ?? null, to: s1.direction ?? null, direction: "changed" as const }] : [])] : []),
    ...block("dfm", d0, d1),
    ...(d0 && d1 ? [compare("dfm.maxSetups", d0.maxSetups, d1.maxSetups, "lower"), compare("dfm.maxUnitCostEur", d0.maxUnitCostEur, d1.maxUnitCostEur, "lower"),
      ...block("dfm.cam", d0.cam, d1.cam),
      ...(d0.cam && d1.cam ? [compare("dfm.cam.maxCycleMinutes", d0.cam.maxCycleMinutes, d1.cam.maxCycleMinutes, "lower")] : [])] : [])]
    .filter(c => c.direction !== "same" || ["maxMassG", "minWallMm"].includes(c.field));
}
export const relaxWarning = (changes: PlanChange[]) => changes.some(c => c.direction === "relaxed")
  ? ["放宽了已冻结的约束：只会生成新的冻结版本，既有结论和失败案例保持不变。"] : [];

export interface PlannerContext { project?: Project; lastScene?: WorkcellScene; lastPlant?: PlantScene; lastCriteria?: FactoryCriteria; lastCad?: CadReview; modelConfigured: boolean }

const PLANT_FIELDS: [keyof PlantLayoutValue, string][] = [["stations", "工位数"], ["stationPitch", "工位节距 m"], ["aisleWidth", "通道设计宽度 m"],
  ["guardSize", "围栏边长 m"], ["rackRows", "货架排数"], ["cameraHeight", "相机龙门高度 m"], ["agvs", "AGV 台数"]];
/** One validated plant-layout plan step; shared by the rule planner and the AI planner so both produce the same contract. */
export function plantPlan(layout: PlantLayoutValue, requirements: PlantRequirementsValue, prev: PlantScene["request"] | undefined, revision: number, route: string, title?: string) {
  const payload = { projectRevision: revision, variant: "plant" as const, layout, requirements };
  SceneRequest.parse({ ...payload, requestId: "00000000-0000-4000-8000-000000000000" });
  const r0 = prev?.requirements;
  const changes: PlanChange[] = [
    ...PLANT_FIELDS.map(([k]) => ({ field: `layout.${k}`, from: prev?.layout[k] ?? null, to: layout[k],
      direction: prev ? (prev.layout[k] === layout[k] ? "same" : "changed") : "new" } as PlanChange)),
    compare("maxFootprintArea", r0?.maxFootprintArea, requirements.maxFootprintArea, "lower"),
    compare("minAisleWidth", r0?.minAisleWidth, requirements.minAisleWidth, "higher"),
    compare("minGuardClearance", r0?.minGuardClearance, requirements.minGuardClearance, "higher"),
    compare("requireCameraCoverage", r0?.requireCameraCoverage, requirements.requireCameraCoverage, "true"),
    compare("maxEgressTravel", r0?.maxEgressTravel, requirements.maxEgressTravel, "lower")];
  const hall = plantHall(layout);
  return { tool: "plant-layout" as const, title: title ?? `Blender 工厂产线：${layout.stations} 工位 · 通道 ${layout.aisleWidth} m`, route, method: "POST" as const, payload, changes,
    warnings: [...relaxWarning(changes), ...(hall.x * hall.y > requirements.maxFootprintArea ? [`按配方估算厂房 ${(hall.x * hall.y).toFixed(0)} m² 超过上限；原生检查会给出结论。`] : [])],
    evidence: "原生 .blend/GLB（含动画）/Cycles 渲染、BVH 射线实测通道/围栏/相机覆盖/疏散、EvalArc 对照；逐阶段实时几何" };
}

export function planFromMessage(message: string, context: PlannerContext): Omit<AssistantPlan, "id" | "requestId" | "createdAt" | "confirmations"> {
  const text = message.toLowerCase();
  const plans: ToolPlan[] = [], interpretation: string[] = [];
  let seq = 0;
  const id = () => `p${++seq}`;
  const project = context.project;
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const projectRoute = (suffix: string) => `/projects/${project ? project.id : "{project}"}/${suffix}`;
  const revision = project?.revision ?? 1;

  const wantsCad = /\bcad\b|cadquery|step\b|支架|bracket|nema|电机座|壁厚|零件|孔边距|止口/.test(text);
  const wantsPlant = !wantsCad && /产线|生产线|production line|plant layout|工厂布局|车间布局|工位|\bagv\b|节距|围栏|通道净宽|aisle/.test(text);
  const wantsScene = !wantsCad && !wantsPlant && /blender|场景|工作单元|workcell|遮挡|occlu|占地|footprint|包络|envelope|可见性|visib/.test(text);
  const wantsRobot = /相机偏移|camera offset|弱光|\bdim\b|smolvla|策略|policy|配对|seed|回放|记录评审|recorded/.test(text);
  const wantsFactory = !wantsPlant && /工厂|factory|能源|energy|维护|maintenance|需量|demand|充电|\bev\b|舒适|comfort|车间|hall|产出|产量|output/.test(text);
  const wantsNew = /新任务|新建任务|new (project|task)|创建任务/.test(text) || !project;
  const wantsModel = /模型提案|model proposal|llm|让模型/.test(text);
  const rate = num(text, /成功率[^\d]{0,8}(\d{1,3})\s*%/);

  let projectPlan: string | undefined;
  if (wantsNew) {
    const requirements = { minSuccessRate: rate !== undefined ? rate / 100 : 0.5, preserveBaselineSuccess: !/不保留基准|不要求保留/.test(text),
      requireSignificantImprovement: /显著|significan/.test(text), alpha: 0.05 };
    const payload = { title: message.replace(/\s+/g, " ").slice(0, 60) || "设计评审任务",
      intendedDecision: `由 AI 工作室对话创建：${message.slice(0, 400)}`, requirements };
    CreateProject.parse(payload);
    projectPlan = id();
    plans.push({ id: projectPlan, tool: "create-project", title: "创建任务并冻结需求 v1", route: "/projects", method: "POST", payload,
      changes: Object.entries(requirements).map(([field, to]) => ({ field, from: null, to, direction: "new" as const })),
      warnings: [], requiresConfirmation: true, evidence: "项目记录；后续检查全部绑定此需求版本" });
    interpretation.push(project ? "识别到新建任务意图。" : "当前没有任务，先创建任务。");
  } else if (rate !== undefined && project) {
    const requirements = { ...project.requirements, minSuccessRate: rate / 100 };
    const changes = [compare("minSuccessRate", project.requirements.minSuccessRate, rate / 100, "higher")];
    const payload = { title: project.title, intendedDecision: project.intendedDecision, requirements, expectedRevision: project.revision };
    CreateProject.extend({ expectedRevision: z.number().int().positive() }).strict().parse(payload);
    projectPlan = id();
    plans.push({ id: projectPlan, tool: "update-requirements", title: `需求修订为 v${project.revision + 1}`, route: `/projects/${project.id}`, method: "PATCH",
      payload, changes, warnings: [...relaxWarning(changes), "已有检查继续绑定旧版本；需要重新执行检查。"], requiresConfirmation: true, evidence: "比较-交换的需求修订" });
    interpretation.push("识别到验收成功率修改。");
  }
  const nextRevision = plans.some(p => p.tool === "update-requirements") ? revision + 1 : wantsNew ? 1 : revision;

  if (wantsScene) {
    const previous = context.lastScene?.request.requirements;
    const area = num(text, /(\d+(?:\.\d+)?)\s*(?:m²|m2|㎡|平方米|平米|sqm)/) ?? previous?.maxFootprintArea ?? 12;
    const radius = num(text, /(?:半径|包络|radius|envelope)[^\d]{0,10}(\d+(?:\.\d+)?)/) ?? previous?.targetEnvelopeRadius ?? 1.4;
    const visible = /不要求可见|无需可见|ignore visib|visibility optional/.test(text) ? false : previous?.requireTargetVisible ?? true;
    const variant = /移除遮挡|去掉遮挡|去除遮挡|无遮挡|清除遮挡|remove (the )?occlu|clear/.test(text) ? "clear"
      : /遮挡|occlu/.test(text) ? "occluded" : context.lastScene?.request.variant ?? "occluded";
    const requirements = { maxFootprintArea: area, targetEnvelopeRadius: radius, requireTargetVisible: visible };
    const payload = { projectRevision: nextRevision, variant, requirements };
    SceneRequest.parse({ ...payload, requestId: placeholder });
    const changes = [compare("maxFootprintArea", previous?.maxFootprintArea, area, "lower"),
      compare("targetEnvelopeRadius", previous?.targetEnvelopeRadius, radius, "lower"),
      compare("requireTargetVisible", previous?.requireTargetVisible, visible, "true"),
      { field: "variant", from: context.lastScene?.request.variant ?? null, to: variant, direction: context.lastScene ? (context.lastScene.request.variant === variant ? "same" : "changed") : "new" } as PlanChange];
    plans.push({ id: id(), tool: "scene-review", title: `Blender 原生场景：${variant === "occluded" ? "带遮挡候选" : "无遮挡布局"}`, route: projectRoute("scenes"),
      method: "POST", payload, dependsOn: projectPlan, changes, warnings: [...relaxWarning(changes), ...(visible ? [] : ["关闭可见性要求会让遮挡不再构成失败。"])],
      requiresConfirmation: true, evidence: "原生 .blend/GLB/PNG、射线与投影检查、EvalArc 对照；逐阶段实时几何" });
    interpretation.push(`Blender 场景：占地 ≤ ${area} m²，包络半径 ${radius} m，${visible ? "要求" : "不要求"}相机可见，变体 ${variant}。`);
  }
  if (wantsPlant) {
    const prev = context.lastPlant?.request;
    const base: PlantLayoutValue = prev?.layout ?? PLANT_REFERENCE;
    const layout = PlantLayout.parse({
      stations: num(text, /(\d+)\s*(?:个)?工位/) ?? num(text, /(\d+)[- ]?station/) ?? base.stations,
      stationPitch: num(text, /(?:节距|间距|pitch)[^\d]{0,6}(\d+(?:\.\d+)?)/) ?? base.stationPitch,
      aisleWidth: num(text, /(?:通道|aisle)[^\d]{0,6}(\d+(?:\.\d+)?)/) ?? base.aisleWidth,
      guardSize: num(text, /(?:围栏|guard)[^\d]{0,8}(\d+(?:\.\d+)?)/) ?? base.guardSize,
      rackRows: num(text, /(\d+)\s*排(?:货架)?/) ?? base.rackRows,
      cameraHeight: num(text, /(?:相机|camera)[^\d]{0,8}(\d+(?:\.\d+)?)/) ?? base.cameraHeight,
      agvs: num(text, /(\d+)\s*(?:台|辆)?\s*agv/) ?? base.agvs,
    });
    const r0: PlantRequirementsValue = prev?.requirements ?? DEFAULT_PLANT_REQUIREMENTS;
    const requirements = PlantRequirements.parse({ ...r0,
      maxFootprintArea: num(text, /(\d+(?:\.\d+)?)\s*(?:m²|m2|㎡|平方米|平米|sqm)/) ?? r0.maxFootprintArea,
      minAisleWidth: num(text, /(?:通道净宽|净宽)[^\d]{0,6}(?:≥|>=|不小于|至少)?\s*(\d+(?:\.\d+)?)/) ?? r0.minAisleWidth,
      minGuardClearance: num(text, /(?:安全间距|clearance)[^\d]{0,6}(?:≥|>=|不小于|至少)?\s*(\d+(?:\.\d+)?)/) ?? r0.minGuardClearance,
      maxEgressTravel: num(text, /(?:疏散|egress)[^\d]{0,8}(\d+(?:\.\d+)?)/) ?? r0.maxEgressTravel });
    const plan = plantPlan(layout, requirements, prev, nextRevision, projectRoute("scenes"));
    plans.push({ id: id(), ...plan, dependsOn: projectPlan, requiresConfirmation: true });
    const hall = plantHall(layout);
    interpretation.push(`工厂产线：${layout.stations} 工位、节距 ${layout.stationPitch} m、通道 ${layout.aisleWidth} m、围栏 ${layout.guardSize} m、相机 ${layout.cameraHeight} m、${layout.agvs} 台 AGV；厂房约 ${hall.x.toFixed(1)} × ${hall.y.toFixed(2)} m。`);
  }
  if (wantsCad) {
    const previous = context.lastCad?.request.requirements;
    const base = previous ?? DEFAULT_CAD_REQUIREMENTS;
    const requirements = {
      maxMassG: num(text, /(?:质量|重量|mass)[^\d]{0,10}(\d+(?:\.\d+)?)\s*(?:g|克)/) ?? base.maxMassG,
      minWallMm: num(text, /(?:壁厚|wall)[^\d]{0,10}(\d+(?:\.\d+)?)\s*mm/) ?? base.minWallMm,
      edgeDistanceFactor: num(text, /(?:孔边距|边距|edge)[^\d]{0,10}(\d+(?:\.\d+)?)\s*(?:倍|x|×|d)/) ?? base.edgeDistanceFactor,
      requireNoInterference: /允许干涉|ignore interference/.test(text) ? false : base.requireNoInterference,
      maxEnvelopeMm: base.maxEnvelopeMm,
    };
    const variant = /轻量|减重|lightweight|2\.5\s*mm/.test(text) ? "lightweight" : /止口|bore|21\.5/.test(text) ? "undersize-bore"
      : /紧凑|compact|降低高度/.test(text) ? "compact" : /基准|reference|修复|回退/.test(text) ? "reference" : context.lastCad?.request.variant ?? "lightweight";
    const payload = { projectRevision: nextRevision, variant, requirements };
    CadRequest.parse({ ...payload, requestId: placeholder });
    const changes = [compare("maxMassG", previous?.maxMassG, requirements.maxMassG, "lower"),
      compare("minWallMm", previous?.minWallMm, requirements.minWallMm, "higher"),
      compare("edgeDistanceFactor", previous?.edgeDistanceFactor, requirements.edgeDistanceFactor, "higher"),
      compare("requireNoInterference", previous?.requireNoInterference, requirements.requireNoInterference, "true"),
      { field: "variant", from: context.lastCad?.request.variant ?? null, to: variant, direction: context.lastCad ? (context.lastCad.request.variant === variant ? "same" : "changed") : "new" } as PlanChange];
    plans.push({ id: id(), tool: "cad-review", title: `CadQuery 参数化零件：NEMA 17 电机支架 · ${variant}`, route: projectRoute("cad"), method: "POST", payload,
      dependsOn: projectPlan, changes, warnings: [...relaxWarning(changes), ...(requirements.requireNoInterference ? [] : ["关闭干涉要求会让装配冲突不再构成失败。"])],
      requiresConfirmation: true, evidence: "可编辑 STEP、STL/GLB/SVG；OCCT B-Rep 实测接口、壁厚、孔边距、质量与电机装配干涉；EvalArc 对照；逐阶段实时几何" });
    interpretation.push(`CAD 零件：候选 ${variant}；质量 ≤ ${requirements.maxMassG} g，最小壁厚 ≥ ${requirements.minWallMm} mm，孔边距 ≥ ${requirements.edgeDistanceFactor}×d，${requirements.requireNoInterference ? "不允许" : "允许"}装配干涉。`);
  }
  if (wantsRobot) {
    const candidate: CandidateId = /弱光|\bdim\b|低光/.test(text) ? "dim" : /基准|reference|回退/.test(text) ? "reference" : "camera";
    const payload = { projectRevision: nextRevision, candidate };
    ReviewRequest.parse({ ...payload, requestId: placeholder });
    plans.push({ id: id(), tool: "robot-review", title: `Robot Reel 记录评审：${candidate}`, route: projectRoute("reviews"), method: "POST", payload,
      dependsOn: projectPlan, changes: [], warnings: ["回顾性记录仿真；不执行新的策略推理。"], requiresConfirmation: true,
      evidence: "Robot Reel 原生核验、配对精确检验、EvalArc 稳定种子对照、可回放原始视频" });
    interpretation.push(`机器人记录评审：候选 ${candidate}。`);
  }
  if (wantsFactory) {
    const base: FactoryCriteriaValues = context.lastCriteria?.criteria ?? DEFAULT_FACTORY_CRITERIA;
    const pct = (pattern: RegExp) => { const v = num(text, pattern); return v === undefined ? undefined : v / 100; };
    const criteria: FactoryCriteriaValues = {
      maxOutputLossPerSeed: /产出不(能|得)?下降|不允许.{0,4}(产出|产量).{0,4}(下降|损失)|no output loss/.test(text) ? 0
        : num(text, /(?:产出|产量|output)[^\d]{0,12}(\d+)\s*(?:件|units?)?/) ?? base.maxOutputLossPerSeed,
      maxClosedIntervalsOverLimit: /不允许.{0,4}需量超限|需量不(能|得)?超限|no demand (limit )?breach/.test(text) ? 0
        : num(text, /(?:超限|over[- ]limit)[^\d]{0,8}(\d+)/) ?? base.maxClosedIntervalsOverLimit,
      maxHallC: num(text, /(\d+(?:\.\d+)?)\s*(?:°c|℃|度)/) ?? base.maxHallC,
      minEvServiceRatio: pct(/(?:\bev\b|充电)[^\d]{0,14}(\d{1,3}(?:\.\d+)?)\s*%/) ?? base.minEvServiceRatio,
      maxClosedFailures: base.maxClosedFailures,
      requireNetOutputGain: /不要求净增|允许净产出下降/.test(text) ? false : base.requireNetOutputGain,
    };
    const rationale = `AI 工作室根据对话提出，确认前冻结：${message.slice(0, 200)}`;
    FactoryCriteriaRequest.parse({ requestId: placeholder, projectRevision: nextRevision, criteria, rationale });
    const prior = context.lastCriteria?.criteria;
    const changes = [compare("maxOutputLossPerSeed", prior?.maxOutputLossPerSeed, criteria.maxOutputLossPerSeed, "lower"),
      compare("maxClosedIntervalsOverLimit", prior?.maxClosedIntervalsOverLimit, criteria.maxClosedIntervalsOverLimit, "lower"),
      compare("maxHallC", prior?.maxHallC, criteria.maxHallC, "lower"),
      compare("minEvServiceRatio", prior?.minEvServiceRatio, criteria.minEvServiceRatio, "higher"),
      compare("maxClosedFailures", prior?.maxClosedFailures, criteria.maxClosedFailures, "lower"),
      compare("requireNetOutputGain", prior?.requireNetOutputGain, criteria.requireNetOutputGain, "true")];
    const criteriaPlan = id();
    plans.push({ id: criteriaPlan, tool: "factory-criteria", title: "先冻结工厂验收标准", route: projectRoute("factory-criteria"), method: "POST",
      payload: { projectRevision: nextRevision, criteria, rationale }, dependsOn: projectPlan, changes, warnings: relaxWarning(changes),
      requiresConfirmation: true, evidence: "独立于上游摘要的冻结标准记录（带摘要哈希与时间）" });
    const reviewPayload = { projectRevision: nextRevision, criteriaId: `{${criteriaPlan}}`, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } };
    FactoryReviewRequest.parse({ ...reviewPayload, requestId: placeholder, criteriaId: placeholder });
    plans.push({ id: id(), tool: "factory-review", title: "导入已复核的 Robot Reel v0.18.0 工厂孪生并逐种子评估", route: projectRoute("factory-reviews"),
      method: "POST", payload: reviewPayload, dependsOn: criteriaPlan, changes: [],
      warnings: ["演示仿真，参数未按真实工厂校准；能源降低不抵消产出、EV 服务或舒适度损失。"], requiresConfirmation: true,
      evidence: "逐字节 seeds.json/manifest.json、摘要重算、影子模式只观察、12 个配对种子全部保留" });
    interpretation.push(`工厂孪生：单种子产出损失 ≤ ${criteria.maxOutputLossPerSeed}，EV 服务 ≥ ${Math.round(criteria.minEvServiceRatio * 100)}%，车间 ≤ ${criteria.maxHallC} °C，需量超限 ≤ ${criteria.maxClosedIntervalsOverLimit}。`);
  }
  if (wantsModel) {
    if (context.modelConfigured) {
      const payload = { projectRevision: nextRevision, profiles: ["kiro-primary", "kiro-backup", "kiro-backup2"] };
      plans.push({ id: id(), tool: "model-proposal", title: "受控模型文本提案", route: projectRoute("proposals"), method: "POST", payload,
        dependsOn: projectPlan, changes: [], warnings: ["提案无验收或发布权限；未知结果需要对账。"], requiresConfirmation: true, evidence: "原生控制器回执与既有预算账本" });
    } else interpretation.push("受控模型未配置（需要既有控制器入口与经审查的预算账本），本次不调用模型。");
  }
  const unmatched = !plans.some(p => !["create-project", "update-requirements"].includes(p.tool));
  if (unmatched) interpretation.push("没有识别到可执行的原生工具。可以说明：CAD 零件（NEMA 17 支架、壁厚、质量、孔边距）、Blender 场景（占地/包络/遮挡）、机器人记录评审（相机偏移/弱光），或工厂维护与能源评审（产出、EV 充电、温度、需量）。");
  return {
    projectId: project?.id, projectRevision: project?.revision, message, interpretation, plans, unmatched, authority: "none",
    model: { used: false, reason: context.modelConfigured ? "意图解析为确定性规则；模型只能通过确认后的受控提案计划调用" : "受控模型未配置；使用确定性意图解析，没有模型调用" },
  };
}

export async function createPlan(store: Store, input: unknown, modelConfigured: boolean,
  suggest?: (message: string) => Promise<Suggestion | undefined>): Promise<AssistantPlan> {
  const request = AssistantInput.parse(input);
  const project = request.projectId ? store.get<Project>("project", request.projectId) : undefined;
  if (request.projectId && !project) throw new DomainError("NOT_FOUND", "Project not found", 404);
  const scenes = project ? store.list<SceneReview>("scene-review").filter(s => s.projectId === project.id) : [];
  const lastScene = scenes.filter((s): s is WorkcellScene => !isPlant(s)).at(-1), lastPlant = scenes.filter(isPlant).at(-1);
  const lastCriteria = project ? store.list<FactoryCriteria>("factory-criteria").filter(c => c.projectId === project.id).at(-1) : undefined;
  const lastCad = project ? store.list<CadReview>("cad-review").filter(c => c.projectId === project.id).at(-1) : undefined;
  const plan = planFromMessage(request.message, { project, lastScene, lastPlant, lastCriteria, lastCad, modelConfigured });
  // Same request again: return the recorded plan (or the identity conflict) without asking any model.
  const digest = sha256(canonical({ kind: "assistant-plan", request }));
  const prior = store.requestRun(request.requestId);
  if (prior) return store.get<AssistantPlan>("assistant-plan", store.claim(request.requestId, digest, { id: prior }, "assistant-plan"))!;
  // Only when the rules found no native tool: a suggestion for the person, recorded with its confidence.
  const suggestion = plan.unmatched && suggest ? await suggest(request.message) : undefined;
  const record: AssistantPlan = { ...plan, ...(suggestion ? { suggestion } : {}), id: randomUUID(), requestId: request.requestId, createdAt: new Date().toISOString(), confirmations: [] };
  const claimed = store.claim(request.requestId, digest, record, "assistant-plan");
  return claimed === record.id ? record : store.get<AssistantPlan>("assistant-plan", claimed)!;
}

/** Gate checked before a plan step runs any native tool, and again when its execution is recorded. */
export function preflightPlan(store: Store, planId: string, stepId: string): { planId: string; stepId: string; allowed: true } {
  const plan = store.get<AssistantPlan>("assistant-plan", planId);
  if (!plan) throw new DomainError("NOT_FOUND", "Assistant plan not found", 404);
  if (!plan.plans.some(p => p.id === stepId)) throw new DomainError("NOT_FOUND", "Plan step not found", 404);
  if (plan.source === "model" && !(plan.state === "done" || (plan.state === "reconcile" && plan.ai?.reconciliation))) {
    throw new DomainError("AI_RECONCILIATION_REQUIRED", "该 AI 运行的引擎影响尚未核对；先记录核对结果再执行其计划", 409);
  }
  return { planId, stepId, allowed: true };
}

/** Link an executed record to its plan; records whether the user edited the proposal first. */
export function confirmPlan(store: Store, planId: string, input: unknown): AssistantPlan {
  const change = ConfirmPlan.parse(input);
  const plan = store.get<AssistantPlan>("assistant-plan", planId);
  if (!plan) throw new DomainError("NOT_FOUND", "Assistant plan not found", 404);
  const step = plan.plans.find(p => p.id === change.planId);
  if (!step) throw new DomainError("NOT_FOUND", "Plan step not found", 404);
  // Plans from a model run are usable only when its effects are verified or a human has reconciled them.
  preflightPlan(store, planId, change.planId);
  const expectedKind = ({ "create-project": "project", "update-requirements": "project", "scene-review": "scene-review", "plant-layout": "scene-review", "robot-cell": "scene-review", "robot-review": "review",
    "factory-criteria": "factory-criteria", "factory-review": "factory-review", "model-proposal": "proposal", "cad-review": "cad-review", "cad-code": "cad-review", "cad-sweep": "cad-sweep", "cad-optimize": "cad-optimize", "aero-body": "aero-review" } as const)[step.tool];
  if (expectedKind !== change.recordKind) throw new DomainError("PLAN_KIND_MISMATCH", "Executed record kind differs from the plan step", 422);
  const record = store.get<Record<string, unknown>>(change.recordKind, change.recordId);
  if (!record) throw new DomainError("NOT_FOUND", "Executed record not found", 404);
  const executed = (record.request ?? record) as Record<string, unknown>;
  const compared = Object.fromEntries(Object.keys(step.payload).filter(k => !["criteriaId", "expectedRevision", "projectRevision"].includes(k))
    .map(k => [k, executed[k] ?? (k === "criteria" ? record.criteria : k === "requirements" ? record.requirements : undefined)]));
  const proposed = Object.fromEntries(Object.entries(step.payload).filter(([k]) => !["criteriaId", "expectedRevision", "projectRevision"].includes(k)));
  const match = canonical(compared) === canonical(proposed) ? "as-proposed" as const : "edited-before-execution" as const;
  if (plan.confirmations.some(c => c.planId === change.planId)) return plan;
  const next = { ...plan, confirmations: [...plan.confirmations, { ...change, at: new Date().toISOString(), match }] };
  store.put("assistant-plan", next);
  return next;
}
