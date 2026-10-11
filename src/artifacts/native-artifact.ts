/**
 * Shared pieces of artifacts whose operations are native scripts (ADR 0003: shared logic extracted once):
 * lock-file versions, the clean source commit for provenance, materialising the version's exact files (each checked
 * against the manifest digest) and running a script in the pinned interpreter with a receipt and pai-usage-1 figures.
 */
import { runEngine } from "../kernel/engine-runtime.js";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writePrivate } from "../adapters.js";
import { DomainError, sha256 } from "../domain.js";
import type { OperationResult, RunContext } from "./contract.js";

export function lockVersions(lock: string) {
  return Object.fromEntries([...lock.matchAll(/^([a-z0-9-]+)==([^\s\\]+)/gim)].map(m => [m[1].toLowerCase(), m[2]]));
}

export function sourceCommit(repository: string): string | null {
  // A packaged release records its clean source commit (tools/package_release.py); a checkout asks git.
  const recorded = (() => { try { return readFileSync(join(repository, ".source-commit"), "utf8").trim(); } catch { return ""; } })();
  if (/^[a-f0-9]{40}$/.test(recorded)) return recorded;
  try {
    // Only the repository's own commit; never one of a surrounding repository.
    const top = execFileSync("git", ["-C", repository, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 }).trim();
    if (top !== repository) return null;
    const dirty = execFileSync("git", ["-C", repository, "status", "--porcelain", "--", "native/"], { encoding: "utf8", timeout: 5000 }).trim();
    return dirty ? null : execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch { return null; }
}

export async function materialise(ctx: RunContext) {
  const code = join(ctx.directory, "code");
  await mkdir(code, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(ctx.files)) {
    if (sha256(bytes) !== ctx.manifest.files[name]) throw new DomainError("ARTIFACT_FILE", `File ${name} differs from the manifest`, 422);
    await writePrivate(join(code, name), bytes);
  }
  return code;
}

/** Run one native step; a non-zero exit is a failed operation with its receipt (never retried). */
export async function nativeStep(ctx: RunContext, interpreter: string, script: string, args: string[], output: string, outputName: string,
  status: (value: Record<string, unknown>) => string, timeoutMs: number): Promise<OperationResult> {
  const t0 = Date.now();
  const r = await runEngine(ctx.config, { engine: "logistics", program: interpreter, args: ["-I", script, ...args], cwd: ctx.directory, mounts: { write: [ctx.directory] }, timeoutMs });
  const receipts = [{ command: ["python", script.split("/").at(-1)!, ...args.filter(a => !a.startsWith("/"))], exitCode: r.exitCode, stdoutSha256: sha256(r.stdout + r.stderr), seconds: (Date.now() - t0) / 1000, runtime: r.runtime }];
  if (r.exitCode !== 0) return { state: "failed", outputs: {}, status: "error", error: `${script.split("/").at(-1)} exited ${r.exitCode}`, receipts,
    usage: { cpuSeconds: null, maxRssKb: null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: 0 } };
  const text = await readFile(output, "utf8"), value = JSON.parse(text) as Record<string, unknown> & { usage?: { cpuSeconds?: number; maxRssKb?: number } };
  return { state: "ok", outputs: { [outputName]: value }, status: status(value), receipts,
    usage: { cpuSeconds: value.usage?.cpuSeconds ?? null, maxRssKb: value.usage?.maxRssKb ?? null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: Buffer.byteLength(text) } };
}
