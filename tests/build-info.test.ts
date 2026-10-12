import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfo } from "../src/build-info.js";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";

const COMMIT = "8a5b6a444ec2339013805d9188de3973f011c85e";
const DIGEST = "c".repeat(64);

test("a packaged release reports its recorded version, commit, packaging time and archive digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pai-build-"));
  try {
    const release = join(root, "releases", DIGEST);
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "package.json"), JSON.stringify({ version: "0.9.0" }));
    await writeFile(join(release, ".build-info.json"), JSON.stringify({ version: "0.9.0", sourceCommit: COMMIT, packagedAt: "2026-10-09T02:00:00+00:00" }));
    assert.deepEqual(buildInfo(release), { version: "0.9.0", commit: COMMIT, source: "packaged", packagedAt: "2026-10-09T02:00:00+00:00", releaseDigest: DIGEST });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an older package with only .source-commit still reports its commit; malformed records report unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pai-build-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.8.0" }));
    await writeFile(join(root, ".source-commit"), COMMIT + "\n");
    assert.deepEqual(buildInfo(root), { version: "0.8.0", commit: COMMIT, source: "packaged" });
    await writeFile(join(root, ".build-info.json"), JSON.stringify({ version: "0.8.0", sourceCommit: null }));
    await writeFile(join(root, ".source-commit"), "not-a-commit\n");
    assert.deepEqual(buildInfo(root), { version: "0.8.0", commit: null, source: "packaged" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the running version is served to signed-in clients; /healthz stays state-free", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-build-app-"));
  const config = configuration();
  const { app } = await createApp({ ...config, state });
  try {
    const host = { host: `127.0.0.1:${config.port}` };
    const version = (await app.inject({ url: "/api/version", headers: host })).json();
    assert.equal(version.version, buildInfo(config.repository).version);
    assert.ok(version.commit === null || /^[a-f0-9]{40}$/.test(version.commit));
    assert.deepEqual((await app.inject({ url: "/api/state", headers: host })).json().build, version);
    assert.deepEqual((await app.inject({ url: "/healthz", headers: host })).json(), { status: "ok" });
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

test("the MCP server reports the package version", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile("package.json", "utf8")).version;
  assert.match(await readFile("src/mcp.ts", "utf8"), new RegExp(`const VERSION = "${pkg.replace(/\./g, "\\.")}"`));
});
