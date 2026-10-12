import { TWIN } from "../twin-evidence";
import { useApp, VIEWS } from "../context";
import { Card, Chip, Empty, ViewHeader, time, type Tone } from "../ui";
import type { Outcome, TrackRecord } from "../../src/track-record";
import { AutonomyCard } from "./autonomy";

const OUTCOME: Record<Outcome, [string, Tone]> = { accepted: ["通过", "ok"], rejected: ["被否决", "bad"], inconclusive: ["证据不足", "warn"], running: ["运行中", "live"], failed: ["未完成", "muted"], applied: ["已应用", "info"] };
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How the AI's executed proposals fared with the native solvers: measured, never self-reported. */
function AiTrackRecord({ record, open }: { record: TrackRecord; open: (kind: string, id: string) => void }) {
  if (!record.agents.length) return <Card title="AI 战绩"><p className="muted">还没有 AI 提案被执行。AI 的每个提案执行后，这里记录求解器的判定、人工修改和估算误差。</p></Card>;
  return <Card title="AI 战绩" aside={<small>求解器判定，不是自评</small>}>
    <div className="track-agents">{record.agents.map(a => <section key={a.agent} aria-label={`AI ${a.agent}`}>
      <h3>{a.agent}</h3>
      <dl className="track-stats">
        <div><dt>通过率</dt><dd>{a.acceptanceRate === null ? "—" : pct(a.acceptanceRate)}</dd></div>
        <div><dt>已执行 / 提案</dt><dd>{a.executed} / {a.proposals}</dd></div>
        <div><dt>通过 · 否决</dt><dd>{a.outcomes.accepted} · {a.outcomes.rejected}</dd></div>
        <div><dt>授权内自主</dt><dd>{a.underGrant}</dd></div>
        <div><dt>执行前被人修改</dt><dd>{a.editedBeforeRun}</dd></div>
        <div><dt>试图放宽需求</dt><dd>{a.relaxationsProposed}</dd></div>
        {a.estimates && <div><dt>物理估算误差</dt><dd>{pct(a.estimates.meanAbsRelativeError)}（{a.estimates.bias < 0 ? "偏低" : "偏高"} {pct(Math.abs(a.estimates.bias))}，{a.estimates.n} 点）</dd></div>}
      </dl></section>)}</div>
    {record.recent.length > 0 && <ol className="track-recent" aria-label="最近执行的 AI 提案">{record.recent.map(r => <li key={r.recordId + r.at}>
      <Chip tone={OUTCOME[r.outcome][1]}>{OUTCOME[r.outcome][0]}</Chip>
      <button type="button" className="link" onClick={() => open(r.recordKind, r.recordId)}>{r.tool}</button>
      {r.failed?.length ? <small>未通过：{r.failed.join("、")}</small> : null}<time dateTime={r.at}>{time(r.at)}</time></li>)}</ol>}
    <p className="muted">这份记录也会交给 AI：它能看到自己哪些提案被否决、估算偏差多少，下一次提案时据此修正。</p>
  </Card>;
}

const STATUS_TONE: Record<string, [string, Tone]> = { done: ["完成", "ok"], attention: ["需处理", "warn"], active: ["运行中", "live"], pending: ["未开始", "muted"] };

