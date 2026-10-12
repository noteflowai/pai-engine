import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Usability and interaction checks for the classic industrial cases, modelled on how CAD/PLM tools are
 * reviewed: accessibility (WCAG 2.1 AA via axe-core) in both themes and on phones, keyboard-first operation
 * (command palette, panel shortcuts), a viewport-first workspace, and AI that is asked from the evidence
 * itself. Each test records task timings and step counts into .state/evidence/usability.json.
 */
const REQ = { maxMassG: 80, minWallMm: 3, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [80, 40, 60] };
const metrics: Record<string, unknown> = {};
async function record(name: string, value: unknown) {
  metrics[name] = value;
  await mkdir(".state/evidence", { recursive: true });
  const path = ".state/evidence/usability.json";
  const prev = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  await writeFile(path, JSON.stringify({ ...prev, checkedAt: new Date().toISOString(), [name]: value }, null, 2));
}
async function seed(page: Page) {
  // Fixture through the public API (the UI flows below create their own records).
  const p = await (await page.request.post("/api/projects", { data: { title: "易用性：NEMA 17 支架", intendedDecision: "Usability of the classic bracket cases",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } })).json();
  const cad = await (await page.request.post(`/api/projects/${p.id}/cad`, { data: { requestId: crypto.randomUUID(), projectRevision: 1, variant: "lightweight", requirements: REQ }, timeout: 240_000 })).json();
  await page.goto("/");
  await page.evaluate(id => { localStorage.setItem("pai-project", id); }, p.id);
  return { project: p, cad };
}
const views = (cadId: string) => ["overview", "requirements", "design", "design?lane=scene", "design?lane=cad", "design?lane=factory",
  `validate?kind=cad-part&id=${cadId}`, "evidence", "feedback", "deliver"];

