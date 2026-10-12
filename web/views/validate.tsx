import { lazy, Suspense, useEffect, useState } from "react";
import { matchReport, type Imported } from "../fai-import";
import { api, requestIdFor } from "../api";
import type { Characteristic, Inspection } from "../../src/inspection";
import { CANDIDATES, KIND_LABEL, useApp, type Attachment, type RunKind } from "../context";
import { Card, Check, Chip, Empty, ViewHeader, Verdict, projectRuns, revealInScroller, time, verdictOf, type RunItem } from "../ui";
import { LiveSteps, viewportModel } from "../studio";
import { FactoryResult } from "../factory";
import { recordCaseFeedback } from "../actions";
import { FEEDBACK_STATUS } from "../context";
import type { Review } from "../../src/contracts";
import type { SceneReview } from "../../src/scenes";
import type { CadReview } from "../../src/cad";
import { CAD_CHECK_LABELS, CAD_VARIANTS, ISOLATION_LABEL } from "../context";
import { CheckTable, type MeasuredCheck } from "../ui";
import { CompareCandidates } from "./compare";
import { isPlantScene, PlantDetail } from "../plant";
import { isRobotScene, RobotDetail } from "../robotcell";
import { AeroDetail } from "../aero";

const Viewport = lazy(() => import("../viewport"));

export function CaseList({ runId }: { runId: string }) {
  const c = useApp();
  const cases = (c.lifecycle?.failingCases ?? []).filter(x => x.runId === runId);
  if (!cases.length) return null;
  return <Card title="保留的失败案例" aside={<small>失败案例须绑定反馈并复测</small>}>
    <ul className="cases">{cases.map(fc => <li key={`${fc.checkId ?? ""}-${fc.seed}`}>
      <span className="case-label">{fc.label}</span>
      <span className="case-actions">
        {fc.kind === "robot-review" && <button type="button" className="secondary" onClick={() => c.navigate("evidence", { kind: fc.kind, id: fc.runId, seed: String(fc.seed) })}>回放</button>}
        {fc.feedbackId ? <button type="button" className="link" onClick={() => c.navigate("feedback", { id: fc.feedbackId })}><Chip tone={fc.feedbackStatus === "closed" ? "ok" : "warn"}>反馈 · {FEEDBACK_STATUS[fc.feedbackStatus!]}</Chip></button>
          : <button type="button" disabled={c.busy} aria-label={`记录反馈：${fc.label}`} onClick={() => void recordCaseFeedback(c, fc)}>记录反馈</button>}
      </span></li>)}</ul>
  </Card>;
}

