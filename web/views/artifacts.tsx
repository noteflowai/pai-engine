import { useCallback, useEffect, useState, useRef } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Card, Check, Chip, Empty, ViewHeader, time, type Tone } from "../ui";
import type { ArtifactVersion } from "../../src/artifacts/registry";
import { planningWorkflow, yardWorkflow } from "../../src/artifacts/samples";
import type { Workflow, WorkflowRun } from "../../src/artifacts/workflows";

/** Workspace-level: the artifact registry (algorithms/models) and configurable business workflows over them. */
type Summary = { id: string; title: string; kind: string; state: ArtifactVersion["state"]; digest: string; origin: string; adapter: string; validated: { at: string; passed: boolean } | null };
const STATE: Record<string, [string, Tone]> = { draft: ["草稿", "muted"], validated: ["已验收", "info"], released: ["已发布", "ok"], deprecated: ["已弃用", "warn"] };
const RUN: Record<string, [string, Tone]> = { running: ["运行中", "live"], "waiting-approval": ["待人工确认", "warn"], succeeded: ["完成", "ok"], rejected: ["已拒绝", "bad"],
  failed: ["失败", "bad"], interrupted: ["已中断", "warn"] };
const NODE: Record<string, [string, Tone]> = { pending: ["未执行", "muted"], running: ["运行中", "live"], succeeded: ["完成", "ok"], failed: ["失败", "bad"],
  "waiting-approval": ["待确认", "warn"], rejected: ["拒绝", "bad"], skipped: ["跳过", "muted"] };
const CHECK: Record<string, string> = { "routes-continuous": "路线连续（从车场出发并返回）", "each-order-once": "每单恰好一次", "pickup-before-delivery": "先取后送、同一辆车",
  capacity: "载重不超限", "time-windows": "时间窗与班次", "reported-figures": "里程与成本复算一致", "status-consistent": "状态与计划一致" };
