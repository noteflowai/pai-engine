import { test, expect, type Page } from "@playwright/test";

const rail = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name });
async function createProject(page: Page) {
  await page.goto("/#/requirements?new=1");
  await page.getByRole("button", { name: "创建评审任务" }).click();
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SmolVLA 相机布局设计评审");
}
async function advance(page: Page, names: string[], timeout = 60_000) {
  for (const name of names) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".busy")).toHaveCount(0, { timeout });
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
}
// These flows use the docked assistant at 1440 px: start as a user who has opened it before (the default is closed below
// 1600 px; tests/browser/usability.spec.ts covers the defaults).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { if (!localStorage.getItem("pai-assistant")) localStorage.setItem("pai-assistant", "open"); }); });
const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test("authenticated workspace keeps sign-out and lifecycle navigation usable at phone width", async ({ page }) => {
  // Layout-only fixture. No native outputs, observed users or commands are fabricated.
  await page.route("**/api/state", route => route.fulfill({ json: {
    projects: [], reviews: [], feedback: [], campaigns: [], proposals: [], scenes: [],
    metrics: { independentParticipants: 0, independentEvents: 0, independentRepeatUsers: 0, maintainerEvents: 0, fixtureEvents: 0 },
    capabilities: { modelProposal: false, blender: false, authenticatedWorkspace: true },
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // The landing page is the decision platform; the design overview is one link away.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("决策算法与物理 AI 孪生");
  await expect(page.getByRole("link", { name: "退出登录" })).toBeVisible();
  await page.goto("/#/overview");
  await expect(page.getByText("还没有评审任务")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "AI 助手" })).toHaveCount(0);
  await noOverflow(page);
});

test("full lifecycle: requirement, native review, replay, feedback recheck, handoff and revision", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await expect(page.getByRole("region", { name: "下一步" })).toContainText("提交第一个候选进行原生验证");
  await rail(page, /候选设计/).click();
  await page.getByRole("button", { name: "提交验证：相机偏移" }).click();
  await expect(page.getByRole("heading", { name: "拒绝采用", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("EvalArc 检测到丢失 1 个基准成功样本")).toBeVisible();
  await expect(rail(page, /失败回放/)).toHaveClass(/s-attention/);
  await page.getByRole("button", { name: "回放", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "配对种子" })).toHaveValue("9");
  await expect(page.locator("video")).toHaveCount(2);
  await expect.poll(() => page.locator("video").evaluateAll(videos =>
    videos.every(v => (v as HTMLVideoElement).videoWidth > 0 && (v as HTMLVideoElement).duration > 0))).toBe(true);
  await page.locator("video").first().evaluate(async v => { const video = v as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => page.locator("video").first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await page.locator("video").first().evaluate(v => (v as HTMLVideoElement).pause());
  await page.getByRole("button", { name: /记录反馈：seed 9/ }).click();
  await expect(page.getByRole("heading", { name: "反馈复测", level: 1 })).toBeVisible();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "回退基准并复测", "关闭已复测反馈"]);
  await page.getByRole("button", { name: /已关闭 1/ }).click();
  await expect(page.locator(".run-list").getByText("已关闭", { exact: true })).toBeVisible();
  await rail(page, /项目总览/).click();
  await expect(page.getByRole("region", { name: "下一步" })).toContainText("创建发布候选");
  await page.getByRole("region", { name: "下一步" }).getByRole("button", { name: "前往 →" }).click();
  // The release cites the passing rollback recheck; the rejected camera review stays a retained failure.
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  await page.getByRole("button", { name: "生成案例草稿" }).click();
  await expect(page.getByText("案例草稿已生成，尚未发送。")).toBeVisible();
  await expect(page.locator("details pre")).toContainText("Not sent or published by this workbench");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.metrics.independentParticipants).toBe(0);
  const projectId = state.projects.at(-1).id;
  expect(state.lifecycles[projectId].stages.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done", "done", "done", "done"]);
  const run = state.reviews.find((r: { candidate: string; projectId: string }) => r.candidate === "camera" && r.projectId === projectId);
  const packet = await (await page.request.get(`/api/runs/${run.id}/bundle`)).json();
  const checked = await page.request.post("/api/bundles/verify", { data: packet });
  expect(checked.status()).toBe(200); expect((await checked.json()).valid).toBe(true);
  const range = await page.request.get(`/api/runs/${run.id}/media/camera/9/main`, { headers: { Range: "bytes=0-99" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(100);
  await rail(page, /项目总览/).click();
  await page.screenshot({ path: testInfo.outputPath("overview-desktop.png"), fullPage: true });
  await rail(page, /需求冻结/).click();
  await page.getByRole("button", { name: "修订需求" }).click();
  await page.getByRole("combobox", { name: "样本最低成功率" }).selectOption("0.7");
  await page.getByRole("button", { name: "保存为 v2" }).click();
  await expect(page.getByText(/需求已修订为 v2/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^选择已有任务：/ })).toContainText("v2");
  for (const width of [1024, 1280, 1440]) {
    // The docked assistant must sit beside the work area, never on top of it.
    await page.setViewportSize({ width, height: 800 });
    if (await page.getByRole("complementary", { name: "AI 助手" }).count() === 0) await page.getByRole("button", { name: "AI 助手" }).click();
    const [mainBox, asideBox] = await Promise.all([page.locator("main").boundingBox(), page.getByRole("complementary", { name: "AI 助手" }).boundingBox()]);
    expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(asideBox!.x + 1);
    expect(mainBox!.width).toBeGreaterThanOrEqual(560);
    await noOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("complementary", { name: "AI 助手" })).toHaveCount(0);
  await rail(page, /原生验证/).click();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("validate-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  // A worker left by an older release (it broke the hosted sign-in) is removed with its caches on the next load.
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await caches.open("pai-shell-0.3.1"); });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "生命周期" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith("pai-shell-")).length)).toBe(0);
});

test("visual review: recorded inspection views go to the AI with the question, pinned by digest", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  expect(state.capabilities.assistant.images).toBe(true);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "Blender 场景" }).click();
  await page.getByRole("button", { name: "生成并检查 Blender 场景" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 150_000 });
  const { writeFile: write, readFile: read, rm } = await import("node:fs/promises");
  const log = ".state/browser/fake-visual.jsonl"; await rm(log, { force: true });
  await write(".state/browser/fake-executor.json", JSON.stringify({ log, attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["候选相机视图被大块体挡住"], answer: { text: "scene-1 候选视图里一块大面板挡住了工位，射线检查同样失败；改回无遮挡布局。", citations: ["scene-1"] },
    plans: [{ ref: "p1", tool: "scene-review", title: "无遮挡布局复测", payload: { variant: "clear" } }] }) + "\n```" }] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /带图问 AI（2 张已记录图像）/ }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  const chips = assistant.getByRole("list", { name: "随问题发送的已记录图像" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  await expect(chips).toContainText("候选相机视图");
  await noOverflow(page);
  await assistant.screenshot({ path: testInfo.outputPath("visual-ask-mobile.png") });
  await assistant.getByRole("button", { name: "移除附图 基准相机视图" }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(1);
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByRole("article", { name: "计划 无遮挡布局复测" })).toBeVisible({ timeout: 60_000 });
  await expect(chips).toHaveCount(0);
  // The executor received exactly the recorded candidate preview, by digest; nothing from the browser.
  const sent = JSON.parse((await read(log, "utf8")).trim().split("\n").at(-1)!);
  const after = await (await page.request.get("/api/state")).json();
  const scene = after.scenes.filter((s: { projectId: string }) => s.projectId === after.projects.at(-1).id).at(-1);
  expect(sent.images).toEqual([scene.files["candidate/preview.png"]]);
  expect(sent.prompt).not.toContain("preview.png");
  expect(errors).toEqual([]);
});