test("WCAG 2.1 AA: no serious or critical axe violations on every view, light and dark, desktop and phone", async ({ page }) => {
  test.setTimeout(420_000);
  const { cad } = await seed(page);
  const found: string[] = [];
  let scanned = 0;
  for (const [theme, w, h] of [["light", 1440, 900], ["dark", 1440, 900], ["dark", 390, 844], ["light", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(t => localStorage.setItem("pai-theme", t), theme);
    for (const v of views(cad.id)) {
      await page.goto(`/#/${v}`); await page.reload();
      await expect(page.getByRole("navigation", { name: "生命周期" })).toBeVisible();
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".viewport-canvas").analyze();
      scanned++;
      for (const x of r.violations.filter(x => x.impact === "serious" || x.impact === "critical")) found.push(`${theme}@${w} ${v.split("?")[0]} ${x.id}: ${x.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", ")}`);
      if (w === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${v} overflows at 390 px`).toBe(true);
    }
  }
  await record("accessibility", { standard: "WCAG 2.1 A/AA (axe-core 4.13)", pagesScanned: scanned, themes: ["light", "dark"], widths: [1440, 390], seriousOrCritical: found.length });
  expect(found).toEqual([]);
});

test("keyboard first: palette jumps and asks AI, [ collapses the rail, theme persists, focus is visible", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("pai-theme", "light"); localStorage.setItem("pai-rail", "expanded"); localStorage.setItem("pai-assistant", "closed"); });
  await page.goto("/#/overview"); await page.reload();
  await expect(page.getByRole("navigation", { name: "生命周期" })).toBeVisible();
  // Skip link is the first focusable element (DOM order) and shows a visible focus ring. Chromium's sequential
  // focus starting point after a reload is browser state, so the order is checked deterministically:
  // the first focusable element is the skip link, and Shift+Tab from the brand lands on it.
  const firstFocusable = await page.evaluate(() => (document.querySelector("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])") as HTMLElement).className);
  expect(firstFocusable).toBe("skip-link");
  await page.locator(".brand").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeInViewport();
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
  // Palette: type, arrow, enter.
  const t0 = Date.now();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("CAD 零件");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/design\?lane=cad/);
  await expect(page.getByRole("tab", { name: "CAD 零件", selected: true })).toBeVisible();
  const paletteMs = Date.now() - t0;
  // Free text becomes a question to the assistant.
  await page.keyboard.press("Control+k");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("轻量化支架为什么壁厚不合格");
  await expect(palette.getByRole("combobox")).toHaveValue("轻量化支架为什么壁厚不合格");
  await expect(palette.getByRole("option", { name: /问 AI：轻量化支架为什么壁厚不合格/ })).toBeVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await expect(assistant.locator("#studio-input")).toHaveValue("轻量化支架为什么壁厚不合格");
  await expect(assistant.locator("#studio-input")).toBeFocused();
  await page.keyboard.press("Escape");
  // "[" toggles the rail (outside text fields) and persists.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("[");
  await expect(page.locator(".app")).toHaveClass(/rail-collapsed/);
  const railWidth = await page.locator(".rail").evaluate(e => e.getBoundingClientRect().width);
  expect(railWidth).toBeLessThanOrEqual(64);
  await page.reload();
  await expect(page.locator(".app")).toHaveClass(/rail-collapsed/);
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.locator(".app")).not.toHaveClass(/rail-collapsed/);
  // Theme toggle cycles light → dark → system and persists across reloads.
  await page.getByRole("button", { name: /外观：浅色/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pai-theme"))).toBe("dark");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "生命周期" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.getByRole("button", { name: /外观：深色/ }).click();
  expect(await page.evaluate(() => localStorage.getItem("pai-theme"))).toBe("system");
  await record("keyboard", { paletteToCadLaneMs: paletteMs, paletteKeystrokes: "Ctrl+K, type, Enter", askFromPalette: true, railShortcut: "[", themePersists: true, skipLinkFirst: true });
});

test("classic case C2 with AI in context: failed row → ask AI → validated plan → confirm → recheck passes", async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => { localStorage.setItem("pai-assistant", "open"); localStorage.setItem("pai-theme", "light"); });
  const t0 = Date.now();
  let clicks = 0;
  const click = async (l: ReturnType<Page["getByRole"]>) => { clicks++; await l.click(); };
  await page.goto("/#/requirements?new=1"); await page.reload();
  await click(page.getByRole("button", { name: "创建评审任务" }));
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  await page.goto("/#/design?lane=cad");
  await click(page.getByRole("radio", { name: /轻量化/ }));
  await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }));
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 240_000 });
  const toFailureMs = Date.now() - t0;
  // Viewport-first workspace: with the assistant docked the 3D viewport starts in the first screen and is large.
  const vp = await page.locator(".viewport").boundingBox();
  expect(vp!.y, "viewport starts in the upper half of the first screen").toBeLessThan(450);
  expect(vp!.height).toBeGreaterThanOrEqual(420);
  // Focus mode: the viewport fills the window, Esc restores it and returns focus; the outliner can be hidden.
  const viewport = page.locator(".viewport");
  await viewport.getByRole("button", { name: "最大化视口" }).click();
  const full = page.getByRole("dialog", { name: /三维视口/ });
  await expect(full).toBeVisible();
  const box = await full.boundingBox();
  expect(Math.round(box!.width)).toBe(1440); expect(Math.round(box!.height)).toBe(900);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  expect((await new AxeBuilder({ page }).include(".viewport").exclude(".viewport-canvas").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations
    .filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  await viewport.getByRole("button", { name: "大纲" }).click();
  await expect(page.locator(".viewport-side")).toBeHidden();
  await viewport.getByRole("button", { name: "大纲" }).click();
  await page.keyboard.press("Escape");
  await expect(full).toHaveCount(0);
  await expect(viewport.getByRole("button", { name: "最大化视口" })).toBeFocused();
  // Phone width: same focus mode, nothing overflows; the outliner starts hidden on a narrow screen after reload.
  await page.setViewportSize({ width: 390, height: 844 });
  await viewport.getByRole("button", { name: "最大化视口" }).click();
  expect(Math.round((await full.boundingBox())!.width)).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await viewport.getByRole("button", { name: "还原视口" }).click();
  await page.reload(); await expect(page.locator(".viewport-side")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
  // Measured table: the failed rule shows observed, required and a negative allowance.
  const row = page.locator(".check-table tr.fail");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("最小壁厚"); await expect(row).toContainText("2.5"); await expect(row).toContainText("≥ 3"); await expect(row).toContainText("-17%");
  const { writeFile: write } = await import("node:fs/promises");
  const state = await (await page.request.get("/api/state")).json();
  const failedCad = state.cads.at(-1);
  await write(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["轻量化把板厚降到 2.5 mm，低于 3 mm 的壁厚要求"],
    answer: { text: "cad-1 的最小壁厚实测 2.5 mm，低于要求的 3 mm；其他检查通过。恢复 4 mm 板厚的基准参数可在不放宽要求的情况下通过。", citations: ["cad-1"] },
    plans: [{ ref: "p1", tool: "cad-review", title: "恢复基准参数复测", payload: { variant: "reference" } }] }) + "\n```" }] }));
  await click(row.getByRole("button", { name: /问 AI：最小壁厚为什么未通过/ }));
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  const composer = assistant.locator("#studio-input");
  await expect(composer).toHaveValue(/最小壁厚.*2\.5.*≥ 3/);
  await expect(composer).toBeFocused();
  await expect(assistant.getByRole("button", { name: "AI 引擎", exact: true })).toHaveAttribute("aria-pressed", "true");
  await click(assistant.getByRole("button", { name: "生成计划 ↵" }));
  await expect(assistant.getByRole("group", { name: "引用的记录" }).last()).toContainText("CAD 零件 · lightweight");
  const card = assistant.getByRole("article", { name: "计划 恢复基准参数复测" });
  await expect(card.getByText("lightweight → reference")).toBeVisible();
  await click(card.getByRole("button", { name: "确认执行" }));
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible();
  await expect(page.locator(".check-table tr.fail")).toHaveCount(0);
  const totalMs = Date.now() - t0;
  const after = await (await page.request.get("/api/state")).json();
  expect(after.cads.at(-1).verdict).toBe("accepted-cad-part"); expect(after.cads.at(-1).id).not.toBe(failedCad.id);
  await record("caseC2WithAI", { clicks, toFailureSeconds: Math.round(toFailureMs / 1000), totalSeconds: Math.round(totalMs / 1000),
    viewportTop: Math.round(vp!.y), viewportHeight: Math.round(vp!.height), askedFrom: "failed check row", aiMode: "engine (scripted executor)", outcome: "rejected → accepted" });
  expect(errors).toEqual([]);
});

test("classic cases G1 and S1 by mouse: code editor and sweep in a few clicks, nothing hidden at phone width", async ({ page }) => {
  test.setTimeout(420_000);
  const state = await (await page.request.get("/api/state")).json();
  test.skip(!state.capabilities.cad?.generatedCode?.available, "sandbox unavailable");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { localStorage.setItem("pai-assistant", "closed"); localStorage.removeItem("pai-cad-code-draft"); });
  await page.goto("/#/requirements?new=1"); await page.reload();
  await page.getByRole("button", { name: "创建评审任务" }).click();
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  const t0 = Date.now();
  await page.goto("/#/design?lane=cad");
  await page.getByRole("radio", { name: /生成代码/ }).check();
  const editor = page.getByRole("textbox", { name: /CadQuery 代码/ });
  await editor.fill((await editor.inputValue()).replace("T = 4.0 ", "T = 2.5 "));
  await page.getByRole("button", { name: "在沙箱中运行并检查" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator(".check-table tr.fail")).toContainText("最小壁厚");
  const g1 = Math.round((Date.now() - t0) / 1000);
  const t1 = Date.now();
  await page.goto("/#/design?lane=cad");
  const panel = page.locator(".card", { has: page.getByRole("heading", { name: "设计空间扫描" }) });
  await panel.getByRole("textbox", { name: /板厚 t/ }).fill("2.5, 3, 4");
  await panel.getByRole("textbox", { name: /宽度 W/ }).fill("60");
  await panel.getByRole("textbox", { name: /安装板高度 H/ }).fill("46");
  await panel.getByRole("button", { name: "运行扫描" }).click();
  await expect(panel.getByRole("group", { name: "质量与最小壁厚散点图" })).toBeVisible({ timeout: 240_000 });
  await expect(panel.locator(".sweep-pick")).toContainText("t=3");
  const s1 = Math.round((Date.now() - t1) / 1000);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const v of ["design?lane=cad", "validate"]) {
    await page.goto(`/#/${v}`); await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), v).toBe(true);
  }
  await page.goto("/#/design?lane=cad");
  await expect(panel.getByRole("button", { name: "以此参数生成正式候选" })).toBeVisible();
  await record("casesG1S1", { g1Seconds: g1, s1Seconds: s1, g1Steps: ["选择生成代码", "改一行", "运行"], s1Steps: ["填 3 个轴", "运行扫描"], phoneOverflow: false });
});

test("project switcher: same-titled tasks told apart, search, keyboard, recent first, accessible, phone width", async ({ page }) => {
  const make = async (title: string) => (await (await page.request.post("/api/projects", { data: { title, intendedDecision: "Switcher usability check",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } })).json()) as { id: string };
  const tag = `切换器 ${Date.now() % 100000}`;
  const a = await make(`${tag} 同名任务`), b = await make(`${tag} 同名任务`), c = await make(`${tag} 轴承座`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto("/#/overview");
    const trigger = page.getByRole("button", { name: /^选择已有任务：/ });
    await trigger.click();
    const search = page.getByRole("combobox", { name: /搜索任务/ });
    await expect(search).toBeFocused();
    await search.fill(tag);
    const options = page.getByRole("listbox", { name: "任务" }).getByRole("option");
    await expect(options).toHaveCount(3);
    // Same title, different rows: each shows its own short id.
    await expect(options.filter({ hasText: a.id.slice(0, 6) })).toHaveCount(1);
    await expect(options.filter({ hasText: b.id.slice(0, 6) })).toHaveCount(1);
    expect((await new AxeBuilder({ page }).include(".switcher-pop").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations
      .filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await search.fill(`${tag} 轴承`);
    await expect(options).toHaveCount(1);
    await search.press("Enter");
    await expect(page.getByRole("dialog", { name: "切换任务" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText(`${tag} 轴承座`);
    // Reopened: the task just chosen leads the recent group; Escape closes and returns focus.
    await trigger.click();
    await expect(page.locator(".sw-group").first()).toHaveText("最近打开");
    await expect(page.getByRole("listbox", { name: "任务" }).getByRole("option").first()).toContainText(c.id.slice(0, 6));
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});