const download = (name: string, value: unknown) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const ADAPTER_LABEL: Record<string, string> = { "logistics-pdptw": "场外物流规划（车辆路径）", "yard-admission": "场地准入与排队调度（CP-SAT）" };
export const ROUTE_SCENARIOS = [["normal", "常规（40 单 / 8 车）"], ["tight", "收窄送货时间窗"], ["overload", "单票超重 9 t"]] as const;
export const YARD_SCENARIOS = [["normal", "常规班次（24 车 / 4 h）"], ["peak", "高峰（40 车 / 90 min）"], ["overload", "含无月台可接的危险品车"]] as const;
export function Artifacts() {
  const c = useApp();
  const [artifacts, setArtifacts] = useState<Summary[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const focus = c.route.params.get("run") ?? undefined;
  const [version, setVersion] = useState("1.0.0");
  const [adapters, setAdapters] = useState<string[]>(["logistics-pdptw"]), [adapter, setAdapter] = useState("logistics-pdptw");
  const [definition, setDefinition] = useState("");
  const [check, setCheck] = useState<{ valid: boolean; message?: string; order?: string[] }>();
  const [verified, setVerified] = useState<{ valid: boolean; artifact?: string; error?: string; message?: string; signer?: { trusted: boolean } }>();
  const [workflowId, setWorkflowId] = useState("");
  const [scenario, setScenario] = useState("normal");
  const [seed, setSeed] = useState(11);
  const load = useCallback(async () => {
    const [a, w, r] = await Promise.all([api<{ artifacts: Summary[]; adapters: string[] }>("/v1/artifacts"), api<Workflow[]>("/v1/workflows"), api<WorkflowRun[]>("/v1/workflow-runs")]);
    setArtifacts(a.artifacts); setAdapters(a.adapters); setWorkflows(w); setRuns(r);
    return a.artifacts;
  }, []);
  useEffect(() => { void load().then(a => {
    const usable = a.find(x => x.state === "released") ?? a.find(x => x.state === "validated") ?? a[0];
    setDefinition(d => d || JSON.stringify(planningWorkflow(usable?.id ?? "logistics-pdptw@1.0.0"), null, 2));
  }).catch(e => c.toast(String(e), "bad")); }, [load]);
  const act = (f: () => Promise<unknown>, message: string) => c.perform(async () => { await f(); await load(); }, message);
  const reason = (label: string) => { const r = prompt(label)?.trim(); if (!r || r.length < 5) { c.toast("需要至少 5 个字的理由。", "bad"); return undefined; } return r; };
  const selected = workflows.find(w => w.id === workflowId) ?? workflows.at(-1);
  const yardRun = Boolean(selected?.definition.nodes.some(n => n.type === "artifact" && (n as { artifact: string }).artifact.startsWith("yard-admission@")));

  return <>
    <ViewHeader step="工作区 · 制品与编排" title="制品库与流程编排"
      description="交付的是可独立核验的制品：算法和模型按不可变版本登记，经自身基准验收、人工发布后才能被流程使用；流程用 JSON 配置，引用精确版本，每个节点记录产物、证据与用量。示例全部是合成数据。" />
    <Card title="制品库" aside={<small>{artifacts.length} 个版本 · 名称@语义版本 · 摘要即身份</small>} label="制品库">
      <div className="field-grid two">
        <label>制品族<select value={adapter} onChange={e => setAdapter(e.target.value)}>{adapters.map(x => <option key={x} value={x}>{ADAPTER_LABEL[x] ?? x}</option>)}</select></label>
        <label>从可信源构建 {adapter} 版本<input value={version} onChange={e => setVersion(e.target.value)} inputMode="decimal" pattern="\d+\.\d+\.\d+" /></label>
        <div className="button-row"><button type="button" disabled={c.busy} onClick={() => void act(() => api("/v1/artifacts", { adapter, version }), "制品版本已登记为草稿。")}>构建草稿</button>
          {artifacts.some(a => a.adapter === adapter && ["validated", "released"].includes(a.state)) && <button type="button" className="secondary"
            onClick={() => { const usable = artifacts.find(a => a.adapter === adapter && a.state === "released") ?? artifacts.find(a => a.adapter === adapter && a.state === "validated")!;
              setDefinition(JSON.stringify(adapter === "yard-admission" ? yardWorkflow(usable.id) : planningWorkflow(usable.id), null, 2)); }}>用该制品的示例流程</button>}</div>
      </div>
      {artifacts.length === 0 ? <Empty title="还没有制品">构建第一个制品：场外物流规划（OR-Tools 车辆路径）或场地准入调度（CP-SAT）。</Empty> :
        <ul className="artifact-list" aria-label="制品版本">{artifacts.map(a => <li key={a.id}>
          <div className="artifact-id"><strong>{a.id}</strong> <Chip tone={STATE[a.state][1]}>{STATE[a.state][0]}</Chip>{a.validated && !a.validated.passed && <Chip tone="bad">基准未通过</Chip>}
            <small>{a.kind === "algorithm" ? "算法" : "模型"} · {a.title}{a.origin === "imported" ? " · 导入" : ""} · <code>{a.digest.slice(0, 12)}</code></small></div>
          <div className="button-row">
            {a.state === "draft" && <button type="button" className="secondary compact" disabled={c.busy} onClick={() => void act(() => api(`/v1/artifacts/${a.id}/validation`, {}), "基准验收完成。")}>运行验收基准</button>}
            {a.state === "validated" && <button type="button" className="secondary compact" disabled={c.busy} onClick={() => { const r = reason("发布理由"); if (r) void act(() => api(`/v1/artifacts/${a.id}/lifecycle`, { to: "released", reason: r }), "已发布。"); }}>发布</button>}
            {(a.state === "validated" || a.state === "released") && <>
              <button type="button" className="secondary compact" disabled={c.busy} onClick={() => void c.perform(async () => download(`pai-artifact-${a.id.replace("@", "-")}.json`, await api(`/v1/artifacts/${a.id}/package`)), "签名制品包已下载。")}>下载签名包</button>
              <button type="button" className="ghost compact" disabled={c.busy} onClick={() => { const r = reason("弃用理由"); if (r) void act(() => api(`/v1/artifacts/${a.id}/lifecycle`, { to: "deprecated", reason: r }), "已弃用；已有流程版本需改用新版本。"); }}>弃用</button></>}
          </div></li>)}</ul>}
      <label className="file">核验或导入签名制品包<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void c.perform(async () => {
        const pkg = JSON.parse(await file.text());
        const key = await api<{ publicKeyPem: string }>("/signing/public-key");
        const r = await api<NonNullable<typeof verified>>("/v1/artifact-packages/verification", { package: pkg, trustedPublicKeyPem: key.publicKeyPem });
        setVerified(r);
        // Only packages signed by this deployment are imported here; another deployment's key is pinned through the API.
        if (r.valid && r.signer?.trusted && confirm(`签名与 ${r.artifact} 的全部文件摘要一致。导入为草稿？（代码和清单须与本版本可信源一致）`)) { await api("/v1/artifact-packages", { package: pkg }); await load(); }
      }, "制品包核验完成。"); e.target.value = ""; }} /></label>
      {verified && <p role="status" className={verified.valid ? "ok-text" : "bad-text"}>{!verified.valid ? `已拒绝（${verified.error}）：${verified.message}` : verified.signer?.trusted ? `签名有效，签名者是本部署：${verified.artifact}` : `签名有效，但签名者不是本部署的密钥（未固定信任）：${verified.artifact}，不在此导入`}</p>}
    </Card>

    <Card title="流程配置" aside={<small>pai-workflow-1 · 节点引用精确版本 · 保存后不可改</small>} label="流程配置">
      <label className="code-editor">流程定义（JSON）<textarea aria-label="流程定义 JSON" value={definition} onChange={e => { setDefinition(e.target.value); setCheck(undefined); }} spellCheck={false} /></label>
      <div className="button-row">
        <button type="button" className="secondary" disabled={c.busy} onClick={() => void c.perform(async () => {
          let body: unknown; try { body = JSON.parse(definition); } catch { setCheck({ valid: false, message: "不是合法 JSON" }); return; }
          setCheck(await api("/v1/workflow-validation", body));
        }, "流程已校验。")}>校验</button>
        <button type="button" disabled={c.busy} onClick={() => void act(async () => { const w = await api<Workflow>("/v1/workflows", JSON.parse(definition)); setWorkflowId(w.id); }, "流程版本已保存。")}>保存流程版本</button>
      </div>
      {check && <p role="status" className={check.valid ? "ok-text" : "bad-text"}>{check.valid ? `结构、类型与依赖检查通过；执行顺序 ${check.order?.join(" → ")}` : `未通过：${check.message}`}</p>}
    </Card>

    <Card title="运行" aside={<small>不自动重试 · 原生用量与模型 Token 分开记录</small>} label="流程运行">
      {workflows.length === 0 ? <Empty title="先保存一个流程版本" /> : <>
        <div className="field-grid">
          <label>流程<select value={selected?.id ?? ""} onChange={e => setWorkflowId(e.target.value)}>{workflows.map(w => <option key={w.id} value={w.id}>{w.id} · {w.definition.title}</option>)}</select></label>
          <label>合成实例<select value={scenario} onChange={e => setScenario(e.target.value)}>{(yardRun ? YARD_SCENARIOS : ROUTE_SCENARIOS).map(([v, l]) =>
            <option key={v} value={v}>{l}</option>)}</select></label>
          <label>种子<input type="number" value={seed} min={0} onChange={e => setSeed(Number(e.target.value))} /></label>
        </div>
        <div className="button-row"><button type="button" disabled={c.busy || !selected} onClick={() => void act(async () => {
          const ref = selected!.definition.nodes.find(n => n.type === "artifact") as { artifact: string } | undefined;
          const problem = await api(`/v1/artifacts/${ref!.artifact}/samples`, { scenario, seed });
          await api("/v1/workflow-runs", { requestId: crypto.randomUUID(), workflow: selected!.id, inputs: { problem } });
        }, "流程已运行，结果见下方。")}>用合成实例运行</button></div>
      </>}
      {runs.map(r => <RunCard key={r.id} run={r} onChange={load} reason={reason} focused={r.id === focus} />)}
    </Card>
    <Tenants workflows={workflows} act={act} reason={reason} />
  </>;
}

