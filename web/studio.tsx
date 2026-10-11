import type { AeroReview } from "../src/aero";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, openLive, requestIdFor, type LiveEvent } from "./api";
import { CAD_DRAFT_KEY, useApp, type Attachment, type RunKind } from "./context";
import type { ViewportModel, Stage, Ray } from "./viewport";
import type { AssistantPlan, ToolPlan } from "../src/assistant";
import type { Project } from "../src/contracts";
import type { SceneReview } from "../src/scenes";
import type { CadReview } from "../src/cad";

type Which = "baseline" | "candidate";
/** Assistant runs and design-space sweeps are not validation records; views that list reviews ignore them. */
export type SessionKind = RunKind | "assistant" | "cad-sweep" | "cad-optimize";
type CadRequirementsLike = { maxMassG: number; minWallMm: number; edgeDistanceFactor: number };
export interface LiveSession {
  requestId: string; title: string; kind: SessionKind; running: boolean; recordId?: string; verdict?: string; state?: string;
  steps: { id: string; label: string; status: string; detail?: string }[];
  stages: Record<Which, Stage[]>; rays: Partial<Record<Which, Ray>>; render: Partial<Record<Which, { sample: number; samples: number }>>; current?: Which;
}
export type LiveTrack = <T>(requestId: string, title: string, kind: SessionKind, work: () => Promise<T>) => Promise<T>;

/** One live session at a time; the assistant and the stage views both feed it. Presentation only. */
export function useLiveSession() {
  const [session, setSession] = useState<LiveSession>();
  const track: LiveTrack = useCallback(async (requestId, title, kind, work) => {
    setSession({ requestId, title, kind, running: true, steps: [], stages: { baseline: [], candidate: [] }, rays: {}, render: {} });
    const apply = (e: LiveEvent) => setSession(s => {
      if (!s || s.requestId !== requestId) return s;
      const next = { ...s };
      if (e.kind === "step") {
        next.steps = [...s.steps.filter(x => x.id !== e.id), { id: e.id, label: e.label, status: e.status, detail: e.detail }];
        if (e.which === "baseline" || e.which === "candidate") next.current = e.which;
      } else if (e.kind === "record") next.recordId = e.recordId;
      else if (e.kind === "stage") { next.stages = { ...s.stages, [e.which]: [...s.stages[e.which].filter(x => x.index !== e.index), { index: e.index, label: e.label, url: e.url, objects: e.objects }] }; next.current = e.which; }
      else if (e.kind === "ray") next.rays = { ...s.rays, [e.which]: e };
      else if (e.kind === "render") next.render = { ...s.render, [e.which]: { sample: e.sample, samples: e.samples } };
      else if (e.kind === "done") Object.assign(next, { running: false, state: e.state, verdict: e.verdict, recordId: e.recordId ?? s.recordId });
      return next;
    });
    const close = await openLive(requestId, apply);
    try {
      const result = await work();
      const record = result as { id?: string; state?: string; verdict?: string; decision?: { verdict: string } };
      setSession(s => s && s.requestId === requestId ? { ...s, running: false, recordId: record.id ?? s.recordId, state: record.state ?? s.state ?? "completed",
        verdict: record.verdict ?? record.decision?.verdict ?? s.verdict } : s);
      return result;
    } catch (error) {
      setSession(s => s && s.requestId === requestId ? { ...s, running: false, state: "failed" } : s);
      throw error;
    } finally { setTimeout(close, 2_000); }
  }, []);
  return { session, track };
}

