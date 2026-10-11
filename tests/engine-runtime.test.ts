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
  const r = await runEngine(repo, call({ program: process.execPath, args: ["-e", "console.log(process.argv.length)"], mounts: { write: [] } }));
  assert.equal(r.exitCode, 0); assert.equal(r.stdout.trim(), "1");
  assert.deepEqual(r.runtime, { backend: "process", engine: "cad", device: "cpu" });
  await assert.rejects(runEngine(repo, call({ program: process.execPath, args: ["-e", "1", "/etc/hostname"] })), /ENGINE_FOOTPRINT|undeclared/);
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