type TenantRow = { id: string; maxConcurrentRuns: number; maxRunsPerDay: number; usage: { runs: number; native: { wallSeconds: number | null } } };
type Offer = { id: string; workflowId: string; tenants: string[]; state: "active" | "revoked"; reason: string; createdAt: string };
/** Invite-only tenants (ADR 0002 §5): offer a workflow whose artifacts are all released; revoke; usage only, nothing billed. */
function Tenants({ workflows, act, reason }: { workflows: Workflow[]; act: (f: () => Promise<unknown>, m: string) => Promise<boolean>; reason: (l: string) => string | undefined }) {
  const [tenants, setTenants] = useState<TenantRow[]>([]), [offers, setOffers] = useState<Offer[]>([]);
  const [workflow, setWorkflow] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const load = useCallback(async () => {
    const [t, o] = await Promise.all([api<{ tenants: TenantRow[] }>("/v1/tenants"), api<Offer[]>("/v1/offerings")]);
    setTenants(t.tenants); setOffers(o);
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const run = (f: () => Promise<unknown>, m: string) => act(async () => { await f(); await load(); }, m);
  const chosen = workflow || workflows.at(-1)?.id || "";
  return <Card title="邀请制租户" aside={<small>只提供制品全部已发布的流程 · 只记用量，不收费</small>} label="邀请制租户">
    <Members tenants={tenants} run={run} reason={reason} />
    {tenants.length === 0 ? <Empty title="还没有租户">邀请第一个成员时可以同时新建租户；有 OAuth 客户端的租户来自部署配置（见 DEPLOYMENT.md）。</Empty> : <>
      <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">租户</th><th scope="col">并发 / 日上限</th><th scope="col">运行</th><th scope="col">原生计算</th></tr></thead>
        <tbody>{tenants.map(t => <tr key={t.id}><td>{t.id}</td><td>{t.maxConcurrentRuns} / {t.maxRunsPerDay}</td><td>{t.usage.runs}</td>
          <td>{t.usage.native.wallSeconds === null ? "未知" : `${t.usage.native.wallSeconds} s`}</td></tr>)}</tbody></table></div>
      <div className="field-grid">
        <label>流程<select value={chosen} onChange={e => setWorkflow(e.target.value)}>{workflows.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}</select></label>
        <fieldset><legend>提供给</legend>{tenants.map(t => <label key={t.id} className="inline"><input type="checkbox" checked={picked.includes(t.id)}
          onChange={e => setPicked(p => e.target.checked ? [...p, t.id] : p.filter(x => x !== t.id))} />{t.id}</label>)}</fieldset>
      </div>
      <div className="button-row"><button type="button" disabled={!chosen || picked.length === 0} onClick={() => {
        const r = reason("提供给租户的理由（至少 5 个字）"); if (r) void run(() => api("/v1/offerings", { workflow: chosen, tenants: picked, reason: r }), "已提供给租户。");
      }}>提供流程</button></div>
    </>}
    {offers.length > 0 && <ul className="offers" aria-label="对外提供记录">{offers.map(o => <li key={o.id}>
      <strong>{o.workflowId}</strong> → {o.tenants.join("、")} · {o.state === "active" ? "生效中" : "已撤销"} · {o.reason}
      {o.state === "active" && <button type="button" className="secondary compact" onClick={() => {
        const r = reason("撤销理由（至少 5 个字）"); if (r) void run(() => api(`/v1/offerings/${o.id}/revoke`, { reason: r }), "已撤销。");
      }}>撤销</button>}</li>)}</ul>}
  </Card>;
}

type Member = { id: string; tenant: string; email: string; state: "inviting" | "invited" | "active" | "revoked" | "failed"; invitedAt: string; lastSeenAt: string | null; invitations: number; error: string | null };
const MEMBER: Record<Member["state"], [string, "ok" | "warn" | "bad" | "muted"]> = { inviting: ["发送中", "warn"], invited: ["已邀请，未登录", "warn"], active: ["已登录", "ok"], revoked: ["已撤销", "muted"], failed: ["邀请失败", "bad"] };
/**
 * Invite a person by e-mail to a tenant (new or existing). Cognito e-mails the login address, the username and a
 * temporary password; the first sign-in sets a new one. Revoking ends access on the next request.
 */
function Members({ tenants, run, reason }: { tenants: TenantRow[]; run: (f: () => Promise<unknown>, m: string) => Promise<boolean>; reason: (l: string) => string | undefined }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState(""), [tenant, setTenant] = useState(""), [fresh, setFresh] = useState(""), [conc, setConc] = useState(2), [daily, setDaily] = useState(50);
  const load = useCallback(async () => setMembers((await api<{ members: Member[] }>("/v1/tenant-members", undefined)).members), []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const act = (f: () => Promise<unknown>, m: string) => run(async () => { await f(); await load(); }, m);
  const target = tenant || tenants[0]?.id || "__new";
  const creating = target === "__new";
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && (!creating || /^[a-z][a-z0-9-]{1,39}$/.test(fresh));
  return <section aria-label="租户成员" className="members">
    <h3>邀请成员</h3>
    <div className="field-grid">
      <label>邮箱<input type="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" /></label>
      <label>租户<select value={target} onChange={e => setTenant(e.target.value)}>{tenants.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}<option value="__new">＋ 新建租户…</option></select></label>
      {creating && <><label>新租户编号<input value={fresh} onChange={e => setFresh(e.target.value.toLowerCase())} placeholder="例如 acme" aria-describedby="tenant-id-hint" /></label>
        <label>并发上限<input type="number" min={1} max={20} value={conc} onChange={e => setConc(Number(e.target.value))} /></label>
        <label>每日上限<input type="number" min={1} max={1000} value={daily} onChange={e => setDaily(Number(e.target.value))} /></label></>}
    </div>
    {creating && <small id="tenant-id-hint" className="muted">小写字母开头，2–40 位字母、数字或连字符。</small>}
    <div className="button-row"><button type="button" disabled={!valid} onClick={() => {
      const r = reason("邀请理由（记录在审计里，至少 5 个字）");
      if (r) void act(async () => { await api("/v1/tenant-members", { email: email.trim(), tenant: creating ? fresh : target, ...(creating ? { newTenant: { maxConcurrentRuns: conc, maxRunsPerDay: daily } } : {}), reason: r }); setEmail(""); setFresh(""); },
        "邀请已发送：对方会收到登录地址、用户名和临时密码，首次登录需设置新密码。");
    }}>发送邀请</button></div>
    {members.length > 0 && <div className="table-wrap"><table className="data-table"><caption className="visually-hidden">租户成员</caption>
      <thead><tr><th scope="col">邮箱</th><th scope="col">租户</th><th scope="col">状态</th><th scope="col">最近访问</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
      <tbody>{members.map(m => <tr key={m.id}><td>{m.email}</td><td>{m.tenant}</td><td><Chip tone={MEMBER[m.state][1]}>{MEMBER[m.state][0]}</Chip>{m.error && <small className="bad-text"> {m.error}</small>}</td>
        <td>{m.lastSeenAt ? time(m.lastSeenAt) : "—"}</td>
        <td className="button-row">{m.state === "invited" && <button type="button" className="secondary compact" onClick={() => void act(() => api(`/v1/tenant-members/${m.id}/invitation`, {}), "邀请已重新发送。")}>重发邀请</button>}
          {(m.state === "invited" || m.state === "active") && <button type="button" className="secondary compact" onClick={() => {
            const r = reason(`撤销 ${m.email} 的访问（理由至少 5 个字）`); if (r) void act(() => api(`/v1/tenant-members/${m.id}/revoke`, { reason: r }), "已撤销：对方下一次请求即被拒绝。");
          }}>撤销</button>}</td></tr>)}</tbody></table></div>}
  </section>;
}

type YardPlan = { status: string; plan: { truck: string; admitted: boolean; entry?: number; dock?: string; handleStart?: number; departure?: number }[];
  totals: { admitted: number; turnedAway: string[]; priorityAdmitted: number; waitingMin: number }; solver: { proven?: boolean } };
/** Site admission result: who enters when and at which dock; turned-away trucks are listed, never dropped silently. */
function YardSummary({ plan }: { plan: YardPlan }) {
  const hhmm = (m?: number) => m === undefined ? "—" : `${String(Math.floor(m / 60) + 6).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const rows = plan.plan.filter(r => r.admitted).sort((a, b) => a.entry! - b.entry!);
  return <div className="yard-summary">
    <p className="muted">入场 {plan.totals.admitted} 辆 · 优先级分 {plan.totals.priorityAdmitted} · 总等待 {plan.totals.waitingMin} min
      {plan.totals.turnedAway.length ? ` · 本时段不安排 ${plan.totals.turnedAway.length} 辆（${plan.totals.turnedAway.slice(0, 8).join("、")}${plan.totals.turnedAway.length > 8 ? "…" : ""}）` : ""}
      {plan.solver.proven ? " · 已证明最优" : " · 预算内最好解（未证明最优）"}</p>
    <div className="table-wrap"><table className="data-table"><caption className="visually-hidden">入场安排</caption>
      <thead><tr><th scope="col">车辆</th><th scope="col">入场</th><th scope="col">月台</th><th scope="col">开始作业</th><th scope="col">离场</th></tr></thead>
      <tbody>{rows.slice(0, 12).map(r => <tr key={r.truck}><td>{r.truck}</td><td>{hhmm(r.entry)}</td><td>{r.dock}</td><td>{hhmm(r.handleStart)}</td><td>{hhmm(r.departure)}</td></tr>)}</tbody></table></div>
    {rows.length > 12 && <small className="muted">另有 {rows.length - 12} 辆，见运行数据。</small>}
  </div>;
}
function RunCard({ run, onChange, reason, focused }: { run: WorkflowRun; onChange: () => Promise<unknown>; reason: (l: string) => string | undefined; focused?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Opened from the task switcher (#/artifacts?run=<id>): expand and bring it into view.
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [focused]);
  const [yard, setYard] = useState<YardPlan>();
  const c = useApp();
  const [plan, setPlan] = useState<{ status: string; totalDistanceKm: number; totalCost: number; vehiclesUsed: number; unassigned: string[]; routes: { vehicle: string; stops: unknown[]; distanceKm: number }[] }>();
  const [checks, setChecks] = useState<{ id: string; passed: boolean; detail?: string[] }[]>();
  useEffect(() => {
    if (run.nodes.schedule?.outputs?.plan) void api<YardPlan>(`/v1/workflow-runs/${run.id}/data?node=schedule&name=plan`).then(setYard).catch(() => undefined);
    if (!run.nodes.solve?.outputs?.plan) return;
    void api<NonNullable<typeof plan>>(`/v1/workflow-runs/${run.id}/data?node=solve&name=plan`).then(setPlan).catch(() => undefined);
    if (run.nodes.verify?.outputs?.verification) void api<{ checks: NonNullable<typeof checks> }>(`/v1/workflow-runs/${run.id}/data?node=verify&name=verification`).then(v => setChecks(v.checks)).catch(() => undefined);
  }, [run.id, run.revision]);
  const waiting = Object.entries(run.nodes).find(([, n]) => n.state === "waiting-approval")?.[0];
  return <details ref={ref} id={`run-${run.id}`} className={`receipts run-detail${focused ? " focused" : ""}`} open={focused || run.state === "waiting-approval"}>
    <summary><Chip tone={RUN[run.state][1]}>{RUN[run.state][0]}</Chip> {run.workflowId} · {time(run.createdAt)}{plan && ` · ${plan.status}${typeof plan.totalDistanceKm === "number" ? ` · ${plan.totalDistanceKm} km` : ""}`}</summary>
    {run.error && <p className="bad-text">原因：{run.error}</p>}
    <div className="table-wrap"><table className="data-table nodes"><caption className="visually-hidden">节点</caption>
      <thead><tr><th scope="col">节点</th><th scope="col">状态</th><th scope="col">结果</th><th scope="col">墙钟 / CPU s</th><th scope="col">存储</th><th scope="col">模型 Token</th></tr></thead>
      <tbody>{Object.entries(run.nodes).map(([id, n]) => <tr key={id}><th scope="row">{id}</th><td><Chip tone={NODE[n.state][1]}>{NODE[n.state][0]}</Chip></td><td>{n.status ?? "—"}{n.error && <><br /><small className="bad-text">{n.error}</small></>}</td>
        <td>{n.usage ? `${n.usage.native.wallSeconds} / ${n.usage.native.cpuSeconds ?? "unknown"}` : "—"}</td><td>{n.usage ? `${(n.usage.native.storageBytes / 1024).toFixed(1)} KB` : "—"}</td>
        <td>{n.usage ? n.usage.model.status === "none" ? "无模型调用" : n.usage.model.status === "unknown" ? "unknown" : `${n.usage.model.inputTokens} / ${n.usage.model.outputTokens}` : "—"}</td></tr>)}</tbody></table></div>
    {checks && <ul className="checks" aria-label="独立核验">{checks.map(k => <Check key={k.id} passed={k.passed} title={CHECK[k.id] ?? k.id} detail={k.detail?.length ? k.detail.slice(0, 3).join("；") : "独立复算一致"} />)}</ul>}
    {yard && <YardSummary plan={yard} />}
    {plan && plan.routes.length > 0 && <p className="muted">{plan.vehiclesUsed} 辆车 · 成本 {plan.totalCost}{plan.unassigned.length ? ` · ${plan.unassigned.length} 单未分配` : ""} · {plan.routes.map(r => `${r.vehicle} ${r.stops.length} 站 ${r.distanceKm} km`).join("；")}</p>}
    {waiting && <div className="button-row">
      <button type="button" disabled={c.busy} onClick={() => { const r = reason("确认理由（记录在运行里）"); if (r) void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/decisions`, { node: waiting, approve: true, reason: r }); await onChange(); }, "已确认，流程继续。"); }}>确认 {waiting}</button>
      <button type="button" className="secondary" disabled={c.busy} onClick={() => { const r = reason("拒绝理由"); if (r) void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/decisions`, { node: waiting, approve: false, reason: r }); await onChange(); }, "已拒绝，流程结束。"); }}>拒绝</button>
    </div>}
    {run.state === "interrupted" && <button type="button" className="secondary" onClick={() => void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/resume`, {}); await onChange(); }, "已恢复（仅无外部副作用的节点）。")}>恢复</button>}
  </details>;
}