export function Overview() {
  const c = useApp();
  const { project, lifecycle: l } = c;
  if (!project || !l) return <>
    <ViewHeader step="项目总览" title="让设计决策有证据" description="从冻结需求到原生验证、失败回放、反馈复测和可核验交付，每一步都绑定证据。" />
    <section className="decision-banner card" aria-label="决策算法与孪生">
      <div><p className="eyebrow">决策平台</p><h2>决策算法与物理 AI 孪生</h2><p>场地准入、车辆路径等决策算法：孪生里传感器触发重排，CP-SAT 比先到先服务多接 {TWIN.cpSat.admitted - TWIN.fcfs.admitted} 辆车、平均在场 {TWIN.fcfs.avgTurnaroundMin} → {TWIN.cpSat.avgTurnaroundMin} min。</p></div>
      <button type="button" className="secondary" onClick={() => c.navigate("artifacts")}>打开 →</button>
    </section>
    <Empty title="还没有评审任务" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>}>
      先冻结验收需求。之后可以在“候选设计”中提交机器人记录、Blender 场景或工厂孪生候选，或在 AI 助手中描述意图。</Empty>
  </>;
  const go = () => {
    const ref = l.next.ref;
    if (ref?.kind === "feedback") c.navigate("feedback", { id: ref.id });
    else if (ref?.kind === "release") c.navigate("deliver");
    else if (ref && ["robot-review", "blender-scene", "factory-twin"].includes(ref.kind)) c.navigate(l.next.stage, { kind: ref.kind, id: ref.id });
    else c.navigate(l.next.stage);
  };
  return <>
    <ViewHeader step="项目总览" title={project.title} description={project.intendedDecision}
      actions={<><Chip tone="info">需求 v{project.revision}</Chip><Chip>SHA-256 {l.requirementDigest.slice(0, 10)}</Chip></>} />
    <section className="decision-banner card" aria-label="决策算法与孪生">
      <div><p className="eyebrow">决策平台</p><h2>决策算法与物理 AI 孪生</h2><p>场地准入、车辆路径等决策算法：孪生里传感器触发重排，CP-SAT 比先到先服务多接 {TWIN.cpSat.admitted - TWIN.fcfs.admitted} 辆车、平均在场 {TWIN.fcfs.avgTurnaroundMin} → {TWIN.cpSat.avgTurnaroundMin} min。</p></div>
      <button type="button" className="secondary" onClick={() => c.navigate("artifacts")}>打开 →</button>
    </section>
    <section className="next-step" aria-label="下一步">
      <div><p className="eyebrow">下一步 · {VIEWS.find(v => v.id === l.next.stage)?.label}</p><h2>{l.next.label}</h2><p>{l.next.detail}</p></div>
      <button type="button" onClick={go}>前往 →</button>
    </section>
    <section className="loop" aria-label="全生命周期闭环">
      <ol>{l.stages.map(s => {
        const [label, tone] = STATUS_TONE[s.status];
        return <li key={s.id} className={`stage ${s.status}`}>
          <button type="button" onClick={() => c.navigate(s.id)} aria-label={`${s.index} ${s.label}：${label}，${s.metric}`}>
            <span className="stage-index">{s.index}</span><strong>{s.label}</strong><Chip tone={tone}>{label}</Chip>
            <span className="stage-metric">{s.metric}</span><small>{s.detail}</small></button></li>;
      })}</ol>
      <div className="loop-returns" aria-hidden="true"><span className="ret r1">反馈 → 新复测 → 原生验证</span><span className="ret r2">试用反馈 → 反馈复测</span></div>
    </section>
    {c.data.aiTrackRecords?.[project.id] && <AiTrackRecord record={c.data.aiTrackRecords[project.id]}
      open={(kind, id) => {
        const evidence = ({ "cad-review": "cad-part", "scene-review": "blender-scene", review: "robot-review", "aero-review": "aero-body", "factory-review": "factory-twin" } as Record<string, string>)[kind];
        if (evidence) c.navigate("validate", { kind: evidence, id }); else c.navigate("design");
      }} />}
    <AutonomyCard />
    <div className="split">
      <Card title="最近活动" aside={<small>{l.activity.length} 条</small>}>
        <ol className="activity">{l.activity.slice(0, 12).map((a, i) => <li key={i}>
          <time dateTime={a.at}>{time(a.at)}</time>
          <div><button type="button" className="link" onClick={() => a.ref?.kind === "feedback" ? c.navigate("feedback", { id: a.ref.id }) : a.ref?.kind === "release" ? c.navigate("deliver")
            : a.ref && ["robot-review", "blender-scene", "factory-twin"].includes(a.ref.kind) ? c.navigate("validate", { kind: a.ref.kind, id: a.ref.id }) : c.navigate(a.stage)}>{a.label}</button>
            {a.detail && <p>{a.detail}</p>}</div></li>)}</ol>
      </Card>
      <Card title="证据范围">
        <ul className="scope-list">
          <li><strong>机器人记录评审</strong>30 条真实历史记录、1 个任务、10 个配对种子；不执行新的策略推理。</li>
          <li><strong>Blender 场景</strong>合成静态几何的原生射线与投影检查；不代表关节可达性或动力学。</li>
          <li><strong>工厂孪生</strong>Robot Reel v0.18.0 演示仿真；参数未按真实工厂校准。</li>
          <li><strong>AI 助手</strong>提出计划，可在维护者签发的授权内自主执行原生求解；不能放宽需求、验收、发布或关闭反馈。</li>
          <li><strong>发布</strong>维护者批准的发布候选只表示在上述证据范围内采用此设计决策，不代表物理验证或量产放行。</li>
        </ul>
        <p className="muted">尚未进行现场验证。独立试用者 {c.data.metrics.independentParticipants} 人（自报）；维护者与自动测试分开计量。</p>
      </Card>
    </div>
  </>;
}
