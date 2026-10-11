import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { command } from "../adapters.js";
import type { EngineContainerConfig } from "../config.js";
import { DomainError } from "../domain.js";
/**
 * Engine runtime (ADR 0004): the single way lanes execute a native engine.
 *
 * A call names its toolchain (`engine`), the executable for the `process` backend, and its declared filesystem
 * footprint. The footprint is what the `container` backend mounts (inputs read-only, outputs writable, the release's
 * `native/` scripts read-only), at the same paths as on the host. Backends never change what is computed: same
 * program, same arguments, same bounded deadline, no shell, no automatic replay. GPU use is a declared preference,
 * and the result records the backend, the image digest and the device actually offered.
 */
export const ENGINES = ["cad", "physics", "blender", "robots", "newton", "logistics", "cam"] as const;
export type Engine = typeof ENGINES[number];
/** Where engine images install their tools (the host's PAI_TOOLS_DIR layout; see engines/Dockerfile.*). */
export const IMAGE_TOOLS = "/opt/pai/tools";

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
export interface EngineRuntime { backend: "process" | "container"; engine: Engine; device: "cpu" | "gpu"; image?: string }
export interface EngineResult { stdout: string; stderr: string; exitCode: number; startedAt: string; finishedAt: string; runtime: EngineRuntime }
export interface EngineHost { repository: string; engineContainer?: EngineContainerConfig }

const within = (root: string, p: string) => { const rel = relative(resolve(root), resolve(p)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

/** Absolute paths in the arguments that the declared footprint does not cover. */
export function undeclaredPaths(call: EngineCall, repository: string): string[] {
  // A sandboxed call's arguments are the sandbox's own bind list (system paths included); its footprint is `mounts`.
  if (call.untrusted) return [];
  const roots = [join(repository, "native"), ...(call.mounts.read ?? []), ...call.mounts.write];
  // Only standalone path arguments count. JSON and "--flag=value" forms are not paths, and the executable itself is the toolchain.
  return call.args.filter(a => isAbsolute(a) && !a.includes("\n") && !roots.some(r => within(r, a)) && a !== call.program);
}

/**
 * Which backend runs a call. Containers only for engines switched by configuration; calls that need AWS network
 * access (Batch clients) and model-written code (still isolated by bubblewrap until the gVisor step) stay on the process backend.
 */
export function backendFor(host: EngineHost, call: EngineCall): "process" | "container" {
  const c = host.engineContainer;
  return c && c.engines.includes(call.engine) && !call.untrusted && call.network !== "aws" ? "container" : "process";
}

/** The image path of a host tool: same layout under IMAGE_TOOLS; bare `python3` is the image's system Python. */
export function imageProgram(c: EngineContainerConfig, program: string): string {
  if (program === "python3") return "/usr/bin/python3";
  if (within(c.toolsDir, program)) return join(IMAGE_TOOLS, relative(c.toolsDir, program));
  throw new DomainError("ENGINE_IMAGE", `${program} is not a tool of the engine images`, 500);
}

/** CLI arguments of one hardened, single-use engine container (pure; tested). */
export function containerArgs(c: EngineContainerConfig, call: EngineCall, repository: string, name: string): string[] {
  const image = c.images[call.engine];
  const global = c.cli === "podman" && c.storageRoot
    ? ["--root", join(c.storageRoot, "storage"), "--runroot", join(c.storageRoot, "run"), "--storage-driver", "overlay",
       "--storage-opt", "overlay.ignore_chown_errors=true", "--cgroup-manager", "cgroupfs", "--events-backend", "none", "--log-level", "error"]
    : [];
  const writes = [...new Set(call.mounts.write.map(p => resolve(p)))];
  const reads = [...new Set([join(repository, "native"), ...(call.mounts.read ?? [])].map(p => resolve(p)))].filter(p => !writes.some(w => within(w, p)));
  const volumes = [...reads.map(p => ["-v", `${p}:${p}:ro`]), ...writes.map(p => ["-v", `${p}:${p}:rw`])].flat();
  const workdir = [...reads, ...writes].some(m => within(m, call.cwd)) ? call.cwd : "/tmp";
  const gpu = call.gpu === "preferred" && c.gpu ? (c.cli === "podman" ? ["--device", "nvidia.com/gpu=all"] : ["--gpus", "all"]) : [];
  // Rootless podman maps only the service user (single mapping): container root is that unprivileged user, so outputs
  // stay owned by it. Docker runs as the caller's uid/gid instead.
  const user = c.cli === "podman" ? ["--user", "0:0", "--cgroups", "disabled"] : ["--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`];
  return [...global, "run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g", ...user, ...gpu,
    "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "PYTHONUNBUFFERED=1", "-e", "HOME=/tmp",
    ...volumes, "-w", workdir, "--entrypoint", imageProgram(c, call.program), image, ...call.args];
}

function containerEnv(c: EngineContainerConfig): Record<string, string> {
  return c.cli === "podman" && c.storageRoot
    ? { HOME: c.storageRoot, XDG_CONFIG_HOME: join(c.storageRoot, "config"), XDG_RUNTIME_DIR: join(c.storageRoot, "run"), XDG_DATA_HOME: c.storageRoot }
    : {};
}

export async function runEngine(host: EngineHost, call: EngineCall): Promise<EngineResult> {
  const missing = undeclaredPaths(call, host.repository);
  // Enforced by default so a lane cannot silently depend on files a container would not see.
  if (missing.length && process.env.PAI_ENGINE_STRICT !== "0")
    throw new DomainError("ENGINE_FOOTPRINT", `${call.engine}: undeclared paths ${missing.join(", ")}`, 500);
  if (backendFor(host, call) === "process") {
    const r = await command(call.program, call.args, call.cwd, undefined, call.timeoutMs, call.onLine);
    return { ...r, runtime: { backend: "process", engine: call.engine, device: "cpu" } };
  }
  const c = host.engineContainer!, name = `pai-${call.engine}-${randomUUID()}`;
  for (const w of call.mounts.write) await mkdir(w, { recursive: true, mode: 0o700 });
  const env = containerEnv(c);
  try {
    const r = await command(c.cli, containerArgs(c, call, host.repository, name), call.cwd, undefined, call.timeoutMs, call.onLine, env);
    return { ...r, runtime: { backend: "container", engine: call.engine, image: c.images[call.engine], device: call.gpu === "preferred" && c.gpu ? "gpu" : "cpu" } };
  } catch (error) {
    // Killing the CLI does not stop a container: remove it so nothing keeps running after the bounded deadline.
    await command(c.cli, [...containerArgs(c, call, host.repository, name).slice(0, containerArgs(c, call, host.repository, name).indexOf("run")), "rm", "-f", name],
      "/", undefined, 30_000, undefined, env).catch(() => undefined);
    throw error;
  }
}