export function viewportModel(session: LiveSession | undefined, scene: SceneReview | CadReview | AeroReview | undefined, which: Which,
  kind: "blender-scene" | "cad-part" | "aero-body" = "blender-scene"): ViewportModel | undefined {
  const base = kind === "cad-part" ? "/api/cad" : kind === "aero-body" ? "/api/aero" : "/api/scenes";
  const finalFile = kind === "cad-part" ? "assembly.glb" : kind === "aero-body" ? "aero.glb" : "scene.glb", units = kind === "cad-part" ? "mm" as const : "m" as const;
  const rays = (r?: SceneReview | CadReview | AeroReview) => (r as SceneReview | undefined)?.rays;
  const live = session?.kind === kind && (session.running || session.recordId === scene?.id || !scene) ? session : undefined;
  if (live && (live.stages.baseline.length || live.stages.candidate.length || live.running)) {
    const w = live.running ? live.current ?? "baseline" : which;
    const finalScene = !live.running && scene?.id === live.recordId && scene?.state === "completed" ? scene : undefined;
    return { key: live.requestId, which: w, stages: live.stages[w], ray: live.rays[w] ?? rays(finalScene)?.[w], render: live.render[w], units,
      running: live.running, title: live.title, finalUrl: finalScene ? `${base}/${finalScene.id}/files/${w}/${finalFile}` : undefined };
  }
  if (!scene) return undefined;
  const stages = (scene.stages?.[which] ?? []).map(s => ({ index: s.index, label: s.label, objects: s.objects, url: `${base}/${scene.id}/stages/${which}/${s.index}` }));
  return { key: scene.id, which, stages, ray: rays(scene)?.[which], running: scene.state === "running", units,
    title: `${kind === "cad-part" ? "零件" : kind === "aero-body" ? "车身" : "场景"} ${scene.id.slice(0, 8)}`,
    finalUrl: scene.state === "completed" ? `${base}/${scene.id}/files/${which}/${finalFile}` : undefined };
}

export function LiveSteps({ session }: { session: LiveSession }) {
  return <div className="live-steps" aria-label="实时工具步骤">
    <p><span className={`live-dot ${session.running ? "on" : ""}`} />{session.running ? "正在执行" : "最近执行"} · {session.title}</p>
    <ol>{session.steps.map(s => <li key={s.id} className={s.status}><span aria-hidden="true">{s.status === "done" ? "✓" : s.status === "failed" ? "×" : "◌"}</span>{s.label}{s.detail && <small>{s.detail}</small>}</li>)}</ol>
    {!session.running && <small>{session.state === "completed" ? `完成 · ${session.verdict ?? "已保存"}` : `状态：${session.state}`}；实时事件仅用于展示，结论以保存的记录为准。</small>}
  </div>;
}

const toolLabel: Record<string, string> = { "cad-review": "CadQuery", "create-project": "任务", "update-requirements": "需求修订", "scene-review": "Blender", "plant-layout": "Blender 产线", "robot-cell": "MuJoCo 工作单元", "robot-review": "Robot Reel",
  "factory-criteria": "冻结标准", "factory-review": "工厂孪生", "model-proposal": "受控模型", "cad-code": "CadQuery 代码", "cad-sweep": "参数扫描", "cad-optimize": "物理寻优" };
const directionLabel: Record<string, string> = { new: "新", same: "不变", tightened: "收紧", relaxed: "放宽", changed: "变更" };
const recordKind: Record<string, string> = { "cad-review": "cad-review", "create-project": "project", "update-requirements": "project", "scene-review": "scene-review", "plant-layout": "scene-review", "robot-cell": "scene-review", "robot-review": "review",
  "factory-criteria": "factory-criteria", "factory-review": "factory-review", "model-proposal": "proposal", "cad-code": "cad-review", "cad-sweep": "cad-sweep", "cad-optimize": "cad-optimize", "aero-body": "aero-review" };
const nativeKind: Record<string, RunKind> = { "cad-review": "cad-part", "scene-review": "blender-scene", "plant-layout": "blender-scene", "robot-cell": "blender-scene", "robot-review": "robot-review", "factory-review": "factory-twin", "cad-code": "cad-part", "aero-body": "aero-body" };
const SUGGESTIONS = [
  "生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m",
  "评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C",
  "评估 NEMA 17 电机支架轻量化方案：壁厚不低于 3 mm，质量不超过 80 g",
  "验证相机偏移的 SmolVLA 记录评审",
];