test("second part family: 6202 pillow block from the CAD form, single-fault preset rejected on the bearing seat, FEA on the seat, phone width", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad?.families?.["pillow-block"]) throw new Error("CadQuery with the pillow-block family is required");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
  await expect(page.getByRole("heading", { name: /6202 轴承座/ })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "轴承孔失圆上限" })).toHaveCount(state.capabilities.physics ? 1 : 0);
  // The design-space sweep follows the family: housing axes, its own default grid.
  await expect(page.getByLabel("底座厚度")).toHaveValue("6, 8, 10, 12");
  await expect(page.getByText("24 个点（上限 36）")).toBeVisible();
  await page.getByRole("radio", { name: /轴承孔偏小/ }).check();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  const fail = page.locator(".check-table tr.fail");
  await expect(fail).toHaveCount(1); await expect(fail).toContainText("轴承孔（H7）"); await expect(fail).toContainText("34.95");
  await expect(page.locator(".outliner").getByText("6202 bearing")).toBeVisible();
  // The failure goes through feedback; the recheck rebuilds the family's own reference, never the bracket.
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await page.getByRole("button", { name: /记录反馈：CAD 轴承孔/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测"], 180_000);
  const after = await (await page.request.get("/api/state")).json();
  const recheck = after.cads.filter((x: { feedbackId?: string }) => x.feedbackId).at(-1);
  expect(recheck.request.variant).toBe("pillow-block"); expect(recheck.verdict).toBe("accepted-cad-part");
  // Generated code for this family: the editor switches to the housing template, which passes in the sandbox.
  if (state.capabilities.cad.generatedCode?.available) {
    await rail(page, /候选设计/).click();
    await page.getByRole("tab", { name: "CAD 零件" }).click();
    await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
    await page.getByRole("radio", { name: /生成代码|代码/ }).first().check();
    await expect(page.locator("#cad-code")).toHaveValue(/AXIS_Z = 30\.0/);
    await page.getByRole("button", { name: "在沙箱中运行并检查" }).click();
    await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".check-table")).toContainText("轴承孔（H7）");
  }
  // Structural FEA on the housing from the same form: the bearing load is measured on the seat (distortion row).
  if (state.capabilities.physics) {
    await rail(page, /候选设计/).click();
    await page.getByRole("tab", { name: "CAD 零件" }).click();
    await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
    await page.getByRole("radio", { name: /6202 轴承座基准/ }).check();
    await page.getByRole("checkbox", { name: "冻结结构要求并做 FEA" }).check();
    await expect(page.getByRole("spinbutton", { name: "轴承径向载荷" })).toHaveValue("1000");
    await expect(page.getByRole("combobox", { name: "载荷方向" })).toHaveValue("away-from-base");
    // Physics optimisation follows the family: the housing's load case and its seat-distortion limit.
    await expect(page.getByText(/轴承径向载荷 1000 N（背离底座）/)).toBeVisible();
    await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
    await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 300_000 });
    const row = page.locator(".check-table tr", { hasText: "轴承孔变形（FEA）" });
    await expect(row).toContainText("µm"); await expect(row).not.toHaveClass(/fail/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("pillow-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("first-article inspection: measured values against the frozen tolerances, nonconforming bore kept, phone width", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
  await page.getByRole("radio", { name: /6202 轴承座基准/ }).check();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 180_000 });
  const fai = page.locator(".card", { hasText: "首件检验（实测回填）" });
  const fill = async (serial: string, bore: string) => {
    await fai.getByRole("button", { name: "生成检验计划并录入实测值" }).click();
    const measured: Record<string, string> = { "轴承孔 Ø（H7）": bore, "轴承孔深": "11.05", "止口 / 轴孔 Ø": "28.02", "外形 X": "108.05", "外形 Y": "36.02", "外形 Z": "55.48", "最薄壁厚": "7.95", "质量": "190.1" };
    for (const [label, v] of Object.entries(measured)) await fai.getByRole("spinbutton", { name: `实测 ${label}` }).fill(v);
    await fai.getByLabel("检验员").fill("QA 张工"); await fai.getByLabel("测量设备").fill("CMM"); await fai.getByLabel("零件序列号").fill(serial);
    await fai.getByRole("button", { name: "记录首件检验" }).click();
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await fai.getByRole("button", { name: "生成检验计划并录入实测值" }).click();
  await noOverflow(page);
  await fai.screenshot({ path: testInfo.outputPath("fai-plan-mobile.png") });
  await page.reload(); await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible();
  // A CMM export fills the form; values are still judged by the server.
  await fai.getByRole("button", { name: "生成检验计划并录入实测值" }).click();
  await fai.getByLabel("导入 CMM 报告（QIF / CSV）").setInputFiles({ name: "cmm.csv", mimeType: "text/csv", buffer: Buffer.from(
    "characteristic,measured,unit\nbearing-seat-diameter,35.012,mm\n轴承孔深,11.04,mm\nshoulder-diameter,28.01\nenvelope-x,108.02\nenvelope-y,36.01\nenvelope-z,55.5\nmin-wall,7.96\nmass,189.9,g\nflatness,0.01,mm\n") });
  await expect(fai.getByRole("status")).toContainText("CSV：已填入 8 / 8 项；未识别：flatness");
  await expect(fai.getByRole("spinbutton", { name: "实测 轴承孔 Ø（H7）" })).toHaveValue("35.012");
  // QIF 3.0 Results from the CMM software: the bore value is joined through its characteristic item, in inches here.
  await fai.getByLabel("导入 CMM 报告（QIF / CSV）").setInputFiles({ name: "cmm.QIF", mimeType: "application/xml", buffer: Buffer.from(
    '<?xml version="1.0"?><QIFDocument xmlns="http://qifstandards.org/xsd/qif3" versionQIF="3.0.0"><FileUnits><PrimaryUnits><LinearUnit><SIUnitName>meter</SIUnitName>'
    + '<UnitName>in</UnitName><UnitConversion><Factor>0.0254</Factor></UnitConversion></LinearUnit></PrimaryUnits></FileUnits>'
    + '<DiameterCharacteristicItem id="49"><Name>bearing-seat-diameter</Name></DiameterCharacteristicItem>'
    + '<DiameterCharacteristicMeasurement id="50"><CharacteristicItemId>49</CharacteristicItemId><Value>1.3784</Value></DiameterCharacteristicMeasurement></QIFDocument>') });
  await expect(fai.getByRole("status")).toContainText("QIF：已填入 1 / 8 项（已从 in 换算为 mm）");
  await expect(fai.getByRole("spinbutton", { name: "实测 轴承孔 Ø（H7）" })).toHaveValue("35.01136");
  await page.reload(); await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible();
  await fill("SN-001", "35.011");
  await expect(fai.getByText("SN-001 · 合格")).toBeVisible();
  await fill("SN-002", "35.031");
  await expect(fai.getByText("SN-002 · 不合格")).toBeVisible();
  await expect(fai).toContainText("轴承孔 Ø（H7） 35.031（35 – 35.025）");
  const st = await (await page.request.get("/api/state")).json();
  // Only this test's task: the store is shared by the whole browser run (and kept between local runs).
  const mine = st.projects.at(-1).id;
  expect(st.inspections.filter((i: { projectId: string }) => i.projectId === mine).map((i: { verdict: string }) => i.verdict).sort()).toEqual(["conforming", "nonconforming"]);
  expect(st.inspections.every((i: { physicalMeasurement: boolean }) => i.physicalMeasurement)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await fai.screenshot({ path: testInfo.outputPath("fai-mobile.png") });
  expect(errors).toEqual([]);
});

