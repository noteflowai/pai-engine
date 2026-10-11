import { isAbsolute, join, relative, resolve } from "node:path";
import { command } from "../adapters.js";
import { DomainError } from "../domain.js";
/**
 * Engine runtime (ADR 0004): the single way lanes execute a native engine.
 *
 * A call names its toolchain (`engine`), the executable for the `process` backend, and its declared filesystem
 * footprint. The footprint is what a `container` backend mounts (inputs read-only, outputs writable, the release's
 * `native/` scripts read-only); keeping it declared and checked now means moving a lane into a container changes no
 * call site. Backends never change what is computed: same program, same arguments, same bounded deadline, no shell,
 * no automatic replay. GPU use is a declared preference, and receipts record the device actually used.
 */
export const ENGINES = ["cad", "physics", "blender", "robots", "newton", "logistics", "cam"] as const;
export type Engine = typeof ENGINES[number];

export interface EngineCall {
  engine: Engine;
  /** Executable for the process backend (an interpreter path, Blender, or `bwrap` for an already-sandboxed call). */
  program: string;
  args: string[];
  cwd: string;
  /** Declared footprint. The release's `native/` is an implicit read; `cwd` is not (declare it if read). */
  mounts: { read?: string[]; write: string[] };
  timeoutMs: number;
  onLine?: (line: string) => void;
  /** `"aws"` for clients that only submit to and poll AWS Batch/S3 (the work itself runs remotely). Default none. */
  network?: "none" | "aws";
  /** Runs model-written code; must stay inside an isolation boundary on every backend. */
  untrusted?: boolean;
  gpu?: "none" | "preferred";
}
export interface EngineResult {
  stdout: string; stderr: string; exitCode: number; startedAt: string; finishedAt: string;
  runtime: { backend: "process"; engine: Engine; device: "cpu" };
}

/** Absolute paths in the arguments that the declared footprint does not cover. */
export function undeclaredPaths(call: EngineCall, repository: string): string[] {
  // A sandboxed call's arguments are the sandbox's own bind list (system paths included); its footprint is `mounts`.
  if (call.untrusted) return [];
  const roots = [join(repository, "native"), ...(call.mounts.read ?? []), ...call.mounts.write].map(p => resolve(p));
  const inside = (p: string) => roots.some(r => { const rel = relative(r, resolve(p)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
  // Only standalone path arguments count. JSON and "--flag=value" forms are not paths, and the executable itself is the toolchain.
  return call.args.filter(a => isAbsolute(a) && !a.includes("\n") && !inside(a) && a !== call.program);
}

export async function runEngine(repository: string, call: EngineCall): Promise<EngineResult> {
  const missing = undeclaredPaths(call, repository);
  // Enforced by default so a lane cannot silently depend on files a container would not see.
  if (missing.length && process.env.PAI_ENGINE_STRICT !== "0")
    throw new DomainError("ENGINE_FOOTPRINT", `${call.engine}: undeclared paths ${missing.join(", ")}`, 500);
  const r = await command(call.program, call.args, call.cwd, undefined, call.timeoutMs, call.onLine);
  return { ...r, runtime: { backend: "process", engine: call.engine, device: "cpu" } };
}
