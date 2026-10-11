// Records the yard digital-twin demo: runs native/yard_twin.py (real CP-SAT, sensor-triggered re-planning, independent
// verification), then replays its record in web/public/yard-twin.html. Every frame comes from the recorded schedules.
// Usage: node scripts/record-yard-twin.mjs [outdir]   (needs PAI_LOGISTICS_PYTHON; writes docs/media/yard-twin.{mp4,gif})
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? ".state/yard-twin-video";
await mkdir(out, { recursive: true });
const py = process.env.PAI_LOGISTICS_PYTHON;
if (!py) throw new Error("PAI_LOGISTICS_PYTHON is required (python3 tools/setup_logistics.py)");
execFileSync("python3", ["-I", "native/yard_generate.py", "--scenario", "normal", "--seed", "7", "--output", join(out, "problem.json")]);
const summary = execFileSync(py, ["native/yard_twin.py", "--problem", join(out, "problem.json"), "--output", join(out, "twin.json"), "--budget", "6"], { encoding: "utf8" });
const twin = await readFile(join(out, "twin.json"), "utf8");
for (const [p, v] of Object.entries(JSON.parse(twin).policies)) if (v.verification !== "valid-schedule") throw new Error(`${p} schedule failed verification: ${v.failed}`);
const html = (await readFile("web/public/yard-twin.html", "utf8")).replace("<script>", `<script>window.MANUAL=true;window.TWIN=${twin};</script><script>`);
await writeFile(join(out, "player.html"), html);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 640 }, recordVideo: { dir: out, size: { width: 1440, height: 640 } } });
const page = await context.newPage();
await page.goto("file://" + join(process.cwd(), out, "player.html"));
const H = await page.evaluate(() => window.HORIZON);
for (let m = 0; m <= H; m += 1) { await page.evaluate(m => window.render(m), m); await page.waitForTimeout(m % 60 === 0 ? 400 : 45); }
await page.evaluate(() => window.summary()); await page.waitForTimeout(4500);
await context.close(); await browser.close();
const webm = (await readdir(out)).find(f => f.endsWith(".webm"));
await rename(join(out, webm), join(out, "twin.webm"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, "twin.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", "docs/media/yard-twin.mp4"]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, "twin.webm"), "-vf", "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", "docs/media/yard-twin.gif"]);
await writeFile("docs/evidence/yard-twin.json", JSON.stringify({ schema: "pai-yard-twin-evidence-1", recordedAt: new Date().toISOString(), synthetic: true,
  disturbances: JSON.parse(twin).disturbances, policies: Object.fromEntries(Object.entries(JSON.parse(twin).policies).map(([k, v]) => [k, { kpi: v.kpi, verification: v.verification, replans: v.replans, events: v.events }])) }, null, 1) + "\n");
console.log(summary.trim());
