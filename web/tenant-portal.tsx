import { useCallback, useEffect, useState } from "react";
import { api, authFetch } from "./api";
import { Card, Chip, Empty } from "./ui";
import { ROUTE_SCENARIOS, YARD_SCENARIOS } from "./views/artifacts";

type Catalog = { tenant: string; quotas: { maxConcurrentRuns: number; maxRunsPerDay: number }; workflows: { id: string; title: string; artifacts: string[] }[] };
type Run = { id: string; workflowId: string; state: string; createdAt: string; error: string | null; nodes: Record<string, { state: string; status: string | null; outputs: string[] }> };
type Usage = { runs: number; native: { wallSeconds: number | null }; billed: false };
const STATE: Record<string, [string, "ok" | "bad" | "warn" | "muted"]> = { running: ["运行中", "warn"], "waiting-approval": ["待你确认", "warn"], succeeded: ["已完成", "ok"],
  rejected: ["已拒绝", "bad"], failed: ["失败", "bad"], interrupted: ["中断", "muted"] };
const time = (iso: string) => new Date(iso).toLocaleString();

/**
 * The browser workspace of an invited tenant member: only the workflows offered to its tenant, its own runs, approval
 * of its own approval nodes, and usage. The server enforces the same scope (src/members.ts); this view never asks for more.
 */
export function TenantPortal({ session }: { session: { tenant: string; email: string; logoutUrl: string | null } }) {
  const [catalog, setCatalog] = useState<Catalog>(), [runs, setRuns] = useState<Run[]>([]), [usage, setUsage] = useState<Usage>();
  const [workflow, setWorkflow] = useState(""), [scenario, setScenario] = useState("normal"), [seed, setSeed] = useState(7);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; bad?: boolean }>();
  const load = useCallback(async () => {
    const [c, r, u] = await Promise.all([api<Catalog>("/v1/tenant/catalog", undefined), api<{ runs: Run[] }>("/v1/tenant/runs", undefined), api<Usage>("/v1/tenant/usage", undefined)]);
    setCatalog(c); setRuns(r.runs); setUsage(u);
  }, []);
  useEffect(() => { void load().catch(e => setMessage({ text: String(e), bad: true })); }, [load]);
  useEffect(() => { if (!runs.some(r => r.state === "running")) return; const t = setTimeout(() => void load(), 3000); return () => clearTimeout(t); }, [runs, load]);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMessage(undefined);
    try { await f(); await load(); setMessage({ text: ok }); } catch (e) { setMessage({ text: String(e instanceof Error ? e.message : e), bad: true }); } finally { setBusy(false); }
  };
  const chosen = catalog?.workflows.find(w => w.id === workflow) ?? catalog?.workflows[0];
  const yard = chosen?.artifacts.some(a => a.startsWith("yard-admission@"));
  const start = () => act(async () => {
    const problem = await api("/v1/tenant/samples", { workflow: chosen!.id, params: { scenario, seed } });
    await api("/v1/tenant/runs", { requestId: crypto.randomUUID(), workflow: chosen!.id, inputs: { problem } });
  }, "已开始运行；结果和确认节点见下方。");
  const decide = (run: Run, node: string, approve: boolean) => {
    const reason = prompt(approve ? "确认理由（记录在运行里，至少 5 个字）" : "拒绝理由（至少 5 个字）")?.trim();
    if (!reason || reason.length < 5) return;
    void act(() => api(`/v1/tenant/runs/${run.id}/decisions`, { node, approve, reason }), approve ? "已确认。" : "已拒绝。");
  };
  return <div className="tenant-portal">
    <header className="topbar">
      <div className="brand-wrap"><span className="brand"><span className="brand-mark">P</span><span>PAI<small>ENGINE · 租户</small></span></span></div>
      <span className="tenant-who">{session.email} · 租户 <strong>{session.tenant}</strong></span>
      {session.logoutUrl && <a className="secondary compact button" href={session.logoutUrl}>退出登录</a>}
    </header>
    <main className="tenant-main">
      <h1>可用流程</h1>
      <p className="muted">这里只有提供给你的租户的流程。结论来自原生求解器和独立核验器，最终是否采用由你确认；示例输入是合成数据。</p>
      {message && <p role="status" className={message.bad ? "bad-text" : "ok-text"}>{message.text}</p>}
      <Card title="运行" label="运行流程" aside={catalog && <small>并发 {catalog.quotas.maxConcurrentRuns} · 每日 {catalog.quotas.maxRunsPerDay} 次</small>}>
        {!catalog ? <p className="muted">加载中…</p> : catalog.workflows.length === 0 ? <Empty title="还没有提供给你的流程">请联系邀请你的管理员。</Empty> : <>
          <div className="field-grid">
            <label>流程<select value={chosen?.id ?? ""} onChange={e => setWorkflow(e.target.value)}>{catalog.workflows.map(w => <option key={w.id} value={w.id}>{w.title}（{w.id}）</option>)}</select></label>
            <label>示例实例<select value={scenario} onChange={e => setScenario(e.target.value)}>{(yard ? YARD_SCENARIOS : ROUTE_SCENARIOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label>种子<input type="number" min={0} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
          </div>
          <div className="button-row"><button type="button" disabled={busy || !chosen} onClick={() => void start()}>用示例实例运行</button></div>
        </>}
      </Card>
      <Card title="我的运行" label="我的运行" aside={usage && <small>{usage.runs} 次 · 原生计算 {usage.native.wallSeconds ?? "未知"} s · 不计费</small>}>
        {runs.length === 0 ? <Empty title="还没有运行" /> : <ul className="tenant-runs">{runs.map(r => {
          const waiting = Object.entries(r.nodes).find(([, n]) => n.state === "waiting-approval")?.[0];
          return <li key={r.id}><div><Chip tone={(STATE[r.state] ?? [r.state, "muted"])[1]}>{(STATE[r.state] ?? [r.state])[0]}</Chip> <strong>{r.workflowId}</strong> · {time(r.createdAt)} · <code>{r.id.slice(0, 6)}</code></div>
            <small className="muted">{Object.entries(r.nodes).map(([id, n]) => `${id}：${n.status ?? n.state}`).join(" · ")}{r.error ? ` · 原因 ${r.error}` : ""}</small>
            {waiting && <div className="button-row"><button type="button" disabled={busy} onClick={() => decide(r, waiting, true)}>确认 {waiting}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => decide(r, waiting, false)}>拒绝</button></div>}</li>;
        })}</ul>}
      </Card>
    </main>
  </div>;
}

/** An authenticated account without a role: nothing is shown, only how to leave. */
export function NoAccess({ logoutUrl }: { logoutUrl: string | null }) {
  return <main className="tenant-main"><h1>没有访问权限</h1><p>这个账号还没有被授予访问权限，或邀请已被撤销。请联系邀请你的管理员。</p>
    {logoutUrl && <a className="button" href={logoutUrl}>退出登录</a>}</main>;
}

export type Session = { role: "maintainer" | "tenant" | "none"; tenant?: string; email?: string; logoutUrl: string | null };
export async function loadSession(): Promise<Session> {
  const r = await authFetch("/api/session");
  return r.ok ? await r.json() as Session : { role: "maintainer", logoutUrl: null };
}