function Receipts({ value }: { value: unknown }) {
  return <details className="receipts"><summary>原生回执与来源指纹</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function robotDetail(run: Review, id: string, passed: boolean | null): string {
  const r = run.project.requirements, c = run.stress?.conditions.find(x => x.id === run.candidate);
  const t = run.stress?.paired_exact_test.comparisons.find(x => x.condition === run.candidate);
  if (id === "minimum-recorded-success") return `记录成功 ${c?.successes ?? "—"}/${c?.trials ?? "—"}；要求不低于 ${r.minSuccessRate * 100}%`;
  if (id === "preserve-baseline-success") return passed === null ? `丢失 ${run.diff?.blocking_changes ?? "—"} 个基准成功样本；本任务未要求保留` : `EvalArc 检测到丢失 ${run.diff?.blocking_changes ?? "—"} 个基准成功样本`;
  return t ? `Holm 调整 p=${t.holm_adjusted_p}，α=${r.alpha}；${passed === null ? "本任务未要求显著改善" : passed ? "显著改善" : "不支持显著改善"}` : "基准设置不是改善比较";
}
function ReviewDetail({ run }: { run: Review }) {
  const c = useApp();
  const v = verdictOf("robot-review", run.decision?.verdict, run.state);
  const lost = run.diff?.blocking_changes;
  return <>
    <Verdict tone={v.tone} eyebrow={`Robot Reel 记录评审 · ${CANDIDATES[run.candidate]} · 需求 v${run.projectRevision}`} title={v.label}
      detail={run.error ?? (lost ? `配对记录丢失 ${lost} 个基准成功案例；${run.project.requirements.preserveBaselineSuccess ? "当前需求要求保留这些案例。" : "此任务未把保留基准设为硬约束。"}` : "记录检查已保存；结论不外推到真实环境。")} />
    {run.stress && <div className="metrics">{run.stress.conditions.map(x => <div key={x.id} className={x.id === run.candidate ? "current" : ""}>
      <span>{CANDIDATES[x.id]}</span><strong>{x.successes}<small>/{x.trials}</small></strong><p>Wilson 95% {x.wilson95.map(n => `${(n * 100).toFixed(0)}%`).join("–")}</p></div>)}</div>}
    {run.decision && <ul className="checks">{run.decision.checks.map(x => <Check key={x.id} passed={x.passed} detail={robotDetail(run, x.id, x.passed)}
      title={{ "minimum-recorded-success": "最低成功率", "preserve-baseline-success": "基准成功保留", "independent-improvement": "统计改善要求" }[x.id] ?? x.id}
      onAsk={() => c.askAI(`机器人记录评审（${CANDIDATES[run.candidate]}）的检查「${x.id}」未通过：${robotDetail(run, x.id, x.passed)}。为什么？请引用记录，并说明下一步应该复测什么。`)} />)}</ul>}
    <Receipts value={{ request: run.request, requirementDigest: run.requirementDigest, sourceDigests: run.sourceDigests, receipts: run.receipts, controller: run.controller }} />
  </>;
}

/**
 * "Ask AI with the picture": sends recorded native images (digest re-checked on the server) with the question. Shown only
 * when the deployment's executor pins images by digest; the native checks stay the verdict.
 */
function VisualAsk({ attachments, message }: { attachments: Attachment[]; message: string }) {
  const c = useApp();
  if (!c.data.capabilities.assistant?.images || !attachments.length) return null;
  return <div className="visual-ask"><button type="button" className="secondary" onClick={() => c.askAI(message, attachments)}>带图问 AI（{attachments.length} 张已记录图像）</button>
    <small className="muted">模型看图只作参考，结论以原生检查为准</small></div>;
}

const SCENE_CHECK: Record<string, string> = { "footprint-area": "静态占地", "declared-target-envelope": "声明的目标包络", "camera-visibility": "原生相机射线可见性" };
function SceneDetail({ scene }: { scene?: SceneReview }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "blender-scene" && c.session.running;
  const model = viewportModel(c.session, scene, live ? c.session!.current ?? which : which);
  const v = scene ? verdictOf("blender-scene", scene.verdict, scene.state) : { label: "Blender 原生构建中", tone: "live" as const };
  return <>
    <Verdict tone={v.tone} eyebrow={`Blender 原生几何评审${scene ? ` · ${scene.request.variant === "occluded" ? "带遮挡候选" : "无遮挡布局"} · ${scene.candidate?.blenderVersion ?? "Blender"}` : ""}`} title={v.label}
      detail={scene?.error ?? (scene?.state === "completed" ? `EvalArc 检测到 ${scene.diff?.blocking_changes ?? "—"} 项丢失的检查；静态几何结论不外推到动态执行。` : "每完成一个构建阶段，原生几何即推送到视口。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model} /></Suspense>
    <div className="segmented" role="group" aria-label="布局">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "基准布局" : "候选布局"}</button>)}</div>
    {scene?.state === "completed" && <>
      <ul className="checks">{scene.candidate?.checks.map(x => {
        const observed = typeof x.observed === "number" ? x.observed.toFixed(2) : "—", required = typeof x.required === "number" ? x.required.toFixed(2) : "—";
        const hit = x.firstHit === "Target" ? "目标中心" : x.firstHit === "Visibility obstruction" ? "遮挡物" : "其他物体";
        const detail = x.id === "footprint-area" ? `占地 ${observed} m²；允许上限 ${required} m²` : x.id === "declared-target-envelope" ? `目标平面距离 ${observed} m；声明包络半径 ${required} m，不代表关节可达性`
          : `相机射线首先命中${hit}；原生投影与射线检查${x.passed ? "通过" : "失败"}`;
        return <Check key={x.id} passed={x.passed} title={SCENE_CHECK[x.id]} detail={detail}
          onAsk={() => c.askAI(`Blender 场景的「${SCENE_CHECK[x.id]}」未通过（${detail}）。为什么？请引用记录，并给出不放宽需求的布局修正方案。`)} />;
      })}</ul>
      <div className="scene-previews">{(["baseline", "candidate"] as const).map(w => <figure key={w}><img alt={`${w === "baseline" ? "基准" : "候选"}合成工作单元原生 Cycles 渲染`} src={`/api/scenes/${scene.id}/files/${w}/preview.png`} />
        <figcaption>{w === "baseline" ? "基准" : "候选"} · 原生 Cycles 渲染</figcaption></figure>)}</div>
      <VisualAsk message="附图是基准和候选工作单元的检测相机视图（原生渲染）。请对照图像和检查记录说明候选布局在视线、包络或占地上的问题，并给出不放宽需求的修正方案。"
        attachments={(["baseline", "candidate"] as const).filter(w => scene.files[`${w}/preview.png`]).map(w => ({ recordKind: "scene-review" as const, recordId: scene.id, which: w, file: "preview.png", label: `${w === "baseline" ? "基准" : "候选"}相机视图` }))} />
      <Receipts value={{ request: scene.request, requirementDigest: scene.requirementDigest, receipts: scene.receipts, files: scene.files, rays: scene.rays }} />
    </>}
  </>;
}

