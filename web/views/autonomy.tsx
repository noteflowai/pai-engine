import { useEffect, useState } from "react";
import { api, authFetch } from "../api";
import { useApp } from "../context";
import { Card, Chip, time, type Tone } from "../ui";
import type { AutonomyGrant } from "../../src/autonomy";
import type { Autopilot } from "../../src/autopilot";

/** Native lanes a maintainer may delegate (each only measures; none changes requirements, approves or releases). */
const TOOLS: [AutonomyGrant["tools"][number], string][] = [["cad-review", "CAD 零件评审"], ["cad-code", "AI 写 CadQuery 代码"],
  ["cad-optimize", "物理寻优"], ["robot-cell", "MuJoCo 工作单元"], ["plant-layout", "Blender 产线布局"], ["aero-body", "OpenFOAM 气动"]];
const LABEL = Object.fromEntries(TOOLS);
const OUTCOME: Record<string, [string, Tone]> = { "goal-met": ["目标达成", "ok"], "rounds-exhausted": ["轮数用完", "warn"], "grant-exhausted": ["授权用完", "warn"],
  "no-runnable-plan": ["AI 没有给出可执行计划", "warn"], "needs-human": ["需要人工处理", "warn"], running: ["运行中", "live"], failed: ["失败", "bad"], interrupted: ["中断", "bad"] };
const active = (g: AutonomyGrant) => !g.revokedAt && Date.parse(g.expiresAt) > Date.now() && g.runs.length < g.maxRuns;

/**
 * Bounded autonomy in the product: the maintainer issues a grant (tools, runs, hours), then lets the AI iterate
 * "propose → native check → revise" on its own. Verdicts stay with the solvers; release and feedback stay human.
 */