const PROFILE_NAME: Record<string, string> = { "kiro-primary": "Kiro 主账号", "kiro-backup": "Kiro 备用账号", "kiro-backup2": "Kiro 二备账号", codex: "Codex", claude: "Claude" };
const ERR: Record<string, string> = { quota: "额度不足", auth: "认证失败", unavailable: "不可用", timeout: "超时", invalid_output: "协议校验未通过" };
const STATE_CHIP: Record<string, [string, string]> = { done: ["已完成", "ok"], reconcile: ["待核对", "warn"], interrupted: ["已中断 · 待核对", "warn"],
  deferred: ["达到尝试上限", "muted"], blocked: ["执行器拒绝", "bad"], "invalid-output": ["输出无效", "bad"], running: ["运行中", "live"] };
const CITE_VIEW: Record<string, [string, string?]> = { review: ["validate", "robot-review"], "scene-review": ["validate", "blender-scene"], "cad-review": ["validate", "cad-part"], "aero-review": ["validate", "aero-body"],
  "factory-review": ["validate", "factory-twin"], feedback: ["feedback"], release: ["deliver"], project: ["overview"], "project-version": ["requirements"], "factory-criteria": ["requirements"] };
function openCitation(c: ReturnType<typeof useApp>, x: { kind: string; id: string }) {
  const [view, kind] = CITE_VIEW[x.kind] ?? ["overview"];
  if (view === "validate") c.navigate("validate", { kind, id: x.id });
  else if (view === "feedback") c.navigate("feedback", { id: x.id });
  else c.navigate(view as "overview");
}
function EngineMeta({ plan }: { plan: AssistantPlan }) {
  if (plan.source === "external") return <div className="meta"><span className="chip info" title={plan.model.reason}>外部 Agent · {plan.external?.agent ?? "MCP"}</span>
    {plan.external?.verified
      ? <span className="chip ok" title={`访问令牌已验证 · 客户端 ${plan.external.clientId}`}>已验证客户端 {plan.external.clientId?.slice(0, 8)}</span>
      : <span className="chip muted" title="名称由 Agent 自报；本机回环接口不验证身份">本机 · 名称自报</span>}
    {plan.external?.session && <span className="chip muted" title="Agent 会话标识（由调用方提供，用于对照其网关审计）">会话 {plan.external.session}</span>}
    <span className="chip muted">经 MCP · PAI 未调用模型</span><span className="chip muted">权限：无</span></div>;
  if (plan.source !== "model") return <div className="meta"><span className="chip muted">规则解析 · 无模型调用</span><span className="chip muted">权限：无</span></div>;
  const [label, tone] = STATE_CHIP[plan.state ?? "done"] ?? [plan.state ?? "", "muted"];
  const e = plan.ai?.engine;
  return <div className="meta">
    <span className={`chip ${tone}`}>{label}</span>
    {e && <span className="chip info" title={`版本 ${e.engineVersion ?? "未知"} · 模型依据 ${e.modelEvidence ?? "未知"}`}>{PROFILE_NAME[e.profile] ?? e.profile} · {e.model ?? "模型未知"}</span>}
    <span className="chip muted">权限：无</span>
    {(plan.ai?.attempts.length ?? 0) > 1 && <ol className="fallback" aria-label="引擎回退链">{plan.ai!.attempts.map(a =>
      <li key={a.profile} className={a.status === "succeeded" ? "ok" : "bad"}>{PROFILE_NAME[a.profile] ?? a.profile}{a.status === "succeeded" ? " ✓" : ` · ${ERR[a.errorKind ?? ""] ?? a.errorKind ?? a.status}`}</li>)}</ol>}
  </div>;
}

