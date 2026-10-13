import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { runEngine, undeclaredPaths, type EngineCall } from "../src/kernel/engine-runtime.js";

const repo = "/opt/pai/current";
const call = (over: Partial<EngineCall>): EngineCall => ({ engine: "cad", program: "/usr/bin/python3", args: [], cwd: "/tmp", mounts: { write: ["/state/run-1"] }, timeoutMs: 1000, ...over });

test("footprint: arguments must lie in native/ or a declared mount; JSON, flags and sandbox bind lists are not paths", () => {
  assert.deepEqual(undeclaredPaths(call({ args: ["-I", `${repo}/native/cad_dfm.py`, "--output", "/state/run-1/out.json", "--requirements", "{\"a\":1}"] }), repo), []);
  assert.deepEqual(undeclaredPaths(call({ args: ["--input", "/state/other/in.json", "--x", "/state/run-10"] }), repo), ["/state/other/in.json", "/state/run-10"]);
  assert.deepEqual(undeclaredPaths(call({ args: ["--input", "/state/other/in.json"], mounts: { read: ["/state/other/in.json"], write: [] } }), repo), []);
  assert.deepEqual(undeclaredPaths(call({ args: ["/state/run-1/../../etc/passwd"] }), repo), ["/state/run-1/../../etc/passwd"]);
  assert.deepEqual(undeclaredPaths(call({ args: ["--ro-bind", "/usr", "/usr"], untrusted: true }), repo), []);
});

test("process backend runs the program unchanged and reports its runtime; an undeclared path is refused before anything runs", async () => {
  const r = await runEngine({ repository: repo }, call({ program: process.execPath, args: ["-e", "console.log(process.argv.length)"], mounts: { write: [] } }));
  assert.equal(r.exitCode, 0); assert.equal(r.stdout.trim(), "1");
  assert.deepEqual(r.runtime, { backend: "process", engine: "cad", device: "cpu" });
  await assert.rejects(runEngine({ repository: repo }, call({ program: process.execPath, args: ["-e", "1", "/etc/hostname"] })), /ENGINE_FOOTPRINT|undeclared/);
});