const SCREEN: Record<string, string> = { "likely-pass": "预测可过", unknown: "无法预测", "likely-fail": "预测不过", "geometry-fail": "几何不过" };
export function AutonomyCard() {
  const c = useApp();
  const project = c.project!;
  const grants = (c.data.autonomyGrants ?? []).filter(g => g.projectId === project.id);
  const live = grants.filter(active);
  const runs = (c.data.autopilots ?? []).filter(a => a.projectId === project.id);
  const [tools, setTools] = useState<string[]>(["cad-review", "cad-code"]);
  const [maxRuns, setMaxRuns] = useState(3), [hours, setHours] = useState(8);
  const [goal, setGoal] = useState(""), [rounds, setRounds] = useState(3);
  const [current, setCurrent] = useState<Autopilot>();
  const model = c.data.capabilities.assistant?.modelInvocation === true;
  const latest = current && current.projectId === project.id ? current : runs.at(-1);

  // Follow a running autopilot by its durable record (rounds are saved as they finish).
  useEffect(() => {
    if (latest?.state !== "running") return;
    const t = setInterval(() => { void api<Autopilot>(`/autopilots/${latest.id}`, undefined, "GET").then(a => {
      setCurrent(a); if (a.state !== "running") void c.refresh();
    }).catch(() => undefined); }, 4000);
    return () => clearInterval(t);
  }, [latest?.id, latest?.state]);

  const issue = () => c.perform(() => api(`/projects/${project.id}/autonomy-grants`, { tools, maxRuns, hours }), "授权已签发：AI 可以在范围内自主运行原生求解。");
  const revoke = (id: string) => c.perform(() => api(`/autonomy-grants/${id}/revoke`, {}), "授权已撤销，之后不会再自主运行。");
  const start = async () => {
    const grant = live.at(-1)!;
    // Start, then follow the record; do not hold the UI for the whole run.
    const r = await authFetch(`/api/projects/${project.id}/autopilot`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), grantId: grant.id, goal: goal.trim(), maxRounds: rounds }) });
    const data = await r.json();
    if (r.status !== 202 && !r.ok) { c.toast(`${data.error}: ${data.message ?? "请求被拒绝"}`, "bad"); return; }
    const location = r.headers.get("Location");
    const record = r.status === 202 && location ? await (await authFetch(location)).json() as Autopilot : data as Autopilot;
    setCurrent(record); c.toast("AI 已开始自主迭代；每一轮的原生结论会在这里出现。"); void c.refresh();
  };

  // A round that stopped for a human (the executor could not verify an engine's effects): the maintainer checks the
  // receipt, records why it is safe, then runs the proposed step under the same grant. The ledger is never touched.
  const paused = latest?.outcome === "needs-human" ? latest.rounds.find(r => r.planId && !r.recordId) : undefined;
  const pausedPlan = paused ? (c.data.assistantPlans ?? []).find(p => p.id === paused.planId) : undefined;
  const pausedStep = pausedPlan?.plans.find(p => (live.at(-1)?.tools as string[] | undefined)?.includes(p.tool));
  const ranPaused = pausedPlan?.confirmations.some(x => x.planId === pausedStep?.id);
  const [why, setWhy] = useState("");
  const resume = () => c.perform(async () => {
    if (!pausedPlan!.ai?.reconciliation) await api(`/assistant/plans/${pausedPlan!.id}/reconciliation`, { reason: why.trim() });
    const r = await api<{ recordKind: string; recordId: string }>(`/assistant/plans/${pausedPlan!.id}/autonomous-runs`, { grantId: live.at(-1)!.id, step: pausedStep!.id });
    const at = ({ "cad-review": ["cad", "cad-part"], "scene-review": ["scenes", "blender-scene"], "aero-review": ["aero", "aero-body"], "cad-optimize": ["cad-optimizations", ""] } as Record<string, [string, string]>)[r.recordKind];
    if (at?.[1]) c.navigate("validate", { kind: at[1], id: r.recordId });
    // The run continues on the server; follow its durable record (bounded) so the result appears without a reload.
    for (let i = 0; at && i < 600; i++) {
      const rec = await api<{ state: string }>(`/${at[0]}/${r.recordId}`, undefined, "GET").catch(() => undefined);
      if (rec && rec.state !== "running") break;
      await new Promise(done => setTimeout(done, 3000));
    }
  }, "已记录核对理由，并在授权内执行了 AI 的提案；结论由原生检查给出。");

  return <Card title="AI 自主迭代" aside={<small>维护者授权 · 求解器裁决</small>} label="AI 自主迭代">
    <p className="muted">签发授权后，AI 在限定的工具、次数和时间内自己“提议 → 原生检查 → 修改”，外部 Agent 也可以经 MCP 在同一授权内执行。它不能放宽需求、验收、发布或关闭反馈；放宽需求的步骤一律要人确认。</p>
    {live.length > 0 ? <ul className="grant-list" aria-label="有效授权">{live.map(g => <li key={g.id}>
      <div><strong>{g.tools.map(t => LABEL[t] ?? t).join("、")}</strong>
        <small>已用 {g.runs.length} / {g.maxRuns} 次 · 到期 {time(g.expiresAt)}{g.note ? ` · ${g.note}` : ""}</small></div>
      <button type="button" className="secondary" disabled={c.busy} onClick={() => void revoke(g.id)}>撤销</button></li>)}</ul>
    : <fieldset className="grant-form"><legend>签发授权</legend>
      <div className="tool-choices">{TOOLS.map(([id, label]) => <label key={id} className="check">
        <input type="checkbox" checked={tools.includes(id)} onChange={e => setTools(e.target.checked ? [...tools, id] : tools.filter(t => t !== id))} />{label}</label>)}</div>
      <div className="field-grid">
        <label>最多运行次数<input type="number" min={1} max={20} value={maxRuns} onChange={e => setMaxRuns(Number(e.target.value))} /></label>
        <label>有效期（小时）<input type="number" min={0.25} max={72} step={0.25} value={hours} onChange={e => setHours(Number(e.target.value))} /></label>
      </div>
      <button type="button" disabled={c.busy || !tools.length || maxRuns < 1 || maxRuns > 20} onClick={() => void issue()}>签发授权</button>
    </fieldset>}
    {live.length > 0 && <div className="autopilot-form">
      <label>目标<textarea rows={2} value={goal} placeholder="例如：在不放宽任何要求的前提下修正地脚孔边距，质量不超过上限"
        onChange={e => setGoal(e.target.value)} /></label>
      <div className="button-row">
        <label className="inline">最多轮数<input type="number" min={1} max={6} value={rounds} onChange={e => setRounds(Number(e.target.value))} /></label>
        <button type="button" disabled={!model || goal.trim().length < 10 || latest?.state === "running"} onClick={() => void start().catch(e => c.toast(String(e), "bad"))}>让 AI 自主迭代</button>
      </div>
      {!model && <small>本机没有配置模型执行器；外部 Agent 仍可经 MCP（pai_run_plan）使用这份授权。</small>}
    </div>}
    {latest && <section className="autopilot-run" aria-label="最近一次自主迭代">
      <header><Chip tone={OUTCOME[latest.outcome ?? latest.state]?.[1] ?? "muted"}>{OUTCOME[latest.outcome ?? latest.state]?.[0] ?? latest.state}</Chip>
        <span>{latest.goal}</span></header>
      <ol>{latest.rounds.map(r => <li key={r.round}>
        <strong>第 {r.round} 轮</strong>{r.tool && <span>{LABEL[r.tool] ?? r.tool}</span>}
        {r.verdict && (() => { const ok = r.verdict.startsWith("accepted") || r.verdict === "feasible-point-found";
          return <Chip tone={ok ? "ok" : r.verdict === "rejected" ? "bad" : "warn"}>{ok ? "原生检查通过" : r.verdict === "rejected" ? "原生检查拒绝" : "证据不足"}</Chip>; })()}
        {r.failing?.length ? <small>未通过：{r.failing.map(f => f.id).join("、")}</small> : null}
        {r.note && <small>{r.note}</small>}
        {r.screening && <details className="screening"><summary>代理模型筛选 {r.screening.variants.length} 个代码变体，只送 1 个做原生评审</summary>
          <ul>{r.screening.variants.map(v => <li key={v.stepId}><Chip tone={v.chosen ? "ok" : v.class === "geometry-fail" || v.class === "likely-fail" ? "bad" : "muted"}>
            {v.chosen ? "已选" : SCREEN[v.class]}</Chip> <code>{v.codeSha256.slice(0, 8)}</code>
            {v.geometry.ok ? ` · B-Rep ${v.geometry.massG?.toFixed(1)} g${v.geometry.failed?.length ? ` · 未通过 ${v.geometry.failed.join("、")}` : ""}` : ` · ${v.geometry.reason ?? "沙箱未产生实体"}`}
            {v.prediction && ` · 预测挠度 ≤ ${v.prediction.upper.deflectionMm.toFixed(4)} mm、应力 ≤ ${v.prediction.upper.stressMPa.toFixed(1)} MPa${v.prediction.inDomain ? "" : "（域外）"}`}</li>)}</ul>
          <small>{r.screening.surrogate} · 权限：无；排序用 90 % 区间上界，结论只来自所选变体的 CalculiX 实测。</small></details>}
        {r.recordKind === "cad-review" && r.recordId && <button type="button" className="link" onClick={() => c.navigate("validate", { kind: "cad-part", id: r.recordId! })}>查看结果</button>}
      </li>)}{latest.state === "running" && <li><Chip tone="live">运行中</Chip><small>AI 正在提议或原生求解器正在运行…</small></li>}</ol>
      {pausedPlan && pausedStep && !ranPaused && live.length > 0 && <div className="reconcile" role="group" aria-label="核对后继续">
        <p>执行器无法自动确认这次模型调用没有副作用，所以停下来等人核对。提案：<strong>{pausedStep.title}</strong>
          {pausedPlan.answer?.text ? <small>{pausedPlan.answer.text.slice(0, 220)}</small> : null}</p>
        {pausedPlan.ai?.reconciliation ? <small>已核对 · {pausedPlan.ai.reconciliation.reason}</small>
          : <label>核对理由<input value={why} onChange={e => setWhy(e.target.value)} placeholder="例如：回执显示没有工具活动，只读模式" /></label>}
        <button type="button" disabled={c.busy || (!pausedPlan.ai?.reconciliation && why.trim().length < 10)} onClick={() => void resume()}>记录核对并在授权内执行</button>
      </div>}
    </section>}
  </Card>;
}