// Tagged @cam: about 7 min of FreeCAD CAM, so CI runs it in its own job beside the other shards.
test("CAM from the CAD form: G-code per setup, independent simulation, programs downloadable at phone width", { tag: "@cam" }, async ({ page }, testInfo) => {
  test.setTimeout(1_500_000);
  const state = await (await page.request.get("/api/state")).json();
  test.skip(!state.capabilities.cad?.cam, "CAM toolchain not installed (npm run setup:cam)");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("radio", { name: /基准设计/ }).check();
  await page.getByRole("checkbox", { name: "冻结制造要求并做 DFM" }).check();
  const camBox = page.getByRole("checkbox", { name: "生成 G-code 并做切削仿真（CAM）" });
  await camBox.check(); await expect(camBox).toBeChecked();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 1_400_000 });
  const table = page.locator(".check-table");
  await expect(table.locator("tr", { hasText: "CAM 刀路仿真" })).not.toHaveClass(/fail/);
  await expect(table.locator("tr", { hasText: "加工节拍（CAM）" })).toContainText("min");
  const programs = page.getByRole("group", { name: "CAM 程序" });
  await expect(programs.getByRole("link", { name: /下载 G-code · 装夹/ })).toHaveCount(2);
  const nc = await page.request.get(await programs.getByRole("link", { name: "下载 G-code · 装夹 +Z" }).getAttribute("href") as string);
  expect(nc.status()).toBe(200); expect(await nc.text()).toMatch(/G21[\s\S]*M2/);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("cam-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("native Blender scene from the professional form: rejection, evidence files and occlusion recheck", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "Blender 场景" }).click();
  await page.getByRole("button", { name: "生成并检查 Blender 场景" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 150_000 });
  await expect.poll(() => page.locator(".scene-previews img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).naturalWidth === 640))).toBe(true);
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await expect(page.getByRole("link", { name: "下载可编辑 .blend" })).toBeVisible();
  await expect(page.locator(".data-table tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: /记录反馈：Blender 相机可见性/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"], 150_000);
  const latest = await (await page.request.get("/api/state")).json();
  const mine = latest.scenes.filter((s: { projectId: string }) => s.projectId === latest.projects.at(-1).id);
  expect(mine.map((s: { verdict: string }) => s.verdict).sort()).toEqual(["accepted-static-scene", "rejected"]);
  expect(latest.feedback.at(-1).status).toBe("closed");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /Blender 场景 带遮挡候选布局 场景检查拒绝/ }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("blender-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("blender-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("AI assistant plan runs native Blender live in the professional viewport", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await expect(assistant).toBeVisible();
  await assistant.getByRole("button", { name: "规则", exact: true }).click();
  await assistant.locator("#studio-input").fill("生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const card = assistant.getByRole("article", { name: /计划 Blender 原生场景/ });
  await expect(assistant.getByText("规则解析 · 无模型调用").first()).toBeVisible();
  await expect(card.getByText("— → occluded")).toBeVisible();
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("heading", { name: "原生验证", level: 1 })).toBeVisible();
  const viewport = page.locator(".viewport");
  // Geometry must appear while the native run is still live, not only after completion.
  await expect.poll(async () => (await viewport.getAttribute("data-objects")) !== "0" && await page.locator(".viewport .live-dot.on").count() === 1,
    { timeout: 120_000 }).toBe(true);
  await expect(page.getByLabel("实时工具步骤").first().getByText("Blender 基准场景（无遮挡）")).toBeVisible();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 200_000 });
  await expect(viewport).toHaveAttribute("data-webgl", "ok");
  await expect(viewport).toHaveAttribute("data-ray", "blocked");
  await expect(viewport).toHaveAttribute("data-objects", "7");
  await expect(page.getByText("原生射线首个命中：Visibility obstruction · 被遮挡")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Cycles 渲染采样" })).toHaveAttribute("aria-valuenow", "12");
  await page.getByRole("button", { name: "顶视" }).click();
  await page.getByRole("slider", { name: "构建阶段时间轴" }).fill("0");
  await expect(viewport).toHaveAttribute("data-stage", "1");
  await expect.poll(() => viewport.getAttribute("data-objects")).toBe("1");
  await page.getByRole("button", { name: "基准布局" }).click();
  await expect(viewport).toHaveAttribute("data-ray", "target");
  const latest = await (await page.request.get("/api/state")).json();
  const plan = latest.assistantPlans.at(-1);
  expect(plan.authority).toBe("none"); expect(plan.model.used).toBe(false);
  expect(plan.confirmations.find((c: { recordKind: string }) => c.recordKind === "scene-review").match).toBe("as-proposed");
  await page.screenshot({ path: testInfo.outputPath("studio-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("studio-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("factory criteria are frozen first; real Factory Twin seeds stay failed through feedback", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "规则", exact: true }).click();
  await assistant.locator("#studio-input").fill("评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C");
  await page.keyboard.press("Control+Enter");
  const review = assistant.getByRole("article", { name: /计划 导入已复核/ });
  await review.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("alert")).toContainText("请先确认前置计划");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.getByRole("article", { name: "计划 先冻结工厂验收标准" }).getByRole("button", { name: "确认执行" }).click();
  await expect(assistant.getByRole("article", { name: "计划 先冻结工厂验收标准" }).getByText(/已执行/)).toBeVisible();
  await review.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("heading", { name: "维护方案拒绝" })).toBeVisible();
  await expect(page.locator(".seed-table tbody tr")).toHaveCount(12);
  await expect(page.locator(".seed-table td.fail")).toHaveCount(3);
  await expect(page.locator(".cases li")).toHaveCount(3);
  await page.getByRole("button", { name: /记录反馈：工厂 seed 10/ }).click();
  await advance(page, ["记录复现", "分配处理", "记录保留原因", "复测保留方案", "关闭已复测反馈"], 30_000);
  await page.getByRole("button", { name: /全部/ }).click();
  await expect(page.locator(".run-list").getByText(/工厂 · seed 10 · EV 充电服务/)).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  const f = state.feedback.find((x: { evidenceKind: string }) => x.evidenceKind === "factory-twin");
  expect(f.status).toBe("closed");
  expect(state.factoryReviews.every((r: { verdict: string; physicalValidation: boolean }) => r.verdict === "rejected" && r.physicalValidation === false)).toBe(true);
  await rail(page, /需求冻结/).click();
  await expect(page.locator("#factory-criteria tbody tr")).toHaveCount(1);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.keyboard.type("工厂");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "工厂孪生" })).toHaveAttribute("aria-selected", "true");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /工厂孪生 .* 维护方案拒绝/ }).first().click();
  await page.screenshot({ path: testInfo.outputPath("factory-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("factory-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("parametric CAD part: live B-Rep build, measured DFM failure, drawings and restored-parameter recheck", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad) throw new Error("Native CadQuery is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  // Choose a non-default option first so a dead hit target cannot pass silently.
  await page.getByRole("radio", { name: /紧凑化/ }).check();
  await expect(page.getByRole("radio", { name: /紧凑化/ })).toBeChecked();
  await page.locator(".option", { hasText: "止口孔偏小" }).click();
  await expect(page.getByRole("radio", { name: /止口孔偏小/ })).toBeChecked();
  await page.getByRole("radio", { name: /轻量化/ }).check();
  await expect(page.getByRole("radio", { name: /轻量化/ })).toBeChecked();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  const viewport = page.locator(".viewport");
  await expect.poll(async () => (await viewport.getAttribute("data-objects")) !== "0" && await page.locator(".viewport .live-dot.on").count() === 1,
    { timeout: 120_000 }).toBe(true);
  await expect(page.getByText("LIVE · CadQuery 原生构建中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  await expect(viewport).toHaveAttribute("data-objects", "2");
  await expect(page.locator(".outliner").getByText("NEMA 17 motor")).toBeVisible();
  // CAD checks are a measured table; a failed row carries the rule name and an "ask AI" action.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("最小壁厚");
  // ~85 kB SVG drawings decode after the native run; allow for a loaded CI runner.
  await expect.poll(() => page.locator(".drawings img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)),
    { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  const step = await page.request.get(await page.getByRole("link", { name: "下载可编辑 STEP" }).getAttribute("href") as string);
  expect(step.status()).toBe(200); expect((await step.text()).startsWith("ISO-10303-21")).toBe(true);
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"], 180_000);
  const latest = await (await page.request.get("/api/state")).json();
  const mine = latest.cads.filter((c: { projectId: string }) => c.projectId === latest.projects.at(-1).id);
  expect(mine.map((c: { verdict: string }) => c.verdict).sort()).toEqual(["accepted-cad-part", "rejected"]);
  expect(latest.feedback.at(-1).status).toBe("closed");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /CAD 零件 NEMA 17 支架 · 轻量化 零件检查拒绝/ }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cad-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("cad-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("release gate: blocked until failures are closed, approval, compare matrix and supersession by a new requirement version", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad) throw new Error("Native CadQuery is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /发布交付/).click();
  await expect(page.getByText("还没有可发布的检查")).toBeVisible();
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  await rail(page, /反馈复测/).click();
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测"], 180_000);
  // Passing recheck exists but its feedback is still open: admission must block the release.
  await rail(page, /发布交付/).click();
  const gate = page.getByLabel("发布准入检查");
  await expect(gate.locator(".check-item.fail")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "创建发布候选" })).toBeDisabled();
  await gate.getByRole("button", { name: "处理反馈" }).click();
  await advance(page, ["关闭已复测反馈"]);
  await rail(page, /发布交付/).click();
  await expect(gate.locator(".check-item.fail")).toHaveCount(0);
  await expect(gate.locator(".check-item.pass")).toHaveCount(5);
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await expect(page.getByRole("button", { name: "批准发布 R1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /成熟度：R1 待审批/ })).toBeVisible();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  await expect(rail(page, /发布交付/)).toHaveClass(/s-done/);
  await expect(page.locator(".release-history tbody tr")).toHaveCount(1);
  await rail(page, /原生验证/).click();
  const compare = page.locator("#compare");
  await expect(compare.locator("thead th")).toHaveCount(3);
  await expect(compare.locator("td.fail")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("release-compare.png"), fullPage: true });
  await rail(page, /需求冻结/).click();
  await page.getByRole("button", { name: "修订需求" }).click();
  await page.getByRole("combobox", { name: "样本最低成功率" }).selectOption("0.7");
  await page.getByRole("button", { name: "保存为 v2" }).click();
  await expect(page.locator(".versions li")).toHaveCount(2);
  await expect(page.locator(".diff td.del")).toHaveText("50%");
  await expect(page.locator(".diff td.add")).toHaveText("70%");
  await expect(page.getByRole("button", { name: /成熟度：设计中/ })).toBeVisible();
  await rail(page, /发布交付/).click();
  await expect(page.locator(".release-history").getByText("已废止")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("release-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await expect(page.getByRole("contentinfo", { name: "状态栏" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("release-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("AI engine: Kiro fallback receipt, cited answer, validated plan, reconciliation gate", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { writeFile } = await import("node:fs/promises");
  const spec = (o: unknown) => writeFile(".state/browser/fake-executor.json", JSON.stringify(o));
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  // The two intended 409 rejections surface as toasts; Chrome also logs them as resource errors.
  page.on("console", m => { if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "AI 引擎", exact: true }).click();
  const out = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
  await spec({ attempts: [{ profile: "kiro-primary", status: "failed", errorKind: "quota" }, { profile: "kiro-backup", status: "succeeded", answer: out({
    kind: "plan", interpretation: ["保持壁厚 3 mm，复测紧凑化方案"], answer: { text: "cad-1 因最小壁厚 2.5 mm < 3 mm 被拒绝。", citations: ["cad-1"] },
    plans: [{ ref: "p1", tool: "cad-review", title: "复测紧凑化方案", payload: { variant: "compact" } }, { ref: "p2", tool: "approve-release", payload: {} }] }) }] });
  await assistant.locator("#studio-input").fill("为什么轻量化被拒绝？给出复测方案");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const fallback = assistant.getByRole("list", { name: "引擎回退链" }).last();
  await expect(fallback).toContainText("Kiro 主账号 · 额度不足");
  await expect(fallback).toContainText("Kiro 备用账号 ✓");
  await expect(assistant.getByText("Kiro 备用账号 · claude-opus-5.5").last()).toBeVisible();
  await expect(assistant.getByText(/已拒绝 AI 计划 p2（approve-release）/)).toBeVisible();
  // Answer bubbles, citations and plan cards stack in normal flow; none overlaps another.
  const overlaps = await assistant.locator(".chat-timeline").evaluate(el => {
    el.scrollTop = el.scrollHeight;
    if ([...el.querySelectorAll("*")].some(n => ["sticky", "fixed"].includes(getComputedStyle(n).position))) return true;
    const boxes = [...el.querySelectorAll(".turn > *")].map(n => n.getBoundingClientRect()).filter(r => r.height > 0);
    return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.bottom - 1 > b.top && b.bottom - 1 > a.top));
  });
  expect(overlaps).toBe(false);
  const cite = assistant.getByRole("group", { name: "引用的记录" }).last().getByRole("button", { name: /CAD 零件 · lightweight/ });
  await cite.click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible();
  const card = assistant.getByRole("article", { name: "计划 复测紧凑化方案" });
  await expect(card.getByText("— → compact").or(card.getByText("lightweight → compact"))).toBeVisible();
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 180_000 });
  // An answer whose native effects are unverified blocks plans and further AI runs until reconciled.
  await spec({ action: "reconcile", reason: "effects unknown", attempts: [{ profile: "claude", status: "succeeded", effects: "unknown", model: "default", version: "0.84.0",
    answer: out({ kind: "plan", plans: [{ ref: "p1", tool: "robot-review", title: "相机偏移记录评审", payload: { candidate: "camera" } }] }) }] });
  await assistant.locator("#studio-input").fill("再评一次相机偏移");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByRole("group", { name: "核对引擎影响" })).toBeVisible();
  const reviewsBefore = (await (await page.request.get("/api/state")).json()).reviews.length;
  await assistant.getByRole("article", { name: "计划 相机偏移记录评审" }).getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  expect((await (await page.request.get("/api/state")).json()).reviews.length, "an unreconciled plan must not start a native run").toBe(reviewsBefore);
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.locator("#studio-input").fill("还有别的吗");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.getByRole("button", { name: "记录核对结果" }).click();
  await expect(assistant.getByText(/已核对 · local-maintainer/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-desktop.png") });
  const state = await (await page.request.get("/api/state")).json();
  // Only this test's project: other specs share the server and also create model runs.
  const mine = state.projects.at(-1).id;
  const runs = state.assistantPlans.filter((p: { source?: string; projectId?: string }) => p.source === "model" && p.projectId === mine);
  expect(runs.map((p: { state: string }) => p.state)).toEqual(["done", "reconcile"]);
  expect(runs.every((p: { authority: string }) => p.authority === "none")).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("MCP: an external agent reads the workspace and proposes; only the maintainer's confirmation runs native CAD", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  const client = new Client({ name: "Kiro CLI", version: "2.24.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"],
    env: { PATH: process.env.PATH ?? "", PAI_URL: new URL(baseURL!).origin }, stderr: "pipe" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content[0].text).toBeFalsy();
    return JSON.parse(r.content[0].text);
  };
  try {
    const projectId = (await call("pai_list_projects")).at(-1).id;
    const ws = await call("pai_get_workspace", { projectId });
    expect(Object.keys(ws.tools)).toContain("cad-review");
    const proposed = await call("pai_propose_plan", { projectId, intent: "评估紧凑化支架是否满足壁厚 3 mm",
      plans: [{ ref: "p1", tool: "cad-review", title: "紧凑化支架评审", payload: { variant: "compact" } }] });
    expect(proposed.authority).toBe("none");
    await page.reload();
    const assistant = page.getByRole("complementary", { name: "AI 助手" });
    await expect(assistant.getByText("外部 Agent · Kiro CLI")).toBeVisible();
    const card = assistant.getByRole("article", { name: "计划 紧凑化支架评审" });
    expect((await call("pai_get_plan", { planId: proposed.planId })).steps[0].confirmed).toBeNull();
    await card.getByRole("button", { name: "确认执行" }).click();
    await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 180_000 });
    const status = await call("pai_get_plan", { planId: proposed.planId });
    expect(status.steps[0].confirmed).toMatchObject({ recordKind: "cad-review", match: "as-proposed" });
    const record = await call("pai_get_record", { projectId, handle: "cad-1" });
    expect(record.id).toBe(status.steps[0].confirmed.recordId);
    expect(record.record.verdict).toBe("rejected");
    expect((await call("pai_get_admission", { projectId, handle: "cad-1" })).admissible).toBe(false);
    // The backend receipt precedes the UI refresh/final GLB handoff. Check the
    // completed visible result before resizing the still-streaming viewport.
    await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".viewport-hud.top-left")).toContainText("最终 GLB（摘要已核验）", { timeout: 60_000 });
  } finally { await client.close(); }
  // The overview keeps a measured track record of the agent: its executed proposal was rejected by the native checks.
  await rail(page, /项目总览/).click();
  const track = page.getByRole("region", { name: "AI Kiro CLI (MCP)" });
  await expect(track.getByText("通过 · 否决").locator("..")).toContainText("0 · 1");
  await expect(track.getByText("已执行 / 提案").locator("..")).toContainText("1 / 1");
  await expect(page.getByRole("list", { name: "最近执行的 AI 提案" })).toContainText("被否决");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("AI autonomy from the overview: grant, autopilot round judged by native CAD, track record, revoke, phone width", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["先确认基准支架满足冻结要求"], plans: [{ ref: "p1", tool: "cad-review", title: "基准支架评审", rationale: "不放宽任何要求", payload: { variant: "reference" } }] }) + "\n```" }] }));
  await rail(page, /项目总览/).click();
  const card = page.getByRole("region", { name: "AI 自主迭代" });
  await expect(card.getByRole("button", { name: "让 AI 自主迭代" })).toHaveCount(0);
  await card.getByRole("checkbox", { name: "AI 写 CadQuery 代码" }).uncheck();
  await card.getByRole("spinbutton", { name: "最多运行次数" }).fill("2");
  await card.getByRole("button", { name: "签发授权" }).click();
  const grants = card.getByRole("list", { name: "有效授权" });
  await expect(grants).toContainText("CAD 零件评审"); await expect(grants).toContainText("已用 0 / 2 次");
  await card.getByRole("textbox", { name: "目标" }).fill("确认基准支架在冻结要求下通过全部原生检查，不放宽任何要求");
  await card.getByRole("button", { name: "让 AI 自主迭代" }).click();
  const run = card.getByRole("region", { name: "最近一次自主迭代" });
  await expect(run).toContainText("目标达成", { timeout: 240_000 });
  await expect(run).toContainText("原生检查通过");
  await expect(grants).toContainText("已用 1 / 2 次");
  // The executed proposal now counts in the agent's measured track record.
  await expect(page.getByText("通过 · 否决").first().locator("..")).toContainText("1 · 0");
  await expect(page.getByText("授权内自主").first().locator("..")).toContainText("1");
  // An engine whose effects the executor cannot verify stops the loop for a human; the maintainer records why it is
  // safe and runs the same proposal under the grant from this card.
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ action: "reconcile", reason: "native effects remain unverified", attempts: [{ profile: "codex", status: "succeeded",
    effects: "unknown", model: "global.openai.gpt-6-astra", answer: "```json\n" + JSON.stringify({ kind: "plan", interpretation: ["紧凑化支架复核"],
      plans: [{ ref: "p1", tool: "cad-review", title: "紧凑化支架评审", rationale: "不放宽任何要求", payload: { variant: "compact" } }] }) + "\n```" }] }));
  await card.getByRole("textbox", { name: "目标" }).fill("复核紧凑化支架是否满足全部冻结要求，不放宽任何要求");
  await card.getByRole("button", { name: "让 AI 自主迭代" }).click();
  await expect(run).toContainText("需要人工处理", { timeout: 60_000 });
  const resume = card.getByRole("group", { name: "核对后继续" });
  await expect(resume).toContainText("紧凑化支架评审");
  await resume.getByRole("textbox", { name: "核对理由" }).fill("回执显示没有工具活动，只读模式");
  await resume.getByRole("button", { name: "记录核对并在授权内执行" }).click();
  // The card follows the native record until it settles, then confirms.
  await expect(page.getByText("已记录核对理由，并在授权内执行了 AI 的提案；结论由原生检查给出。")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("heading", { name: /零件检查(通过|拒绝)/ })).toBeVisible();
  await rail(page, /项目总览/).click();
  // Both granted runs are used, so the grant is no longer active and the card offers a new one.
  await expect(card.getByRole("button", { name: "签发授权" })).toBeVisible();
  // The track record keeps each engine apart: the resumed Codex proposal ran under the grant too.
  const codex = page.getByRole("region", { name: "AI global.openai.gpt-6-astra · codex" });
  await expect(codex.getByText("授权内自主").locator("..")).toContainText("1");
  await expect(codex.getByText("已执行 / 提案").locator("..")).toContainText("1 / 1");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await writeFile(".state/browser/fake-executor.json", "{}");
  expect(errors).toEqual([]);
});