/** CAD checks as measured rows; margin = share of the allowance left (negative = violated). */
function cadRows(checks: { id: string; passed: boolean; observed?: unknown; required?: unknown }[]): MeasuredCheck[] {
  const num = (v: unknown) => typeof v === "number" ? v : NaN;
  const ge = (o: number, r: number) => r ? (o - r) / r : undefined, le = (o: number, r: number) => r ? (r - o) / r : undefined;
  return checks.map(x => {
    const o = num(x.observed), r = num(x.required), title = CAD_CHECK_LABELS[x.id] ?? x.id;
    if (x.id === "max-deflection") return { id: x.id, title, passed: x.passed, observed: o.toFixed(4), required: `≤ ${r}`, unit: "mm", margin: le(o, r), note: "CalculiX · 轴心位移（细网格）" };
    if (x.id === "bore-distortion") return { id: x.id, title, passed: x.passed, observed: (o * 1000).toFixed(2), required: `≤ ${(r * 1000).toFixed(1)}`, unit: "µm", margin: le(o, r), note: "CalculiX · 受载轴承孔失圆（去除平移后的径向位移极差）" };
    if (x.id === "max-stress") return { id: x.id, title, passed: x.passed, observed: o.toFixed(1), required: `≤ ${r}`, unit: "MPa", margin: le(o, r), note: "CalculiX · 远离约束的峰值 von Mises" };
    if (x.id === "min-wall") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≥ ${r}`, unit: "mm", margin: ge(o, r), note: "板厚与孔间韧带" };
    if (x.id === "hole-edge-distance") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≥ ${r}`, unit: "mm", margin: ge(o, r), note: "1.5×d 经验规则" };
    if (x.id === "mass") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≤ ${r}`, unit: "g", margin: le(o, r), note: "6061 铝名义密度" };
    if (x.id === "motor-interference") return { id: x.id, title, passed: x.passed, observed: String(o), required: "0", unit: "mm³", note: "与电机机体、止口、轴的布尔交集" };
    if (x.id === "envelope") {
      const ob = x.observed as number[], rq = x.required as number[];
      return { id: x.id, title, passed: x.passed, observed: ob.join(" × "), required: `≤ ${rq.join(" × ")}`, unit: "mm", margin: Math.min(...ob.map((v, i) => (rq[i] - v) / rq[i])) };
    }
    if (x.id === "nema17-interface") {
      const v = x.observed as { pilotBore: number; boltHoles: number[]; pitch: number[] };
      return { id: x.id, title, passed: x.passed, observed: `Ø${v.pilotBore} · 4×Ø${v.boltHoles[0] ?? "—"} · ${v.pitch.join("/")}`, required: "≥ Ø22.2 · 4×Ø3.4 · 31", unit: "mm", margin: ge(v.pilotBore, 22.2) };
    }
    if (x.id === "bearing-seat") {
      const v = x.observed as { seatDiameter: number | null; seatLength: number; axisOffset: number | null }, rq = x.required as { seatDiameter: [number, number]; seatLengthMin: number };
      return { id: x.id, title, passed: x.passed, observed: `Ø${v.seatDiameter ?? "—"} · 长 ${v.seatLength} · 偏心 ${v.axisOffset ?? "—"}`, required: `Ø${rq.seatDiameter[0]}–${rq.seatDiameter[1]} · ≥ ${rq.seatLengthMin}`, unit: "mm",
        margin: v.seatDiameter === null ? undefined : Math.min(v.seatDiameter - rq.seatDiameter[0], rq.seatDiameter[1] - v.seatDiameter) / (rq.seatDiameter[1] - rq.seatDiameter[0]), note: "6202 外圈 Ø35，H7 公差带（ISO 286）" };
    }
    if (x.id === "shoulder") {
      const rq = x.required as [number, number];
      return { id: x.id, title, passed: x.passed, observed: o.toFixed(2), required: `${rq[0]}–${rq[1]}`, unit: "mm", note: "轴孔留间隙，外圈有足够的止口支承（ISO 355）" };
    }
    if (x.id === "machining-setups") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≤ ${r}`, unit: "次", margin: le(o, r), note: "三轴主方向集合覆盖；孔按无遮挡钻削通道" };
    if (x.id === "hole-drillability") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≤ ${r}`, unit: "深径比", margin: le(o, r), note: "孔深/孔径，且至少一端钻削通道无遮挡" };
    if (x.id === "fastener-access") return { id: x.id, title, passed: x.passed, observed: String(o), required: "0", unit: "个孔", note: "ISO 4762 螺钉头与内六角扳手在落座侧的空间" };
    if (x.id === "cam-toolpath") return { id: x.id, title, passed: x.passed, observed: x.observed === "verified" ? "仿真通过" : Array.isArray(x.observed) ? (x.observed as string[]).map(id => ({ "no-gouge": "过切", "no-residual": "残料", "tool-engagement": "刀具过载", "no-rapid-collision": "快移碰撞" } as Record<string, string>)[id] ?? id).join("、") : String(x.observed), required: "无过切/残料/碰撞", unit: "", note: "G-code 在 0.1 mm 高度图上独立仿真" };
    if (x.id === "cycle-time") return { id: x.id, title, passed: x.passed, observed: typeof x.observed === "number" ? o.toFixed(1) : "—", required: `≤ ${r}`, unit: "min", margin: Number.isFinite(o) ? le(o, r) : undefined, note: "按程序进给与快移速度，不含换刀与装夹" };
    if (x.id === "unit-cost") return { id: x.id, title, passed: x.passed, observed: o.toFixed(2), required: Number.isFinite(r) ? `≤ ${r}` : "—", unit: "EUR", margin: Number.isFinite(r) ? le(o, r) : undefined, note: "估算，不是报价" };
    return { id: x.id, title, passed: x.passed, observed: String(x.observed), required: "1", unit: "实体", note: "OCCT BRepCheck" };
  });
}
const SANDBOX_STATUS: Record<string, string> = { ok: "已生成实体", policy: "违反代码策略", error: "代码出错", limit: "超出资源上限" };
function CadDetail({ cad }: { cad?: CadReview }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "cad-part" && c.session.running;
  const model = viewportModel(c.session, cad, live ? c.session!.current ?? which : which, "cad-part");
  const v = cad ? verdictOf("cad-part", cad.verdict, cad.state) : { label: "CadQuery 原生建模中", tone: "live" as const };
  const shown = which === "baseline" ? cad?.baseline : cad?.candidate;
  const fea = cad?.state === "completed" ? cad.fea?.[which] : undefined;
  const [stressView, setStressView] = useState(true);
  const shownModel = model && fea && stressView ? { ...model, stages: [], finalUrl: `/api/cad/${cad!.id}/files/${which}/fea.glb`, title: `${model.title} · von Mises` } : model;
  // While the part is still building there is no record yet; the live session title names the family.
  const pillow = cad ? cad.request.variant.startsWith("pillow-block") || cad.request.family === "pillow-block" : Boolean(live && c.session?.title.includes("轴承座"));
  return <>
    <Verdict tone={v.tone} eyebrow={`参数化 CAD · ${pillow ? "6202 轴承座" : "NEMA 17 电机支架"}${cad ? ` · ${CAD_VARIANTS[cad.request.variant][0]} · CadQuery ${cad.candidate?.cadquery ?? ""}` : ""}`} title={v.label}
      detail={cad?.error ?? (cad?.state === "completed" ? `EvalArc 检测到 ${cad.diff?.blocking_changes ?? "—"} 项丢失的检查；质量 ${cad.baseline?.mass} → ${cad.candidate?.mass} g。名义几何${cad.fea ? "；结构检查为 CalculiX 线性静力 FEA" : "，未冻结结构要求（无 FEA）"}，不含实物测试。` : `每完成一个建模特征，B-Rep 几何即推送到视口；最后叠加${pillow ? " 6202 轴承" : " NEMA 17 电机"}做装配检查。`)} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={shownModel} /></Suspense>
    {fea && <div className="fea-bar" role="group" aria-label="FEA 结果">
      <label className="check"><input type="checkbox" checked={stressView} onChange={e => setStressView(e.target.checked)} />显示 von Mises 应力云图（变形放大 {fea.displayScale}×）</label>
      <span className="fea-scale" aria-hidden="true"><i /></span><small>0 → {fea.colorScaleMaxMPa} MPa</small>
      <small>{fea.solver} · {fea.mesher} · {fea.element} · 细网格 {fea.meshes.fine?.elements} 单元 · 两级网格挠度差 {(fea.convergence.axisDisplacement * 100).toFixed(1)}%、峰值应力差 {(fea.convergence.peakVonMises * 100).toFixed(1)}%</small>
    </div>}
    {cad?.state === "completed" && cad.surrogate?.[which] && <SurrogateCard c={cad.surrogate[which]!} />}
    <div className="segmented" role="group" aria-label="零件">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "基准零件" : "候选零件"}</button>)}</div>
    {cad?.sandbox && <details className="code-source" open={cad.state === "failed"}>
      <summary>生成代码 · {cad.request.source!.code.split("\n").length} 行 · sha256 {cad.sandbox.codeSha256.slice(0, 12)} · 沙箱结果 {SANDBOX_STATUS[cad.sandbox.status] ?? cad.sandbox.status}</summary>
      {cad.sandbox.error && <p className="warning">⚠ {cad.sandbox.error}</p>}
      <p className="muted">{cad.sandbox.transport === "agentcore" ? "运行位置：Amazon Bedrock AgentCore（arm64 microVM）· " : ""}隔离：{cad.sandbox.isolation.map(x => ISOLATION_LABEL[x] ?? x).join(" · ")}
        {cad.sandbox.layers && ` · 实际启用：${Object.entries(cad.sandbox.layers).filter(([, v]) => v).map(([k]) => ({ astPolicy: "AST 策略", processLockdown: "进程锁定", bubblewrap: "bubblewrap", microvm: "microVM" } as Record<string, string>)[k]).join("、")}`}</p>
      <pre className="code">{cad.request.source!.code}</pre>
    </details>}
    {cad?.state === "completed" && shown && <>
      <CheckTable caption={`${which === "baseline" ? "基准" : "候选"}零件 · B-Rep 实测`} rows={cadRows(shown.checks)}
        onAsk={row => c.askAI(`${CAD_VARIANTS[cad.request.variant][0]}零件的「${row.title}」实测 ${row.observed} ${row.unit}，要求 ${row.required} ${row.unit}，为什么未通过？请引用检查记录，并给出在不放宽要求的前提下的修正方案（预设变体或 cad-code）。`)} />
      {cad.files[`${which}/fea.png`] && <figure className="result-image"><img alt={`${which === "baseline" ? "基准" : "候选"}零件 von Mises 应力云图（原生 Blender 渲染，等轴测与正视）`} src={`/api/cad/${cad.id}/files/${which}/fea.png`} />
        <figcaption>{which === "baseline" ? "基准" : "候选"} · von Mises 应力云图 · 0 → {fea?.colorScaleMaxMPa ?? "—"} MPa · 原生 Blender 渲染，按摘要登记</figcaption></figure>}
      <VisualAsk message={`附图是${which === "baseline" ? "基准" : "候选"}支架的 von Mises 应力云图（CalculiX 结果，色标 0 → ${fea?.colorScaleMaxMPa ?? "?"} MPa，变形放大 ${fea?.displayScale ?? "?"}×）。请对照图像和 FEA 检查记录指出应力集中和刚度薄弱的位置，并给出不放宽要求的加强方案（预设变体或 cad-code）。`}
        attachments={cad.files[`${which}/fea.png`] ? [{ recordKind: "cad-review", recordId: cad.id, which, file: "fea.png", label: `${which === "baseline" ? "基准" : "候选"}应力云图` }] : []} />
      {cad.files[`${which}/cam-sim.png`] && <figure className="result-image"><img alt={`${which === "baseline" ? "基准" : "候选"}零件切削仿真结果（每个装夹一幅高度图）`} src={`/api/cad/${cad.id}/files/${which}/cam-sim.png`} />
        <figcaption>切削仿真 · 由 G-code 独立计算的 0.1 mm 高度图 · 红=过切，橙=残料，蓝=刀具够不到的内角</figcaption></figure>}
      <VisualAsk message={`附图是${which === "baseline" ? "基准" : "候选"}零件的切削仿真结果（按装夹的高度图）。请对照图像和 CAM 检查记录说明残料、过切或刀具够不到的位置及其原因，并给出不放宽要求的改进（设计圆角、换刀或调整装夹）。`}
        attachments={cad.files[`${which}/cam-sim.png`] ? [{ recordKind: "cad-review", recordId: cad.id, which, file: "cam-sim.png", label: `${which === "baseline" ? "基准" : "候选"}切削仿真` }] : []} />
      {Object.keys(cad.files).some(f => f.startsWith(`${which}/setup`)) && <div className="button-row" role="group" aria-label="CAM 程序">
        {Object.keys(cad.files).filter(f => f.startsWith(`${which}/setup`) && f.endsWith(".nc")).sort().map(f => <a key={f} className="button secondary" href={`/api/cad/${cad.id}/files/${f}`}>下载 G-code · 装夹 {f.split("setup")[1].replace(".nc", "")}</a>)}
        <a className="button secondary" href={`/api/cad/${cad.id}/files/${which}/cam-verify.json`}>切削仿真报告</a></div>}
      <div className="scene-previews drawings">{(["baseline", "candidate"] as const).map(w => <figure key={w}><img alt={`${w === "baseline" ? "基准" : "候选"}零件 SVG 工程视图`} src={`/api/cad/${cad.id}/files/${w}/drawing.svg`} />
        <figcaption>{w === "baseline" ? "基准" : "候选"} · OCCT 投影视图（含隐藏线）</figcaption></figure>)}</div>
      {cad.verdict === "accepted-cad-part" && <FirstArticle cad={cad} />}
      <Receipts value={{ request: cad.request, requirementDigest: cad.requirementDigest, receipts: cad.receipts, files: cad.files, parameters: { baseline: cad.baseline?.parameters, candidate: cad.candidate?.parameters } }} />
    </>}
  </>;
}

export function Validate() {
  const c = useApp();
  const { project, route, session } = c;
  const runs = projectRuns(c.data, project?.id);
  const kind = route.params.get("kind") as RunKind | null, id = route.params.get("id");
  const live = session?.running && session.kind !== "assistant" && session.kind !== "cad-sweep" && session.kind !== "cad-optimize" ? { ...session, kind: session.kind as RunKind } : undefined;
  const selected: RunItem | undefined = runs.find(r => r.id === id) ?? (live && !id ? undefined : runs.find(r => !kind || r.kind === kind));
  const liveKind = live && !selected ? live.kind : undefined;
  // Keep the selected record visible in the list or strip (it may be off-screen after navigation).
  useEffect(() => { revealInScroller(document.querySelector(".run-list .run.selected")); }, [selected?.id]);
  if (!project) return <><ViewHeader step="阶段 3 / 6 · 原生验证" title="原生验证" /><Empty title="先冻结需求" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>} /></>;
  const detailKind = selected?.kind ?? liveKind;
  return <>
    <ViewHeader step="阶段 3 / 6 · 原生验证" title="原生验证" description="原生工具执行，独立检查对照；失败案例原样保留。实时事件只用于展示，结论以保存的记录为准。"
      actions={<button type="button" className="secondary" onClick={() => c.navigate("design")}>新候选</button>} />
    <div className="master-detail">
      <nav className="run-list" aria-label="检查记录">
        {runs.length === 0 && !live && <Empty title="还没有检查记录" action={<button type="button" onClick={() => c.navigate("design")}>提交候选</button>} />}
        {live && <button type="button" className={`run ${!selected ? "selected" : ""}`} aria-pressed={!selected} onClick={() => c.navigate("validate", { kind: live.kind })}>
          <span className="run-kind">{KIND_LABEL[live.kind]}</span><strong>{live.title}</strong><Chip tone="live">运行中</Chip></button>}
        {runs.map(r => { const v = verdictOf(r.kind, r.verdict, r.state); return <button key={r.id} type="button" className={`run ${selected?.id === r.id ? "selected" : ""}`}
          aria-pressed={selected?.id === r.id} aria-label={`${KIND_LABEL[r.kind]} ${r.title} ${v.label}`} onClick={() => c.navigate("validate", { kind: r.kind, id: r.id })}>
          <span className="run-kind">{KIND_LABEL[r.kind]}{r.recheck ? " · 复测" : ""}</span><strong>{r.title}</strong><Chip tone={v.tone}>{v.label}</Chip>
          <small>{time(r.createdAt)} · 需求 v{r.revision} · {r.id.slice(0, 8)}</small></button>; })}
      </nav>
      <div className="detail">
        {session && session.kind !== "assistant" && session.kind !== "cad-sweep" && session.kind !== "cad-optimize" && session.running && <Card><LiveSteps session={session} /></Card>}
        {detailKind === "robot-review" && selected && <ReviewDetail run={c.data.reviews.find(r => r.id === selected.id)!} />}
        {detailKind === "blender-scene" && (() => {
          const scene = selected ? c.data.scenes.find(s => s.id === selected.id) : undefined;
          const plant = scene ? isPlantScene(scene) : session?.kind === "blender-scene" && (session.title.includes("工厂产线") || session.steps.some(x => x.label.includes("产线")));
          if (isRobotScene(scene) || (!scene && session?.kind === "blender-scene" && session.title.includes("MuJoCo"))) return <RobotDetail scene={isRobotScene(scene) ? scene : undefined} Receipts={Receipts} />;
          return plant ? <PlantDetail scene={isPlantScene(scene) ? scene : undefined} Receipts={Receipts} /> : <SceneDetail scene={scene} />;
        })()}
        {detailKind === "cad-part" && <CadDetail cad={selected ? (c.data.cads ?? []).find(s => s.id === selected.id) : undefined} />}
        {detailKind === "aero-body" && <AeroDetail run={selected ? (c.data.aeros ?? []).find(s => s.id === selected.id) : undefined} />}
        {detailKind === "factory-twin" && selected && <FactoryResult review={(c.data.factoryReviews ?? []).find(r => r.id === selected.id)!} />}
        {liveKind && liveKind !== "blender-scene" && liveKind !== "cad-part" && liveKind !== "aero-body" && <Empty title="正在执行原生任务">完成后显示结论与检查项。</Empty>}
        {session && session.kind !== "assistant" && session.kind !== "cad-sweep" && session.kind !== "cad-optimize" && !session.running && session.recordId === selected?.id &&
          <details className="card run-log"><summary>本次执行记录 · {session.steps.length} 步</summary><LiveSteps session={session} /></details>}
        {selected && selected.state === "completed" && <>
          <CaseList runId={selected.id} />
          <CompareCandidates kind={selected.kind} selected={selected.id} />
          <div className="button-row end"><button type="button" className="secondary" onClick={() => c.navigate("evidence", { kind: selected.kind, id: selected.id })}>查看证据与回放 →</button></div>
        </>}
      </div>
    </div>
  </>;
}

/**
 * First-article inspection of the accepted part: the plan comes from the frozen requirements; the maintainer enters
 * what was measured on a real part. Conforming or not, the result is kept as physical evidence and travels with the
 * release; the simulated review itself is never changed by it.
 */
function FirstArticle({ cad }: { cad: CadReview }) {
  const c = useApp();
  const [plan, setPlan] = useState<Characteristic[]>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [who, setWho] = useState(""), [instrument, setInstrument] = useState(""), [serial, setSerial] = useState("");
  const [imported, setImported] = useState<Imported>();
  const done = (c.data.inspections ?? []).filter(i => i.cadReviewId === cad.id);
  const open = async () => setPlan((await api<{ characteristics: Characteristic[] }>(`/cad/${cad.id}/inspection-plan`, undefined, "GET")).characteristics);
  const tol = (p: Characteristic) => p.lower !== undefined && p.upper !== undefined ? `${p.lower} – ${p.upper}` : p.lower !== undefined ? `≥ ${p.lower}` : `≤ ${p.upper}`;
  const complete = plan && plan.every(p => values[p.id]?.trim() && Number.isFinite(Number(values[p.id]))) && who.trim().length >= 2 && instrument.trim().length >= 2 && serial.trim();
  return <Card title="首件检验（实测回填）" aside={<small>实测记录随发布签名；仿真结论不会被改写</small>}>
    {done.length > 0 && <ul className="fai-list">{done.map(i => <li key={i.id} className={i.verdict === "conforming" ? "ok" : "bad"}>
      <strong>{i.partSerial} · {i.verdict === "conforming" ? "合格" : "不合格"}</strong>
      <small>{i.measuredBy} · {i.instrument} · {new Date(i.createdAt).toLocaleString()}{i.verdict === "nonconforming" ? ` · 超差：${i.results.filter(r => !r.passed).map(r => `${r.label} ${r.measured}（${tol(r)}）`).join("；")}` : ""}</small></li>)}</ul>}
    {!plan ? <button type="button" className="secondary" onClick={() => void open().catch(e => c.toast(String(e), "bad"))}>生成检验计划并录入实测值</button> : <>
      <div className="table-wrap"><table className="data-table fai-table"><caption className="visually-hidden">首件检验计划</caption>
        <thead><tr><th scope="col">特性 · 量具</th><th scope="col">名义</th><th scope="col">公差</th><th scope="col">实测</th></tr></thead>
        <tbody>{plan.map(p => <tr key={p.id}><th scope="row">{p.label}<small>{p.instrument}</small></th><td className="num">{p.nominal}</td><td className="num">{tol(p)} {p.unit}</td>
          <td><input className="fai-input" type="number" step="any" inputMode="decimal" aria-label={`实测 ${p.label}`} value={values[p.id] ?? ""} onChange={e => setValues({ ...values, [p.id]: e.target.value })} /></td></tr>)}</tbody></table></div>
      <div className="fai-import"><label className="button secondary">导入 CMM 报告（QIF / CSV）<input type="file" accept=".qif,.QIF,.csv,text/csv,application/xml" className="visually-hidden"
        aria-label="导入 CMM 报告（QIF / CSV）" onChange={e => { const f = e.target.files?.[0]; if (f) void f.text().then(t => {
          try { const r = matchReport(f.name, t, plan); setValues({ ...values, ...r.values }); setImported(r); }
          catch (err) { c.toast(err instanceof Error ? err.message : String(err), "bad"); }
        }); e.target.value = ""; }} /></label>
        <small>QIF 3.0 Results（ISO 23952，按特性名称或 Designator 对应）或 CSV（每行：特性 ID 或名称，实测值）。导入后仍可逐项核对和修改，判定由服务器做</small>
        {imported && <small role="status">{imported.format === "qif" ? "QIF" : "CSV"}：已填入 {Object.keys(imported.values).length} / {plan.length} 项{imported.note ? `（${imported.note}）` : ""}{imported.unmatched.length ? `；未识别：${imported.unmatched.slice(0, 5).join("、")}${imported.unmatched.length > 5 ? ` 等 ${imported.unmatched.length} 项` : ""}` : ""}</small>}</div>
      <div className="field-grid">
        <label>检验员<input value={who} onChange={e => setWho(e.target.value)} aria-label="检验员" /></label>
        <label>测量设备<input value={instrument} onChange={e => setInstrument(e.target.value)} aria-label="测量设备" placeholder="例如 CMM、气动量仪" /></label>
        <label>零件序列号<input value={serial} onChange={e => setSerial(e.target.value)} aria-label="零件序列号" /></label>
      </div>
      <div className="form-foot"><small>每项按冻结公差判定；超差记录为不合格并保留，不会自动重测</small>
        <button type="button" disabled={c.busy || !complete} onClick={() => void c.perform(async () => {
          const body = { requestId: requestIdFor(`pai-fai-${cad.id}-${serial}-${JSON.stringify(values)}`), measuredBy: who, instrument, partSerial: serial,
            values: Object.fromEntries(plan.map(p => [p.id, Number(values[p.id])])) };
          const r = await api<Inspection>(`/cad/${cad.id}/inspections`, body);
          setPlan(undefined); setValues({});
          if (r.verdict === "nonconforming") throw new Error(`零件 ${r.partSerial} 不合格：${r.results.filter(x => !x.passed).map(x => x.label).join("、")}`);
        }, "首件检验已记录：全部特性在公差内。")}>记录首件检验</button></div>
    </>}
  </Card>;
}

/** The surrogate's prediction made before CalculiX ran, next to the measurement: record only, never a verdict. */
function SurrogateCard({ c }: { c: NonNullable<NonNullable<CadReview["surrogate"]>["candidate"]> }) {
  const rows = [["最大挠度", "deflectionMm", "mm", 4], ["最大应力", "stressMPa", "MPa", 1], ["质量", "mass", "g", 1]] as const;
  return <section className="surrogate-card" aria-label="代理模型预测与实测">
    <h3>AI 代理模型 · 求解前预测 vs CalculiX 实测</h3>
    {c.state !== "predicted" || !c.prediction || !c.measured ? <p className="muted">{c.artifact}：{c.state === "not-applicable" ? "不适用" : "预测失败"}（{c.reason}）。结论只来自 CalculiX。</p> : <>
      <div className="table-wrap"><table className="data-table"><caption className="visually-hidden">代理模型预测与实测</caption>
        <thead><tr><th scope="col">量</th><th scope="col">预测（90 % 区间）</th><th scope="col">CalculiX 实测</th><th scope="col">相对误差</th></tr></thead>
        <tbody>{rows.map(([label, k, unit, d]) => <tr key={k}><th scope="row">{label}</th>
          <td>{c.prediction![k].toFixed(d)} {unit} <small className="muted">（{c.prediction!.interval90[k][0].toFixed(d)}–{c.prediction!.interval90[k][1].toFixed(d)}）</small></td>
          <td>{c.measured![k].toFixed(d)} {unit}</td>
          <td>{((c.relError?.[k] ?? 0) * 100).toFixed(1)} %{c.inInterval?.[k] === false && <small className="bad-text"> 区间外</small>}</td></tr>)}</tbody></table></div>
      <small className="muted">{c.artifact} · 推理 {c.prediction.ms} ms · 只用几何（无配方参数） · 权限：无，仅供排序与筛选；验收只看实测。</small>
    </>}
  </section>;
}
