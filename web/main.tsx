import { useCallback, useEffect, useMemo, useRef, useState } from "react";
type Theme = "system" | "light" | "dark";
const THEME_LABEL: Record<Theme, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
const nextTheme = (t: Theme): Theme => t === "system" ? "light" : t === "light" ? "dark" : "system";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { AppContext, VIEWS, type Ctx, type Route, type State, type ViewId, type Attachment } from "./context";
import { revealInScroller, Toasts } from "./ui";
import { Assistant, useLiveSession } from "./studio";
import { ProjectSwitcher, rememberProject, type RunSummary } from "./project-switcher";
import { Palette, type Command } from "./palette";
import { Overview } from "./views/overview";
import { Requirements } from "./views/requirements";
import { Design } from "./views/design";
import { Validate } from "./views/validate";
import { Evidence } from "./views/evidence";
import { FeedbackView } from "./views/feedback";
import { Deliver } from "./views/deliver";
import { Artifacts } from "./views/artifacts";
import { loadSession, NoAccess, TenantPortal, type Session } from "./tenant-portal";
import { runScene } from "./actions";
import { MATURITY } from "./context";
import "./style.css";

function parseRoute(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  // Landing page: the decision platform (decision algorithms and twins) comes first.
  const view = (VIEWS.some(v => v.id === path) ? path : "artifacts") as ViewId;
  return { view, params: new URLSearchParams(query) };
}
const DOT: Record<string, string> = { done: "完成", attention: "需处理", active: "运行中", pending: "未开始" };