test("generated CadQuery code: policy check, sandboxed build, native failure, recheck with revised code; AI code plan", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad?.generatedCode?.available) throw new Error(`Sandbox required: ${state.capabilities.cad?.generatedCode?.reason}`);
  const template: string = state.capabilities.cad.generatedCode.template;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  // The intended policy rejection surfaces as a toast; Chrome also logs it as a resource error.
  page.on("console", m => { if (m.type() === "error" && !/status of 422/.test(m.text())) errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("radio", { name: /生成代码/ }).check();
  const editor = page.getByRole("textbox", { name: /CadQuery 代码/ });
  await expect(editor).toHaveValue(template);
  await editor.fill(template.replace("import cadquery as cq", "import cadquery as cq\nimport os"));
  await page.getByRole("button", { name: "检查代码策略" }).click();
  await expect(page.locator(".violations")).toContainText("发现 os");
  await editor.fill(template.replace("T = 4.0 ", "T = 2.5 "));
  await page.getByRole("button", { name: "检查代码策略" }).click();
  await expect(page.getByText("符合沙箱策略")).toBeVisible();
  await page.getByRole("button", { name: "在沙箱中运行并检查" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 240_000 });
  // CAD checks are a measured table; a failed row carries the rule name and an "ask AI" action.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("最小壁厚");
  await expect(page.locator(".code-source summary")).toContainText("沙箱结果 已生成实体");
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案"]);
  await page.getByRole("button", { name: "修订代码并复测", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "反馈复测" })).toBeVisible();
  await expect(editor).toHaveValue(template.replace("T = 4.0 ", "T = 2.5 "));
  await editor.fill(template.replace("T = 4.0 ", "T = 3.5 "));
  await page.getByRole("button", { name: "提交修订代码并复测" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 240_000 });
  await expect.poll(async () => (await (await page.request.get("/api/state")).json()).feedback.at(-1).status, { timeout: 30_000 }).toBe("rechecked");

  // An AI-written code plan: shown as code, refused parts listed, executed only on confirmation.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({ kind: "plan", plans: [
    { ref: "p1", tool: "cad-code", title: "AI 生成：加宽底板", payload: { code: template.replace("W = 60.0 ", "W = 64.0 ") } },
    { ref: "p2", tool: "cad-code", title: "越权", payload: { code: template + "\nx = open('/etc/passwd')\n" } }] }) + "\n```" }] }));
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "AI 引擎", exact: true }).click();
  await assistant.locator("#studio-input").fill("写一个加宽底板的支架代码");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByText(/已拒绝 AI 计划 p2（cad-code）：代码不符合沙箱策略/)).toBeVisible({ timeout: 60_000 });
  const card = assistant.getByRole("article", { name: "计划 AI 生成：加宽底板" });
  await card.getByText("查看生成的 CadQuery 代码").click();
  await expect(card.locator("pre.code")).toContainText("W = 64.0");
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 240_000 });
  await page.screenshot({ path: testInfo.outputPath("cad-code-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("design-space sweep: native points on a scatter, lightest feasible point becomes a normal accepted candidate", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  const panel = page.locator(".card", { has: page.getByRole("heading", { name: "设计空间扫描" }) });
  await panel.getByRole("textbox", { name: /板厚 t/ }).fill("2.5, 3, 4");
  await panel.getByRole("textbox", { name: /宽度 W/ }).fill("60");
  await panel.getByRole("textbox", { name: /安装板高度 H/ }).fill("46");
  await expect(panel.getByText(/^3 个点/)).toBeVisible();
  await panel.getByRole("button", { name: "运行扫描" }).click();
  await expect(panel.getByRole("group", { name: "质量与最小壁厚散点图" })).toBeVisible({ timeout: 240_000 });
  await expect(panel.getByText(/3 个点中 2 个满足全部 7 项检查/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /点 \d：t=2.5 .*未通过 最小壁厚/ })).toBeVisible();
  // Default selection is the lightest feasible point; keyboard selection works on the plot.
  await expect(panel.locator(".sweep-pick")).toContainText("t=3 · W=60 · H=46");
  await panel.getByRole("button", { name: /点 \d：t=4 / }).press("Enter");
  await expect(panel.locator(".sweep-pick")).toContainText("t=4");
  await panel.getByRole("button", { name: /点 \d：t=3 / }).click();
  await panel.getByRole("button", { name: "以此参数生成正式候选" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 240_000 });
  const state = await (await page.request.get("/api/state")).json();
  const cad = state.cads.at(-1);
  expect(cad.request).toMatchObject({ variant: "parametric", parameters: { thickness: 3, width: 60, plateHeight: 46 } });
  expect(cad.request.fromSweep.sweepId).toBe(state.cadSweeps.at(-1).id);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await expect(panel.getByRole("button", { name: "查看已生成的候选 →" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: /板厚 t/ })).toHaveValue("2.5, 3, 4");
  await expect(panel.getByText(/^3 个点/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sweep-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("factory production line: native Blender build streams into the viewport, ray-measured rejection, animation and an AI layout fix plan", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  await createProject(page);
  await page.goto("/#/design?lane=plant");
  for (const [label, value] of [["工位数", "6"], ["工位节距", "4.5"], ["AGV 通道设计宽度", "2.4"], ["安全围栏边长", "4.2"], ["检测相机龙门高度", "2.8"], ["AGV 台数", "3"]]) {
    await page.getByLabel(label, { exact: true }).fill(value, { timeout: 15_000 });
  }
  await expect(page.locator(".plant-estimate")).toContainText("626 m²");
  await page.getByRole("button", { name: "生成并检查工厂产线" }).click();
  await expect(page.getByLabel("实时工具步骤").first().getByText("Blender 参考产线（4 工位）")).toBeVisible({ timeout: 60_000 });
  const viewport = page.locator(".viewport");
  await expect(viewport).toHaveAttribute("data-stage", "8", { timeout: 300_000 });
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 600_000 });
  const row = page.locator(".check-table tr.fail");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("AGV 通道净宽"); await expect(row).toContainText("2.08"); await expect(row).toContainText("≥ 2.4");
  await expect(page.locator(".viewport-hud.bottom-left")).toContainText("6/6");
  await expect(viewport).not.toHaveAttribute("data-animations", "0", { timeout: 30_000 });
  await page.getByRole("button", { name: "▶ 播放产线动画" }).click();
  await expect(viewport).toHaveAttribute("data-playing", "true");
  for (const name of ["候选产线原生 Cycles 渲染", "参考产线原生 Cycles 渲染"]) {
    await expect.poll(() => page.getByRole("img", { name }).evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(400);
  }
  await expect.poll(() => page.locator(".plant-renders img").nth(1).evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(300);
  await page.screenshot({ path: testInfo.outputPath("plant-desktop.png") });
  // The failing measurement becomes a typed AI plan; the scripted executor stands in for the model.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["4.2 m 围栏比参考围栏宽 0.6 m，挤占 0.3 m 通道"],
    answer: { text: "scene-1 的通道净宽实测 2.08 m < 2.4 m。把设计通道加宽到 2.8 m，占地 641.6 m² 仍 ≤ 650 m²。", citations: ["scene-1"] },
    plans: [{ ref: "p1", tool: "plant-layout", title: "加宽 AGV 通道复测", payload: { layout: { stations: 6, stationPitch: 4.5, aisleWidth: 2.8, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 } } }] }) + "\n```" }] }));
  await row.getByRole("button", { name: /问 AI：AGV 通道净宽为什么未通过/ }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await expect(assistant.locator("#studio-input")).toHaveValue(/AGV 通道净宽.*2\.08/);
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const card = assistant.getByRole("article", { name: "计划 加宽 AGV 通道复测" });
  await expect(card.getByText("2.4 → 2.8")).toBeVisible();
  await expect(assistant.getByRole("group", { name: "引用的记录" }).last()).toContainText("Blender 场景 · plant");
  await card.getByRole("button", { name: "在专业面板调整" }).click();
  await expect(page.getByLabel("AGV 通道设计宽度", { exact: true })).toHaveValue("2.8");
  await expect(page.locator(".plant-estimate")).toContainText("642 m²");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/validate?kind=blender-scene");
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("plant-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("physics lanes: FEA stress view on a CAD review and a MuJoCo robot cell with paired seeds", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.physics) throw new Error("The pinned physics toolchain is required for this integration check");
  await createProject(page);
  await page.goto("/#/design?lane=robotcell");
  await page.getByLabel("关节速度", { exact: true }).fill("75");
  await page.getByLabel("围栏离最远工位", { exact: true }).fill("0.12");
  await page.getByLabel("节拍上限", { exact: true }).fill("5");
  await page.getByRole("button", { name: "仿真并检查工作单元" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 300_000 });
  const fail = page.locator(".check-table tr.fail");
  await expect(fail.filter({ hasText: "运动无碰撞" })).toHaveCount(1);
  await expect(page.locator(".viewport")).toHaveAttribute("data-objects", /[1-9]/, { timeout: 60_000 });
  await expect(page.getByRole("table", { name: "配对种子（同一来料偏差）" }).locator("tbody tr")).toHaveCount(10);
  await page.screenshot({ path: testInfo.outputPath("robot-cell.png") });
  await page.goto("/#/design?lane=cad");
  await page.getByRole("radio", { name: /参数化/ }).check();
  await page.getByLabel("板厚 t", { exact: true }).fill("3");
  await page.getByLabel("冻结结构要求并做 FEA").check();
  await expect(page.getByLabel("电机轴挠度上限", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: /零件检查(通过|拒绝)/ })).toBeVisible({ timeout: 600_000 });
  await expect(page.locator(".check-table")).toContainText("轴心挠度（FEA）");
  // Geometry accepts t = 3 mm; only the native FEA rejects it.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("轴心挠度（FEA）");
  await expect(page.getByRole("group", { name: "FEA 结果" })).toContainText("CalculiX");
  await expect(page.locator(".viewport")).toHaveAttribute("data-objects", /[1-9]/, { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("fea-view.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("robot cell closed loop in the UI: MuJoCo rejection, fixed cell, feedback recheck, release and a signed package", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.physics) throw new Error("The pinned physics toolchain is required for this integration check");
  await createProject(page);
  const runCell = async (guard: string) => {
    await page.goto("/#/design?lane=robotcell");
    await page.getByLabel("关节速度", { exact: true }).fill("75");
    await page.getByLabel("围栏离最远工位", { exact: true }).fill(guard);
    await page.getByLabel("节拍上限", { exact: true }).fill("5");
    await page.getByRole("button", { name: "仿真并检查工作单元" }).click();
  };
  await runCell("0.12");
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 300_000 });
  await page.getByRole("button", { name: /记录反馈：MuJoCo 运动无碰撞/ }).click();
  await expect(page.getByRole("heading", { name: "反馈复测", level: 1 })).toBeVisible();
  await advance(page, ["记录复现", "分配处理", "提出回退方案"]);
  // No accepted fix yet: the recheck refuses instead of inventing one.
  await page.getByRole("button", { name: "按修正方案复测", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("先提交并通过一个修正方案");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await runCell("0.3");
  await expect(page.getByRole("heading", { name: "静态场景检查通过" })).toBeVisible({ timeout: 300_000 });
  await rail(page, /反馈复测/).click();
  await page.locator(".run-list .run").first().click();
  await advance(page, ["按修正方案复测", "关闭已复测反馈"], 300_000);
  await rail(page, /发布交付/).click();
  await expect(page.getByLabel("发布准入检查").locator(".check-item.pass")).toHaveCount(5);
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  const link = page.getByRole("link", { name: "下载签名发布包" });
  await expect(link).toBeVisible();
  const pkg = await (await page.request.get(await link.getAttribute("href") as string)).json();
  const key = await (await page.request.get("/api/signing/public-key")).json();
  const verified = await (await page.request.post("/api/packages/verify", { data: { package: pkg, trustedPublicKeyPem: key.publicKeyPem } })).json();
  expect(verified.valid).toBe(true); expect(verified.signer.trusted).toBe(true);
  expect(Object.keys(pkg.files)).toContain("candidate/scene.xml");
  await page.getByRole("button", { name: "核验签名" }).click();
  await expect(page.getByRole("status").filter({ hasText: "签名有效" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("robot-release.png") });
  expect(errors).toEqual([]);
});

test("aerodynamics lane: form submits the typed request and the API refuses an out-of-range body", async ({ page }) => {
  const state = await (await page.request.get("/api/state")).json();
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "车身气动" }).click();
  if (!state.capabilities.aero) {
    // Without a pinned OpenFOAM image the lane says so and offers no solve button (fail closed, no fabricated result).
    await expect(page.getByText(/未配置 OpenFOAM/)).toBeVisible();
    await expect(page.getByRole("button", { name: "求解并检查车身" })).toHaveCount(0);
  } else {
    // Intercept the solve: this browser check covers the form and request contract; npm run test:aero covers OpenFOAM.
    let sent: Record<string, unknown> | undefined;
    await page.route("**/api/projects/*/aero", route => { sent = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: "TEST_INTERCEPT", message: "intercepted" } }); });
    await page.getByLabel("后斜角", { exact: true }).fill("12.5");
    await page.getByRole("button", { name: "求解并检查车身" }).click();
    await expect.poll(() => sent?.parameters).toEqual({ slantAngleDeg: 12.5, noseRadius: 0.1, length: 1.044, height: 0.288 });
    expect(sent?.requirements).toEqual(state.capabilities.aero.defaultRequirements);
  }
  const project = (await (await page.request.get("/api/state")).json()).projects.at(-1);
  const bad = await page.request.post(`/api/projects/${project.id}/aero`, { data: { requestId: crypto.randomUUID(), projectRevision: project.revision,
    parameters: { slantAngleDeg: 60, noseRadius: 0.1, length: 1.044, height: 0.288 } }, headers: { origin: new URL(page.url()).origin } });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
});