test("lanes execute native engines only through the engine runtime", async () => {
  // openssl sealing, the AI executor (its own runtime) and git provenance lookups are not native engines.
  const allowed = new Set(["src/adapters.ts", "src/kernel/engine-runtime.ts", "src/seal.ts", "src/controller.ts", "src/build-info.ts", "src/artifacts/native-artifact.ts"]);
  const offenders: string[] = [];
  for (const f of (await readdir("src", { recursive: true })).map(f => `src/${f}`).filter(f => f.endsWith(".ts") && !allowed.has(f))) {
    const s = await readFile(f, "utf8");
    if (/import\s*\{[^}]*\bcommand\b[^}]*\}\s*from\s*["'][./]+adapters\.js["']/.test(s) || /node:child_process/.test(s)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

const ct = { cli: "podman" as const, images: { logistics: "r.example/pai-engines@sha256:" + "a".repeat(64) }, engines: ["logistics"], toolsDir: "/var/lib/pai/data/state/tools",
  storageRoot: "/var/lib/pai/data/containers", gpu: true };

test("container backend: only switched engines; Batch clients and model-written code stay on the process backend", async () => {
  const { backendFor } = await import("../src/kernel/engine-runtime.js");
  const host = { repository: repo, engineContainer: ct };
  assert.equal(backendFor(host, call({ engine: "logistics" })), "container");
  assert.equal(backendFor(host, call({ engine: "cad" })), "process");
  assert.equal(backendFor(host, call({ engine: "logistics", network: "aws" })), "process");
  assert.equal(backendFor(host, call({ engine: "logistics", untrusted: true })), "process");
  assert.equal(backendFor({ repository: repo }, call({ engine: "logistics" })), "process");
});

test("container arguments: hardened single-use container, footprint mounted at the same paths, host tool mapped into the image", async () => {
  const { containerArgs, imageProgram } = await import("../src/kernel/engine-runtime.js");
  const a = containerArgs(ct, call({ engine: "logistics", program: "/var/lib/pai/data/state/tools/logistics-1/bin/python", cwd: "/state/run-1",
    args: ["-I", `${repo}/native/x.py`, "--out", "/state/run-1/o.json"], mounts: { read: ["/state/in.json", "/state/run-1/sub"], write: ["/state/run-1"] }, gpu: "preferred" }), repo, "pai-x");
  const s = a.join(" ");
  assert.ok(!s.includes("--read-only") && s.includes("-e PAI_GPU=1"), "GPU containers: ephemeral writable root for the CDI hooks, GPU announced");
  assert.ok(containerArgs({ ...ct, gpu: false }, call({ engine: "logistics", program: "python3" }), repo, "n").includes("--read-only"));
  for (const f of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--rm", "--name pai-x", "--user 0:0", "--cgroups disabled",
    "--root /var/lib/pai/data/containers/storage", "--device nvidia.com/gpu=all"]) assert.ok(s.includes(f), f);
  assert.ok(s.includes(`-v ${repo}/native:${repo}/native:ro`)); assert.ok(s.includes("-v /state/in.json:/state/in.json:ro")); assert.ok(s.includes("-v /state/run-1:/state/run-1:rw"));
  assert.ok(!s.includes("/state/run-1/sub:"), "a read inside a writable mount is not mounted twice");
  assert.ok(s.includes("-w /state/run-1"));
  assert.deepEqual(a.slice(a.indexOf("--entrypoint") + 1, a.indexOf("--entrypoint") + 3), ["/opt/pai/tools/logistics-1/bin/python", ct.images.logistics]);
  assert.deepEqual(a.slice(-4), ["-I", `${repo}/native/x.py`, "--out", "/state/run-1/o.json"], "arguments unchanged");
  assert.ok(!containerArgs({ ...ct, gpu: false }, call({ engine: "logistics", program: "python3", gpu: "preferred" }), repo, "n").includes("--device"));
  assert.equal(imageProgram(ct, "python3"), "/usr/bin/python3");
  assert.throws(() => imageProgram(ct, "/usr/local/bin/other"), /not a tool of the engine images/);
  const d = containerArgs({ ...ct, cli: "docker", storageRoot: undefined }, call({ engine: "logistics", program: "python3", gpu: "preferred" }), repo, "n");
  assert.ok(d.includes("--gpus") && !d.includes("--root") && !d.includes("--cgroups"));
});

// Regression (2026-10-13): the Batch optimiser runs on the process backend (an AWS client), but the CadQuery path in its
// input was mapped as if it ran in the physics container, so every geometry screen failed with FileNotFoundError.
test("tool paths and digests follow the backend of the call they are handed to", async () => {
  const { enginePath, toolDigest } = await import("../src/kernel/engine-runtime.js");
  const host = { repository: repo, engineContainer: { ...ct, engines: ["physics"], images: { physics: "r.example/pai-engines@sha256:" + "b".repeat(64) } } };
  const cq = "/var/lib/pai/data/state/tools/cadquery-2.8.0/bin/python";
  assert.equal(enginePath(host, "physics", cq), "/opt/pai/tools/cadquery-2.8.0/bin/python", "in the container");
  assert.equal(enginePath(host, "physics", cq, { network: "aws" }), cq, "AWS client on the host");
  assert.equal(await toolDigest(host, "physics", cq, async () => "file", { network: "aws" }), "file");
  assert.equal(await toolDigest(host, "physics", cq, async () => "file"), "image:sha256:" + "b".repeat(64));
});

test("resident worker: one request at a time, deadline ends the worker, interactive container args", async () => {
  const { startWorker, containerArgs, closeAllWorkers } = await import("../src/kernel/engine-runtime.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pai-worker-"));
  const script = join(dir, "w.py");
  await writeFile(script, 'import json,sys,time\nprint(json.dumps({"ready":1}),flush=True)\nfor l in sys.stdin:\n r=json.loads(l)\n time.sleep(r.get("sleep",0))\n print(json.dumps({"id":r["id"],"echo":r.get("x")}),flush=True)\n');
  try {
    const w = await startWorker({ repository: repo }, { engine: "physics", program: "python3", args: ["-I", script], cwd: dir, mounts: { read: [dir], write: [] } });
    const answers = await Promise.all([1, 2, 3].map(x => w.request<{ echo: number }>({ x }, 5000)));
    assert.deepEqual(answers.map(a => a.echo), [1, 2, 3], "serialised, each answer to its own request");
    await assert.rejects(w.request({ x: 4, sleep: 3 }, 200), /deadline/);
    assert.equal(w.alive(), false, "a missed deadline ends the worker");
    await assert.rejects(w.request({ x: 5 }, 1000), /not running/);
    const a = containerArgs({ ...ct, gpu: false }, call({ engine: "logistics", program: "python3" }), repo, "n", true);
    assert.deepEqual(a.slice(a.indexOf("run"), a.indexOf("run") + 3), ["run", "-i", "--rm"]);
  } finally { closeAllWorkers(); await rm(dir, { recursive: true, force: true }); }
});