function App() {
  const [data, setData] = useState<State>();
  const [loadError, setLoadError] = useState("");
  const [projectId, setProjectId] = useState(() => localStorage.getItem("pai-project") ?? "");
  const [route, setRoute] = useState<Route>(parseRoute);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: "ok" | "bad" }[]>([]);
  // Docked on wide screens; on phones it is a full-screen sheet that always starts closed.
  const [assistant, setAssistant] = useState(() => { if (innerWidth < 1024) return false; const saved = localStorage.getItem("pai-assistant"); return saved ? saved === "open" : innerWidth >= 1600; });
  const { session, track } = useLiveSession();
  const seq = useRef(0), lastView = useRef(route.view);

  // Workflow runs (artifact platform) are listed in the task switcher next to design projects; best effort, never blocks.
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const refresh = useCallback(async () => {
    const s = await api<State>("/state"); setData(s);
    void api<RunSummary[]>("/v1/workflow-runs").then(r => setRuns(Array.isArray(r) ? r : [])).catch(() => undefined);
    return s;
  }, []);
  useEffect(() => { void refresh().catch(e => setLoadError(String(e instanceof Error ? e.message : e))); }, [refresh]);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    scrollTo({ top: 0 });
    requestAnimationFrame(() => (document.querySelector("main h1") as HTMLElement | null)?.focus({ preventScroll: true }));
  }, [route.view]);
  useEffect(() => {
    // On narrow screens the stage bar and tabs scroll sideways; keep the current item in view.
    requestAnimationFrame(() => document.querySelectorAll('.rail a[aria-current="page"], .tabs [aria-selected="true"]')
      .forEach(e => revealInScroller(e)));
  }, [route.view, route.params.toString()]);
  useEffect(() => {
    // Crossing into phone width turns the docked assistant into a closed sheet instead of covering the work area.
    const query = matchMedia("(max-width: 1023px)");
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setAssistant(false); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (!assistant || innerWidth >= 1024) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAssistant(false); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [assistant]);
  useEffect(() => { if (innerWidth >= 1024) localStorage.setItem("pai-assistant", assistant ? "open" : "closed"); }, [assistant]);

  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("pai-theme") as Theme | null) ?? "system");
  useEffect(() => {
    localStorage.setItem("pai-theme", theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme; };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem("pai-rail") === "collapsed");
  useEffect(() => { localStorage.setItem("pai-rail", railCollapsed ? "collapsed" : "expanded"); }, [railCollapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) setRailCollapsed(v => !v);
    };
    const onToggle = () => setAssistant(a => !a);
    addEventListener("keydown", onKey); addEventListener("pai-toggle-assistant", onToggle);
    return () => { removeEventListener("keydown", onKey); removeEventListener("pai-toggle-assistant", onToggle); };
  }, []);

  const toast = useCallback((message: string, tone: "ok" | "bad" = "ok") => setToasts(t => [...t.filter(x => x.tone === "bad").slice(-1), { id: ++seq.current, message, tone }]), []);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const navigate = useCallback((view: ViewId, params: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
    const hash = `#/${view}${q ? `?${q}` : ""}`;
    if (location.hash !== hash) location.hash = hash; else setRoute(parseRoute());
  }, []);
  const perform = useCallback(async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); await refresh(); toast(message); return true; }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); await refresh().catch(() => undefined); return false; }
    finally { setBusy(false); }
  }, [refresh, toast]);
  const selectProject = useCallback((id: string) => { setProjectId(id); localStorage.setItem("pai-project", id); rememberProject(id); }, []);

  const project = data?.projects.find(p => p.id === projectId) ?? data?.projects.at(-1);
  const lifecycle = project ? data?.lifecycles?.[project.id] : undefined;
  const ctx: Ctx | undefined = data && { data, project, lifecycle, busy, route, navigate, perform, refresh, selectProject, toast, track, session,
    openAssistant: () => { setAssistant(true); setTimeout(() => dispatchEvent(new Event("pai-focus-chat")), 50); },
    askAI: (message: string, attachments?: Attachment[]) => { setAssistant(true); setTimeout(() => dispatchEvent(new CustomEvent("pai-ask", { detail: { message, attachments } })), 60); } };

  const commands: Command[] = useMemo(() => [
    { id: "theme", label: `外观：${THEME_LABEL[theme]} → ${THEME_LABEL[nextTheme(theme)]}`, run: () => setTheme(nextTheme(theme)) },
    { id: "rail", label: railCollapsed ? "展开生命周期侧栏" : "收起生命周期侧栏", hint: "[", run: () => setRailCollapsed(v => !v) },
    { id: "assistant", label: "打开 AI 助手", hint: "/", run: () => { setAssistant(true); setTimeout(() => dispatchEvent(new Event("pai-focus-chat")), 50); } },
    ...VIEWS.map(v => ({ id: `go-${v.id}`, label: `前往：${v.index ? `${v.index} ` : ""}${v.label}`, run: () => navigate(v.id) })),
    { id: "new", label: "新建评审任务", run: () => navigate("requirements", { new: "1" }) },
    // Every task is reachable from Ctrl K too (search by title or id), newest first.
    ...[...(data?.projects ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(p => ({ id: `project-${p.id}`, label: `切换任务：${p.title} · v${p.revision}`, hint: p.id.slice(0, 6),
      run: () => { selectProject(p.id); navigate("overview"); } })),
    { id: "release", label: "发布：创建或审批发布候选", run: () => navigate("deliver") },
    { id: "versions", label: "需求版本历史与比较", run: () => navigate("requirements") },
    { id: "scene", label: "生成并检查 Blender 场景（默认参数）", run: () => { if (ctx?.project && data?.capabilities.blender) void runScene(ctx, "occluded", { maxFootprintArea: 12, targetEnvelopeRadius: 1.4, requireTargetVisible: true }); else navigate("design", { lane: "scene" }); } },
    { id: "cad", label: "CAD 零件：NEMA 17 电机支架", run: () => navigate("design", { lane: "cad" }) },
    { id: "factory", label: "工厂维护与能源评审", run: () => navigate("design", { lane: "factory" }) },
    { id: "plant", label: "产线布局设计（Blender + 射线实测）", run: () => navigate("design", { lane: "plant" }) },
    ...(["persp", "top", "front", "right", "camera"] as const).map(v => ({ id: `view-${v}`, label: `视图：${{ persp: "透视", top: "顶视", front: "前视", right: "右视", camera: "检查相机" }[v]}`,
      hint: { persp: "5", top: "7", front: "1", right: "3", camera: "0" }[v], run: () => dispatchEvent(new CustomEvent("pai-view", { detail: v })) })),
    { id: "wire", label: "切换线框显示", hint: "Z", run: () => dispatchEvent(new CustomEvent("pai-view", { detail: "wire" })) },
    { id: "xray", label: "切换 X 光透视", hint: "Alt Z", run: () => dispatchEvent(new CustomEvent("pai-view", { detail: "xray" })) },
  ], [navigate, ctx, data?.capabilities.blender, data?.projects, selectProject, theme, railCollapsed]);

  if (!ctx) return <div className="boot" role="status">{loadError ? `无法加载工作区：${loadError}` : "正在加载工作区…"}</div>;
  const view = { overview: <Overview />, requirements: <Requirements />, design: <Design />, validate: <Validate />, evidence: <Evidence />, feedback: <FeedbackView />, deliver: <Deliver />, artifacts: <Artifacts /> }[route.view];
  return <AppContext.Provider value={ctx}>
    <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); (document.querySelector("main h1") as HTMLElement | null)?.focus(); }}>跳到主要内容</a>
    <div className={`app ${assistant ? "with-assistant" : ""} ${railCollapsed ? "rail-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand-wrap"><a className="brand" href="#/artifacts" aria-label="PAI Engine 首页：决策算法与孪生"><span className="brand-mark">P</span><span>PAI<small>ENGINE</small></span></a>
          {ctx.data.build && <BuildBadge build={ctx.data.build} />}</div>
        <div className="project-switch">
          {(ctx.data.projects.length > 0 || runs.length > 0) && <ProjectSwitcher projects={ctx.data.projects} archived={new Set((ctx.data.projectArchives ?? []).filter(a => a.archived).map(a => a.projectId))} runs={runs} lifecycles={ctx.data.lifecycles} current={project}
            onSelect={id => { selectProject(id); navigate("overview"); }} onSelectRun={id => navigate("artifacts", { run: id })} />}
          <button type="button" className="secondary compact" onClick={() => navigate("requirements", { new: "1" })}>新建</button>
          {lifecycle && <button type="button" className={`maturity-chip m-${lifecycle.maturity.state}`} onClick={() => navigate("deliver")}
            aria-label={`成熟度：${lifecycle.maturity.state === "released" ? `${lifecycle.maturity.number} 已发布` : lifecycle.maturity.state === "in-review" ? `${lifecycle.maturity.number} 待审批` : "设计中"}`}>
            {lifecycle.maturity.state === "released" ? `${lifecycle.maturity.number} · ${MATURITY.released[0]}` : lifecycle.maturity.state === "in-review" ? `${lifecycle.maturity.number} · ${MATURITY["in-review"][0]}` : "设计中"}</button>}
        </div>
        <button type="button" className="omnibox" onClick={() => dispatchEvent(new Event("pai-palette"))} aria-label="打开命令面板：搜索命令、跳转或问 AI">
          <span aria-hidden="true">⌕</span><span className="omni-text">搜索命令、跳转或问 AI…</span><kbd>Ctrl K</kbd></button>
        <div className="top-actions">
          <button type="button" className="ghost icon theme-toggle" onClick={() => setTheme(nextTheme(theme))} aria-label={`外观：${THEME_LABEL[theme]}（点击切换）`} title={`外观：${THEME_LABEL[theme]}`}>
            <span aria-hidden="true">{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</span></button>
          <button type="button" className={assistant ? "assistant-toggle on" : "assistant-toggle"} aria-pressed={assistant} onClick={() => setAssistant(a => !a)}>AI 助手</button>
          {ctx.data.capabilities.authenticatedWorkspace && <a className="session-logout" href="/logout">退出登录</a>}
        </div>
      </header>
      <nav className="rail" aria-label="生命周期">
        <ol>{VIEWS.map(v => { const stage = lifecycle?.stages.find(s => s.id === v.id); return <li key={v.id} className={v.group ? "rail-grouped" : undefined}>
          {v.group && <span className="rail-group" aria-hidden="true">{v.group}</span>}
          <a href={`#/${v.id}`} aria-current={route.view === v.id ? "page" : undefined} className={stage ? `s-${stage.status}` : "s-overview"}
            aria-label={`${v.index ? `${v.index} ` : ""}${v.label}${stage ? `：${DOT[stage.status]}，${stage.metric}` : ""}`}
            title={`${v.label}${stage ? ` · ${DOT[stage.status]} · ${stage.metric}` : ""}`}>
            <span className="rail-index" aria-hidden="true">{v.index ?? (v.id === "artifacts" ? "◆" : "◎")}</span>
            <span className="rail-text"><span className="rail-label">{v.label}</span><span className="rail-short" aria-hidden="true">{v.short}</span>{stage && <small>{stage.metric}</small>}</span>
            {stage && <span className="rail-dot" title={DOT[stage.status]} />}</a></li>; })}</ol>
        <p className="rail-foot">反馈 → 复测 → 验证 形成闭环<br />记录仿真 · 合成场景 · 演示孪生<br />尚未现场验证</p>
        <button type="button" className="ghost rail-toggle" onClick={() => setRailCollapsed(v => !v)} aria-pressed={railCollapsed} aria-label={railCollapsed ? "展开侧栏" : "收起侧栏"}
          title={railCollapsed ? "展开侧栏 [" : "收起侧栏 ["}><span aria-hidden="true">{railCollapsed ? "»" : "«"}</span><span className="rail-toggle-text">收起侧栏</span></button>
      </nav>
      <main id="main" aria-busy={busy}>{busy && <div className="busy" role="progressbar" aria-label="正在执行并保存回执" />}{view}</main>
      <footer className="statusbar" aria-label="状态栏">
        <span className={`sb-item ${session?.running ? "live" : ""}`}>{session?.running ? <><span className="live-dot on" />{session.title} · {session.steps.filter(s => s.status === "done").length}/{Math.max(session.steps.length, 1)} 步</>
          : <>原生任务空闲</>}</span>
        {project && lifecycle && <span className="sb-item">需求 v{project.revision} · <code>{lifecycle.requirementDigest.slice(0, 10)}</code></span>}
        {lifecycle && <span className="sb-item">{lifecycle.counts.runs} 次检查 · {lifecycle.failingCases.length} 个失败案例 · {lifecycle.counts.openFeedback} 条待处理反馈</span>}
        <span className="sb-item sb-right">{ctx.data.capabilities.blender ? "Blender ✓" : "Blender —"} · {ctx.data.capabilities.cad ? "CadQuery ✓" : "CadQuery —"} · <kbd>Ctrl K</kbd> 命令</span>
      </footer>
      {assistant && <button type="button" className="assistant-scrim" aria-label="关闭 AI 助手" onClick={() => setAssistant(false)} />}
      {assistant && <aside className="assistant" aria-label="AI 助手"><Assistant onClose={() => setAssistant(false)} /></aside>}
    </div>
    <Toasts items={toasts} dismiss={dismiss} />
    <Palette commands={commands} onAsk={q => ctx.askAI(q)} />
  </AppContext.Provider>;
}
/** Running version: package version + short source commit, so a deploy can be matched to main at a glance. */
function BuildBadge({ build }: { build: NonNullable<State["build"]> }) {
  const detail = [`版本 v${build.version}`, `提交 ${build.commit ?? "未知"}${build.dirty ? "（有未提交修改）" : ""}`,
    build.packagedAt ? `打包于 ${new Date(build.packagedAt).toLocaleString()}` : build.source === "checkout" ? "本地工作区" : "",
    build.releaseDigest ? `发布包 ${build.releaseDigest.slice(0, 12)}` : ""].filter(Boolean).join("\n");
  // Only the version is shown; the commit, package time and release digest stay one hover (or screen reader) away.
  return <span className="build-badge" title={detail} aria-label={detail.replace(/\n/g, "，")} data-commit={build.commit?.slice(0, 7)}>
    v{build.version}{build.dirty ? "*" : ""}</span>;
}
// Apply the stored theme before the first render (no light flash, and correct even while the workspace loads).
{
  const t = (localStorage.getItem("pai-theme") as Theme | null) ?? "system";
  document.documentElement.dataset.theme = t === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
}
/** Role first (default deny on the server): maintainers get the workbench, tenant members their portal, others nothing. */
function Root() {
  const [session, setSession] = useState<Session>();
  useEffect(() => { void loadSession().then(setSession).catch(() => setSession({ role: "maintainer", logoutUrl: null })); }, []);
  if (!session) return <div className="boot">正在加载工作区…</div>;
  if (session.role === "tenant") return <TenantPortal session={{ tenant: session.tenant!, email: session.email!, logoutUrl: session.logoutUrl }} />;
  if (session.role === "none") return <NoAccess logoutUrl={session.logoutUrl} />;
  return <App />;
}
createRoot(document.getElementById("root")!).render(<Root />);
// No service worker: a registered one broke the hosted sign-in (see web/public/sw.js). Remove any left from older releases.
if ("serviceWorker" in navigator) void navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))).catch(() => undefined);
if ("caches" in self) void caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("pai-shell-")).map(k => caches.delete(k)))).catch(() => undefined);
