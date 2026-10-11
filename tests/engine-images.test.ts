import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { ENGINES } from "../src/kernel/engine-runtime.js";
/** Engine image contract (ADR 0004): pinned base, toolchain only (native scripts are mounted), non-root, same tool layout as the host. */
test("every engine image is pinned, toolchain-only, non-root, and installed by the host's own setup script", async () => {
  const files = (await readdir("engines")).filter(f => f.startsWith("Dockerfile.")).map(f => f.slice("Dockerfile.".length)).sort();
  const solver = await readFile("infra/solver.ts", "utf8");
  const declared = JSON.parse(/ENGINE_IMAGES = (\[[^\]]*\])/.exec(solver)![1].replace(/'/g, '"')) as string[];
  assert.deepEqual(files, [...declared].sort(), "infra builds exactly the images in engines/");
  for (const e of files) {
    const d = await readFile(`engines/Dockerfile.${e}`, "utf8");
    assert.match(d, /^ARG BASE=[^\s]+@sha256:[0-9a-f]{64}$/m, `${e}: base pinned by digest`);
    assert.match(d, /^USER 65534:65534$/m, `${e}: runs as nobody`);
    assert.match(d, /PAI_TOOLS_DIR=\/opt\/pai\/tools/, `${e}: host tool layout`);
    for (const line of d.split("\n").filter(l => l.startsWith("COPY "))) {
      for (const src of line.split(/\s+/).slice(1, -1).filter(s => !s.startsWith("--")))
        assert.ok(/^tools\/(setup_[a-z_]+\.py|runtime-pins\.json)$|^native\/[a-z-]+-requirements\.txt$/.test(src), `${e}: copies only setup scripts, pins and hash locks, not ${src}`);
    }
    assert.match(d, /--require-hashes|tools\/setup_[a-z_]+\.py/, `${e}: hash-locked (pip --require-hashes) or the checksum-verifying host setup script`);
  }
  // Engines the runtime knows but that have no host-local image: CAM runs as an AWS Batch job image.
  assert.deepEqual(ENGINES.filter(e => !files.includes(e)), ["cam"]);
});