test("expired hosted login: an API call redirected to the identity provider signs in again with a top-level navigation, nothing runs", async ({ page }) => {
  // What the ALB does when the session cookie has expired: redirect to Cognito before forwarding the request.
  let posted = 0;
  await page.route("**/api/projects", route => { posted++; return route.fulfill({ status: 302, headers: { location: "https://idp.example.invalid/oauth2/authorize" } }); });
  await page.goto("/#/requirements?new=1");
  await expect(page.getByRole("button", { name: "创建评审任务" })).toBeVisible();
  const navigation = page.waitForRequest(r => r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).pathname === "/");
  await page.getByRole("button", { name: "创建评审任务" }).click();
  await navigation; // the tab reloads, so the ALB starts a fresh login with a valid state cookie
  expect(posted).toBe(1); // no automatic replay of the redirected request
  await expect(page.getByRole("button", { name: "创建评审任务" })).toBeVisible();
});

test("artifact platform: build, benchmark, release, configure a workflow, run with the real solver, approval and rejections, phone width", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // Unique version per run: versions are immutable and the browser state directory persists between runs.
  const n = Date.now() % 100_000, ref = `logistics-pdptw@1.${Math.floor(n / 1000)}.${n % 1000}`;
  await page.goto("/#/artifacts");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("决策算法与物理 AI 孪生");
  // Decision algorithms and the twin come first: first rail entry, twin comparison and catalogue above the registry.
  await expect(page.getByRole("navigation", { name: "生命周期" }).getByRole("link").first()).toHaveAccessibleName(/决策算法与孪生/);
  await expect(page.getByRole("region", { name: "场地孪生" })).toContainText("传感器触发重排");
  const order = await page.locator("main .card").evaluateAll(cards => cards.map(c => c.getAttribute("aria-label")));
  expect(order.indexOf("场地孪生")).toBeLessThan(order.indexOf("制品库"));
  expect(order.indexOf("流程运行")).toBeLessThan(order.indexOf("制品库"));
  await expect(page.getByRole("region", { name: "设计评估吞吐" })).toContainText("原生求解");
  await page.getByLabel("从可信源构建 logistics-pdptw 版本").fill(ref.split("@")[1]);
  await advance(page, ["构建草稿"]);
  const row = page.getByRole("list", { name: "制品版本" }).getByRole("listitem").filter({ hasText: ref });
  await expect(row.getByText("草稿")).toBeVisible();
  // A workflow cannot pin a draft.
  const definition = (version: number, extra: Record<string, unknown> = {}) => JSON.stringify({ schema: "pai-workflow-1", name: "offsite-delivery-plan", version, title: "场外配送计划",
    inputs: { problem: { schema: "pai-logistics-problem-1" } }, nodes: [
      { id: "solve", type: "artifact", artifact: ref, operation: "solve", inputs: { problem: "$input.problem" }, params: { timeLimitSeconds: 10 }, ...extra },
      { id: "verify", type: "artifact", artifact: ref, operation: "verify", inputs: { problem: "$input.problem", plan: "$solve.plan" } },
      { id: "gate", type: "condition", status: "$verify", pass: ["feasible-plan"] },
      { id: "dispatcher", type: "approval", prompt: "调度员确认", after: ["gate"] }],
    outputs: { plan: "$solve.plan" } }, null, 2);
  const editor = page.getByLabel("流程定义 JSON");
  await editor.fill(definition(n));
  await advance(page, ["校验"]);
  await expect(page.getByText(/未通过：.*draft/)).toBeVisible();
  await row.getByRole("button", { name: "运行验收基准" }).click();
  await expect(row.getByText("已验收")).toBeVisible({ timeout: 120_000 });
  page.once("dialog", d => void d.accept("基准通过，范围限合成实例"));
  await row.getByRole("button", { name: "发布" }).click();
  await expect(row.getByText("已发布")).toBeVisible();
  // Schema error: an unknown field (no blind retries in this contract) is refused before anything runs.
  await editor.fill(definition(n, { retries: 3 }));
  await advance(page, ["校验"]);
  await expect(page.getByText(/未通过：.*retries/)).toBeVisible();
  await editor.fill(definition(n));
  await advance(page, ["校验"]);
  await expect(page.getByText("执行顺序 solve → verify → gate → dispatcher")).toBeVisible();
  await advance(page, ["保存流程版本"]);
  await advance(page, ["用合成实例运行"]);
  const run = page.locator("details.run-detail").first();
  await expect(run.getByText("待人工确认")).toBeVisible();
  await expect(run.getByRole("list", { name: "独立核验" }).getByText("先取后送、同一辆车")).toBeVisible();
  await expect(run.getByRole("row", { name: /solve/ }).getByText("无模型调用")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("artifacts-run-390.png"), fullPage: true });
  await noOverflow(page);
  page.once("dialog", d => void d.accept("调度员核对后确认（合成实例）"));
  await run.getByRole("button", { name: "确认 dispatcher" }).click();
  await expect(run.locator("summary").getByText("完成")).toBeVisible();
  // Infeasible business input: an order heavier than any vehicle. The run ends rejected with the reason; no approval asked.
  await page.getByLabel("合成实例").selectOption("overload");
  await advance(page, ["用合成实例运行"]);
  const rejected = page.locator("details.run-detail").first();
  await rejected.locator("summary").click();
  await expect(rejected.getByText(/原因：gate: verify is no-plan/)).toBeVisible();
  await expect(rejected.getByRole("row", { name: /solve/ }).getByText("infeasible")).toBeVisible();
  await noOverflow(page);
  // The runs are history in the task switcher too: choosing one opens it on this page, expanded and outlined.
  const firstRun = (await (await page.request.get("/api/v1/workflow-runs")).json() as { id: string; workflowId: string; createdAt: string }[])
    .filter(r => r.workflowId === `offsite-delivery-plan@${n}`).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  await page.goto("/#/overview"); await page.reload();
  await page.getByRole("button", { name: /^选择已有任务：/ }).click();
  await page.getByRole("combobox", { name: /搜索任务/ }).fill(firstRun.id.slice(0, 8));
  const option = page.getByRole("listbox", { name: "任务" }).getByRole("option");
  await expect(option).toHaveCount(1);
  await expect(option).toContainText("场外物流规划");
  await expect(page.locator(".sw-group").first()).toContainText("流程运行");
  await option.click();
  await expect(page).toHaveURL(new RegExp(`#/artifacts\\?run=${firstRun.id}`));
  await expect(page.locator(`#run-${firstRun.id}`)).toHaveAttribute("open", "");
  await expect(page.locator(`#run-${firstRun.id}.focused`)).toBeVisible();
  await noOverflow(page);
  // Unauthorised write: a cross-origin request cannot create artifacts or runs.
  const cross = await page.request.post("/api/v1/artifacts", { data: { adapter: "logistics-pdptw", version: "9.9.9" }, headers: { origin: "https://attacker.example" } });
  expect(cross.status()).toBe(403);
});