/** Docked AI assistant: intent → typed plan → human confirmation → same native routes as the forms. */
export function Assistant({ onClose }: { onClose: () => void }) {
  const c = useApp();
  const { project, session } = c;
  const plans = (c.data.assistantPlans ?? []).filter(p => !project || !p.projectId || p.projectId === project.id).slice(-8);
  const [message, setMessage] = useState("");
  const aiAvailable = Boolean(c.data.capabilities.modelProposal);
  const [mode, setMode] = useState<"ai" | "rules">(() => (localStorage.getItem("pai-assistant-mode") as "ai" | "rules" | null) ?? "ai");
  const useAi = aiAvailable && mode === "ai";
  useEffect(() => { localStorage.setItem("pai-assistant-mode", mode); }, [mode]);
  const [reconcileReason, setReconcileReason] = useState("已核对：文本请求，执行器拒绝了客户端工具与文件权限，工作区没有变化。");
  const [thinking, setThinking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [running, setRunning] = useState<string>();
  const timeline = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" }); }, [plans.length, session?.steps.length, running]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    // Context questions from the workspace ("问 AI" on a failed check, palette free text) prefill the composer.
    const ask = (e: Event) => { const detail = (e as CustomEvent<{ message: string; attachments?: Attachment[] }>).detail;
      const text = detail?.message; if (typeof text !== "string") return;
      setMessage(text); setAttachments(detail.attachments ?? []); if (aiAvailable) setMode("ai"); setTimeout(() => { input.current?.focus(); input.current?.setSelectionRange(text.length, text.length); }, 0); };
    window.addEventListener("pai-focus-chat", focus); window.addEventListener("pai-ask", ask);
    return () => { window.removeEventListener("pai-focus-chat", focus); window.removeEventListener("pai-ask", ask); };
  }, [aiAvailable]);

  async function send(e?: FormEvent, text = message) {
    e?.preventDefault();
    if (!text.trim()) return;
    setThinking(true);
    try {
      const images = useAi ? attachments.map(({ label: _label, ...a }) => a) : [];
      const body = { requestId: crypto.randomUUID(), projectId: project?.id, message: text.trim(), ...(images.length ? { attachments: images } : {}) };
      if (useAi) {
        setMessage(""); setAttachments([]);
        await c.track(body.requestId, "AI 引擎规划", "assistant", () => api<AssistantPlan>("/assistant/ai", body));
      } else { await api<AssistantPlan>("/assistant/plans", body); setMessage(""); }
      await c.refresh();
    }
    catch (error) { c.toast(error instanceof Error ? error.message : String(error), "bad"); await c.refresh(); } finally { setThinking(false); }
  }

  async function execute(plan: AssistantPlan, step: ToolPlan) {
    setRunning(`${plan.id}:${step.id}`);
    try {
      const resolved: Record<string, string> = {};
      for (const x of plan.confirmations) resolved[x.planId] = x.recordId;
      if (step.dependsOn && !resolved[step.dependsOn]) throw new Error(`请先确认前置计划 ${step.dependsOn}`);
      // Server gate before any native tool runs (unreconciled AI runs, missing steps).
      await api(`/assistant/plans/${plan.id}/preflight`, { planId: step.id });
      let projectId = project?.id, revision = project?.revision;
      const projectStep = plan.plans.find(p => ["create-project", "update-requirements"].includes(p.tool));
      if (projectStep && resolved[projectStep.id] && step.id !== projectStep.id) {
        const state = await api<{ projects: Project[] }>("/state");
        const p = state.projects.find(x => x.id === resolved[projectStep.id]);
        if (p) { projectId = p.id; revision = p.revision; }
      }
      if (step.tool !== "create-project" && !projectId) throw new Error("需要先创建任务");
      const route = step.route.replace("{project}", projectId ?? "");
      const payload = JSON.parse(JSON.stringify(step.payload).replace(/"\{(p\d+)\}"/g, (_, id: string) => JSON.stringify(resolved[id] ?? "")));
      if ("projectRevision" in payload && revision) payload.projectRevision = revision;
      if (step.tool === "update-requirements") payload.expectedRevision = revision;
      const body = step.method === "POST" ? { ...payload, requestId: requestIdFor(`pai-plan-${plan.id}-${step.id}`) } : payload;
      const run = () => api<{ id: string; state?: string }>(route, body, step.method);
      const kind = nativeKind[step.tool];
      if (kind) { c.navigate("validate", { kind }); if (window.innerWidth < 1024) onClose(); }
      if (step.tool === "cad-sweep" || step.tool === "cad-optimize") { c.navigate("design", { lane: "cad" }); if (window.innerWidth < 1024) onClose(); }
      const record = kind ? await c.track(body.requestId, step.title, kind, run)
        : step.tool === "cad-sweep" || step.tool === "cad-optimize" ? await c.track(body.requestId, step.title, step.tool, run) : await run();
      await api(`/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: recordKind[step.tool], recordId: record.id });
      if (step.tool === "create-project") { c.selectProject(record.id); c.navigate("overview"); }
      if (kind) c.navigate("validate", { kind, id: record.id });
      if (record.state && !["completed", "done"].includes(record.state) && step.tool !== "model-proposal") throw new Error(`原生任务状态：${record.state}`);
      await c.refresh();
      c.toast(`已执行：${step.title}`);
    } catch (error) { c.toast(error instanceof Error ? error.message : String(error), "bad"); await c.refresh(); }
    finally { setRunning(undefined); }
  }

  return <div className="assistant-inner" id="studio">
    <div className="assistant-head"><div><strong>AI 助手</strong><small>意图 → 类型化计划 → 你确认 → 原生执行</small></div>
      {aiAvailable && <div className="segmented mode" role="group" aria-label="解析方式">{([["ai", "AI 引擎"], ["rules", "规则"]] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={mode === id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{label}</button>)}</div>}
      <button type="button" className="ghost" aria-label="关闭 AI 助手" onClick={onClose}>×</button></div>
    <div className="chat-timeline" ref={timeline} aria-live="polite">
      {plans.length === 0 && <div className="chat-empty"><p>用专业语言描述设计意图。助手把对话解析为可审查的计划，显示每项约束的收紧或放宽；只有你确认后才调用原生工具。它没有验收权。</p>
        <div className="suggestions">{SUGGESTIONS.map(s => <button key={s} type="button" className="suggestion" onClick={() => void send(undefined, s)}>{s}</button>)}</div></div>}
      {plans.map(plan => <div key={plan.id} className="turn">
        <div className="bubble user">{plan.message}</div>
        <div className="bubble reply">
          <EngineMeta plan={plan} />
          {plan.interpretation.map((line, i) => <p key={i} className={line.startsWith("已拒绝") ? "rejected-line" : ""}>{line}</p>)}
          {plan.suggestion && <DeciderNote suggestion={plan.suggestion} triage={plan.triage} />}
          {plan.triage?.skippedModel && <div className="button-row"><button type="button" className="secondary compact" disabled={thinking}
            onClick={() => void c.track(crypto.randomUUID(), "AI 引擎规划", "assistant", () => api<AssistantPlan>("/assistant/ai",
              { requestId: crypto.randomUUID(), projectId: project?.id, message: plan.message, force: true })).then(() => c.refresh())}>仍然询问 AI 引擎</button></div>}
          {plan.answer && <div className="ai-answer"><p>{plan.answer.text}</p>
            {plan.answer.citations.length > 0 ? <div className="citations" role="group" aria-label="引用的记录">{plan.answer.citations.map(x =>
              <button key={x.handle} type="button" className="cite" title={x.label} onClick={() => openCitation(c, x)}>{x.label}</button>)}</div>
              : <small className="no-cite">未引用记录，请自行核实</small>}</div>}
          {plan.source === "model" && (plan.state === "reconcile" || plan.state === "interrupted") && !plan.ai?.reconciliation && <div className="reconcile" role="group" aria-label="核对引擎影响">
            <p className="warning">⚠ 这次运行的引擎原生影响未经核实（{plan.ai?.engine ? PROFILE_NAME[plan.ai.engine.profile] ?? plan.ai.engine.profile : "未返回"}）。核对前不能执行其计划，也不能发起新的 AI 请求；不会自动重试。</p>
            <textarea rows={2} aria-label="核对说明" value={reconcileReason} onChange={e => setReconcileReason(e.target.value)} />
            <button type="button" className="secondary" disabled={c.busy || reconcileReason.trim().length < 10} onClick={() => void c.perform(() =>
              api(`/assistant/plans/${plan.id}/reconciliation`, { reason: reconcileReason }), "已记录核对结果；账本与回执保持不变。")}>记录核对结果</button></div>}
          {plan.ai?.reconciliation && <small className="reconciled">已核对 · {plan.ai.reconciliation.actor} · {plan.ai.reconciliation.reason}
            {plan.ai.reconciliation.settlements?.length ? ` · 执行器账本：${plan.ai.reconciliation.settlements.map(x => x.state === "reconciled" || x.state === "already-reconciled"
              ? `${x.profile} 已结清` : `${x.profile} 未结清（${(x.blockers ?? []).join("、") || x.state}）`).join("；")}` : ""}</small>}
          {plan.plans.map(step => {
            const done = plan.confirmations.find(x => x.planId === step.id), key = `${plan.id}:${step.id}`;
            const changed = step.changes.filter(x => x.direction !== "same");
            return <article key={step.id} className={`plan-card ${done ? "done" : ""}`} aria-label={`计划 ${step.title}`}>
              <header><span className="tool-tag">{toolLabel[step.tool]}</span><strong>{step.title}</strong>{step.dependsOn && <small>依赖 {step.dependsOn}</small>}</header>
              {changed.length > 0 && <ul className="changes">{changed.map(x => <li key={x.field} className={x.direction}><span>{x.field}</span>
                <code>{x.from === null ? "—" : String(x.from)} → {String(x.to)}</code><em>{directionLabel[x.direction]}</em></li>)}</ul>}
              {step.warnings.map(w => <p key={w} className="warning">⚠ {w}</p>)}
              {step.tool === "cad-code" && <details className="code-source"><summary>查看生成的 CadQuery 代码</summary><pre className="code">{(step.payload.source as { code: string }).code}</pre></details>}
              <details><summary>证据与参数</summary><p className="evidence">{step.evidence}</p><pre>{JSON.stringify({ route: `${step.method} /api${step.route}`,
                payload: step.tool === "cad-code" ? { ...step.payload, source: { language: "cadquery-2.8", code: "（见上方代码）" } } : step.payload }, null, 2)}</pre></details>
              <div className="plan-actions">
                {done ? <span className="confirmed">✓ 已执行 · {done.match === "as-proposed" ? "与计划一致" : "执行前经过修改"} · {done.recordId.slice(0, 8)}</span>
                  : <button type="button" disabled={c.busy || running !== undefined} onClick={() => void execute(plan, step)}>{running === key ? "执行中…" : "确认执行"}</button>}
                {!done && step.tool === "scene-review" && <button type="button" className="secondary" onClick={() => {
                  const r = step.payload.requirements as { maxFootprintArea: number; targetEnvelopeRadius: number; requireTargetVisible: boolean };
                  c.navigate("design", { lane: "scene", variant: String(step.payload.variant), area: String(r.maxFootprintArea), radius: String(r.targetEnvelopeRadius), visible: String(r.requireTargetVisible) });
                }}>在专业面板调整</button>}
                {!done && step.tool === "plant-layout" && <button type="button" className="secondary" onClick={() => {
                  const values = { ...(step.payload.layout as Record<string, unknown>), ...(step.payload.requirements as Record<string, unknown>) };
                  c.navigate("design", { lane: "plant", ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) });
                }}>在专业面板调整</button>}
                {!done && step.tool === "cad-review" && <button type="button" className="secondary" onClick={() => {
                  const r = step.payload.requirements as CadRequirementsLike;
                  c.navigate("design", { lane: "cad", variant: String(step.payload.variant), mass: String(r.maxMassG), wall: String(r.minWallMm), edge: String(r.edgeDistanceFactor) });
                }}>在专业面板调整</button>}
                {!done && step.tool === "cad-code" && <button type="button" className="secondary" onClick={() => {
                  sessionStorage.setItem(CAD_DRAFT_KEY, (step.payload.source as { code: string }).code);
                  c.navigate("design", { lane: "cad", variant: "generated" });
                }}>在代码编辑器中修改</button>}
                {!done && step.tool === "factory-criteria" && <button type="button" className="secondary" onClick={() =>
                  c.navigate("requirements", { criteria: JSON.stringify(step.payload.criteria) })}>在专业面板调整</button>}
              </div>
            </article>;
          })}
        </div>
      </div>)}
      {session && (session.running || session.steps.length > 0) && <div className="bubble tool"><LiveSteps session={session} />
        {(session.kind === "blender-scene" || session.kind === "cad-part" || session.kind === "aero-body") && <button type="button" className="link" onClick={() => c.navigate("validate", { kind: session.kind, ...(session.recordId ? { id: session.recordId } : {}) })}>在三维视口查看 →</button>}</div>}
      {thinking && <div className="bubble reply typing" aria-label="解析中"><i /><i /><i /></div>}
    </div>
    <form className="composer" onSubmit={e => void send(e)}>
      <label className="visually-hidden" htmlFor="studio-input">设计意图</label>
      <textarea id="studio-input" ref={input} rows={3} maxLength={2000} value={message} placeholder="描述意图，例如：生成带遮挡的工作单元，占地 ≤ 12 m²"
        onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
      {attachments.length > 0 && <ul className="attachments" aria-label="随问题发送的已记录图像">{attachments.map((a, i) => <li key={`${a.recordId}/${a.which}/${a.file}`}>
        <img src={`/api/${a.recordKind === "cad-review" ? "cad" : a.recordKind === "scene-review" ? "scenes" : "aero"}/${a.recordId}/files/${a.which}/${a.file}`} alt="" />
        <span>{a.label}</span><button type="button" className="ghost" aria-label={`移除附图 ${a.label}`} onClick={() => setAttachments(attachments.filter((_, k) => k !== i))}>×</button></li>)}
        {!useAi && <li className="muted">规则解析不使用附图；切换到 AI 模式才会发送</li>}</ul>}
      <div className="composer-foot"><small>{useAi ? `AI 引擎：${(c.data.capabilities.assistant?.engines ?? []).map(e => PROFILE_NAME[e] ?? e).join(" → ")}` : aiAvailable ? "规则解析 · 不调用模型" : "未配置 AI 引擎 · 规则解析"} · Ctrl/⌘+Enter</small>
        <button type="submit" disabled={thinking || !message.trim()}>生成计划 ↵</button></div>
    </form>
  </div>;
}

const LANE_LABEL: Record<string, string> = { "cad-review": "CAD 零件评审", "cad-code": "生成 CadQuery 代码", "cad-sweep": "设计空间扫描", "cad-optimize": "物理寻优",
  "scene-review": "Blender 工作单元", "plant-layout": "产线布局", "robot-cell": "MuJoCo 机器人工作单元", factory: "工厂维护与能源评审", "aero-body": "气动评审",
  "robot-review": "机器人记录评审", "create-project": "新建任务", "update-requirements": "修改需求", "out-of-scope": "不属于工作台的请求" };
/** Strands Decider: shown only as a hint; the person rephrases or picks the lane. Nothing runs from here. */
function DeciderNote({ suggestion: s, triage }: { suggestion: NonNullable<AssistantPlan["suggestion"]>; triage?: AssistantPlan["triage"] }) {
  if (triage && !triage.skippedModel) return <p className="decider-note" role="note">
    决策模型分诊：{s.lane ? <><strong>{LANE_LABEL[s.lane] ?? s.lane}</strong>（置信 {s.confidence.toFixed(2)}）</> : `不确定（置信 ${s.confidence.toFixed(2)}）`}
    {triage.agreement === true ? " · 与 AI 计划一致" : triage.agreement === false ? " · 与 AI 计划不一致，请核对" : ""}
    {triage.relaxMismatch ? " · 可能在放宽要求，但计划没有放宽项" : ""}<small> · {s.model} · {s.latencyMs} ms</small></p>;
  return <p className="decider-note" role="note">
    {s.lane === "out-of-scope" ? <>决策模型判断这不是工作台能处理的设计请求（置信 {s.confidence.toFixed(2)}）。</>
      : s.lane ? <>决策模型建议：<strong>{LANE_LABEL[s.lane] ?? s.lane}</strong>（置信 {s.confidence.toFixed(2)}）。只是建议，不会执行；请按这个方向补充描述。</>
      : s.withheld === "unknown-option" ? <>决策模型的回答不在可选通道内，已忽略。请补充具体零件、场景或指标。</>
      : <>决策模型也无法判断（置信 {s.confidence.toFixed(2)} &lt; {s.threshold}），请补充具体零件、场景或指标。</>}
    {s.relaxesProbability >= 0.5 && <> 注意：请求可能在放宽要求（{s.relaxesProbability.toFixed(2)}）。</>}
    <small> · {s.model} · {s.latencyMs} ms</small></p>;
}
