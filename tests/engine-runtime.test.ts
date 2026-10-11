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
  for (const f of ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--rm", "--name pai-x", "--user 0:0", "--cgroups disabled",
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
