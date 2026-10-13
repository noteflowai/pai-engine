import { spawn, type ChildProcess } from "node:child_process";
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
/** `device` is what the runtime offered the engine (a GPU via CDI, or CPU only); engines log the device they used. */
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

/**
 * The path an engine sees for a host tool it is handed inside its input (e.g. CalculiX or the CadQuery interpreter
 * named in an optimisation spec): the image path when that engine runs in a container, otherwise the host path.
 */
/** The properties of a call that decide its backend; enginePath/toolDigest must be given the same ones as the call. */
export type BackendTraits = Pick<EngineCall, "network" | "untrusted">;
export function enginePath(host: EngineHost, engine: Engine, hostPath: string, traits: BackendTraits = {}): string {
  return backendFor(host, { engine, program: hostPath, args: [], cwd: "/", mounts: { write: [] }, timeoutMs: 0, ...traits }) === "container"
    ? imageProgram(host.engineContainer!, hostPath) : hostPath;
}
/** What a receipt pins for a tool: the file digest on the process backend, the image digest in a container. */
export async function toolDigest(host: EngineHost, engine: Engine, hostPath: string, fileDigest: () => Promise<string>, traits: BackendTraits = {}): Promise<string> {
  return enginePath(host, engine, hostPath, traits) === hostPath ? fileDigest() : `image:${host.engineContainer!.images[engine].split("@").at(-1)}`;
}

/** CLI arguments of one hardened, single-use engine container (pure; tested). */
export function containerArgs(c: EngineContainerConfig, call: EngineCall, repository: string, name: string, interactive = false): string[] {
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
  // The NVIDIA CDI hooks create driver-library symlinks and the loader cache inside the container, so a GPU container
  // keeps a writable root; it is still single-use (--rm), unprivileged and without network, and the host is unchanged.
  const root = gpu.length ? [] : ["--read-only"];
  return [...global, "run", ...(interactive ? ["-i"] : []), "--rm", "--name", name, "--network", "none", ...root, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g", ...user, ...gpu, ...(gpu.length ? ["-e", "PAI_GPU=1"] : []),
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

/**
 * A resident engine process (e.g. an artifact's model kept loaded): the same backend, image, hardening and declared
 * footprint as runEngine, but stdin/stdout stay open for newline-delimited JSON requests, one at a time, each with its
 * own deadline. A missed deadline or a broken line ends the worker (it is never reused in an unknown state); the caller
 * decides whether to fall back to a one-shot run. Workers end on close(), on idle (see the pool) and when the app stops.
 */
export interface EngineWorker {
  readonly runtime: EngineRuntime;
  alive(): boolean;
  request<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T>;
  close(): void;
}
const WORKERS = new Set<EngineWorker>();
/** Ends every resident worker (app shutdown). */
export function closeAllWorkers() { for (const w of [...WORKERS]) w.close(); }

export async function startWorker(host: EngineHost, call: Omit<EngineCall, "timeoutMs" | "onLine">, readyMs = 120_000): Promise<EngineWorker> {
  const full = { ...call, timeoutMs: 0 } as EngineCall;
  const missing = undeclaredPaths(full, host.repository);
  if (missing.length && process.env.PAI_ENGINE_STRICT !== "0") throw new DomainError("ENGINE_FOOTPRINT", `${call.engine}: undeclared paths ${missing.join(", ")}`, 500);
  const contained = backendFor(host, full) === "container";
  const c = host.engineContainer, name = `pai-${call.engine}-worker-${randomUUID()}`;
  if (contained) for (const w of call.mounts.write) await mkdir(w, { recursive: true, mode: 0o700 });
  const [program, args, env] = contained ? [c!.cli, containerArgs(c!, full, host.repository, name, true), containerEnv(c!)] : [call.program, call.args, {}];
  const child: ChildProcess = spawn(program, args, { cwd: call.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...env } });
  const runtime: EngineRuntime = contained ? { backend: "container", engine: call.engine, image: c!.images[call.engine], device: call.gpu === "preferred" && c!.gpu ? "gpu" : "cpu" }
    : { backend: "process", engine: call.engine, device: "cpu" };
  let open = true, pending = "", stderr = "", waiter: ((line: string | Error) => void) | undefined, chain: Promise<unknown> = Promise.resolve();
  const lines: string[] = [];
  const deliver = (x: string | Error) => { const w = waiter; waiter = undefined; if (w) w(x); else if (typeof x === "string") lines.push(x); };
  child.stdout!.on("data", chunk => {
    pending += chunk.toString();
    if (pending.length > 4_000_000) { worker.close(); return; }
    let i; while ((i = pending.indexOf("\n")) >= 0) { const l = pending.slice(0, i); pending = pending.slice(i + 1); if (l.trim()) deliver(l); }
  });
  child.stderr!.on("data", chunk => { if (stderr.length < 20_000) stderr += chunk.toString(); });
  child.on("close", () => { open = false; WORKERS.delete(worker); deliver(new Error(`worker exited: ${stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`)); });
  child.on("error", e => { open = false; deliver(e); });
  const next = (ms: number) => new Promise<string>((ok, bad) => {
    if (lines.length) return ok(lines.shift()!);
    if (!open) return bad(new Error("worker is not running"));
    const t = setTimeout(() => { waiter = undefined; worker.close(); bad(new DomainError("ENGINE_WORKER_TIMEOUT", `${call.engine} worker missed its deadline`, 504)); }, ms);
    waiter = x => { clearTimeout(t); x instanceof Error ? bad(x) : ok(x); };
  });
  const worker: EngineWorker = {
    runtime,
    alive: () => open,
    request<T>(message: Record<string, unknown>, timeoutMs: number) {
      const id = randomUUID();
      const run = chain.then(async () => {
        if (!open) throw new Error("worker is not running");
        child.stdin!.write(JSON.stringify({ ...message, id }) + "\n");
        const reply = JSON.parse(await next(timeoutMs)) as { id: string } & T;
        if (reply.id !== id) { worker.close(); throw new Error("worker answered another request"); }
        return reply as T;
      });
      chain = run.catch(() => undefined);
      return run;
    },
    close() {
      if (!open && !child.pid) return;
      open = false; WORKERS.delete(worker);
      try { child.stdin!.end(); } catch { /* already closed */ }
      try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
      // Killing the CLI does not stop a container: remove it by name.
      if (contained) spawn(c!.cli, [...containerArgs(c!, full, host.repository, name).slice(0, containerArgs(c!, full, host.repository, name).indexOf("run")), "rm", "-f", name],
        { stdio: "ignore", env: { ...process.env, ...env } }).on("error", () => undefined);
    },
  };
  WORKERS.add(worker);
  try { JSON.parse(await next(readyMs)); } catch (e) { worker.close(); throw e; }
  return worker;
}