test("site admission artifact: CP-SAT benchmark, release, sample workflow, peak run with the real solver, controller approval, phone width", { tag: "@cam" }, async ({ page }, testInfo) => {
  // Tagged with the long-running group: the acceptance benchmark solves several CP-SAT instances.
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const n = Date.now() % 100_000, ref = `yard-admission@1.${Math.floor(n / 1000)}.${n % 1000}`;
  await page.goto("/#/artifacts");
  await page.getByLabel("制品族").selectOption("yard-admission");
  await page.getByLabel("从可信源构建 yard-admission 版本").fill(ref.split("@")[1]);
  await advance(page, ["构建草稿"]);
  const row = page.getByRole("list", { name: "制品版本" }).getByRole("listitem").filter({ hasText: ref });
  await row.getByRole("button", { name: "运行验收基准" }).click();
  await expect(row.getByText("已验收")).toBeVisible({ timeout: 480_000 });
  page.once("dialog", d => void d.accept("基准通过，范围限合成场地"));
  await row.getByRole("button", { name: "发布" }).click();
  await expect(row.getByText("已发布")).toBeVisible();
  await page.getByRole("button", { name: "用该制品的示例流程" }).click();
  // The sample workflow pins the latest released version; give it this run's version number.
  const editor = page.getByLabel("流程定义 JSON");
  const def = JSON.parse(await editor.inputValue()); def.version = n;
  def.nodes = def.nodes.map((x: { artifact?: string }) => x.artifact ? { ...x, artifact: ref } : x);
  await editor.fill(JSON.stringify(def, null, 2));
  await advance(page, ["校验"]);
  await expect(page.getByText("执行顺序 schedule → verify → gate → controller")).toBeVisible();
  await advance(page, ["保存流程版本"]);
  await page.getByLabel("合成实例").selectOption("peak");
  // CP-SAT has a deterministic budget, so its wall time grows with host load; allow its own wall-time cap (2 × 60 s).
  await advance(page, ["用合成实例运行"], 180_000);
  const run = page.locator("details.run-detail").first();
  await expect(run.getByText("待人工确认")).toBeVisible({ timeout: 120_000 });
  await expect(run.getByText(/入场 \d+ 辆 · 优先级分 \d+/)).toBeVisible();
  await expect(run.getByRole("table", { name: "入场安排" })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("yard-run-390.png"), fullPage: true });
  page.once("dialog", d => void d.accept("场地调度员核对后确认（合成实例）"));
  await run.getByRole("button", { name: "确认 controller" }).click();
  await expect(run.locator("summary").getByText("完成")).toBeVisible();
});
