import { runEngine } from "./kernel/engine-runtime.js";
import { existsSync, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { invokeRuntime } from "./agentcore.js";
import type { Config } from "./config.js";

/**
 * OS isolation for generated CAD code (bubblewrap). The sandbox has no network and fresh PID/IPC/UTS/user
 * namespaces, drops all capabilities and clears the environment. The host filesystem is mounted read-only;
 * home directories, workbench state, credentials, runtime sockets and /tmp are replaced by empty tmpfs.
 * Only the pinned CadQuery venv, the native scripts and explicitly listed paths are mounted back; only the
 * run's output directory is writable. If bubblewrap cannot create the namespaces, generated code is refused.
 */
export const ISOLATION = ["no-network", "read-only-root", "hidden-home-state-credentials", "pid-ipc-uts-user-namespaces", "no-capabilities",
  "clear-environment", "writable-output-only", "rlimit-cpu-memory-files", "audit-hook", "restricted-builtins"] as const;
export interface SandboxStatus { available: boolean; reason?: string; bwrap?: string; transport?: "local" | "agentcore";
  remote?: { bubblewrap: boolean; internet: boolean; arch: string; version?: string } }
export interface SandboxRuntime { python: string; venv: string; native: string }

const HIDE = ["/tmp", "/var/tmp", "/home", "/root", "/run", "/mnt", "/media", "/srv", "/var/lib", "/opt/ai", "/etc/pai"];
const isDirectory = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

export async function sandboxRuntime(config: Config): Promise<SandboxRuntime> {
  if (!config.cadquery) throw new Error("CadQuery is not configured");
  // A venv must keep its own bin/python path; resolve the venv directory, not the interpreter symlink.
  const venv = await realpath(dirname(dirname(config.cadquery)));
  return { venv, python: join(venv, "bin", basename(config.cadquery)), native: await realpath(join(config.repository, "native")) };
}

export function sandboxArgs(config: Config, runtime: SandboxRuntime, mounts: { readOnly: string[]; writable: string[] }, argv: string[]): string[] {
  const hide = [...new Set([...HIDE, homedir(), config.state, join(config.repository, ".state")])]
    .filter(isDirectory).sort((a, b) => a.split("/").length - b.split("/").length);
  return [
    "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PYTHONUNBUFFERED", "1",
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    ...hide.flatMap(path => ["--tmpfs", path]),
    ...[runtime.venv, runtime.native, ...mounts.readOnly].flatMap(path => ["--ro-bind", path, path]),
    ...mounts.writable.flatMap(path => ["--bind", path, path]),
    "--", ...argv,
  ];
}

const cached = new Map<string, Promise<SandboxStatus>>();
/** One real probe per configuration: start the pinned interpreter inside the sandbox and confirm it has no network. */
export function sandboxStatus(config: Config): Promise<SandboxStatus> {
  const key = JSON.stringify([config.bwrap, config.cadquery, config.state, config.repository]);
  const hit = cached.get(key);
  if (hit) return hit;
  const probe = (async (): Promise<SandboxStatus> => {
    if (!config.cadquery) return { available: false, reason: "CadQuery 未配置" };
    if (config.agentcoreSandboxArn) {
      // Explicitly configured remote sandbox: verify in a fresh microVM that it really has no route out and that bubblewrap works.
      try {
        const p = await invokeRuntime<{ microvm?: boolean; network?: { internet?: boolean }; bubblewrap?: { active?: boolean }; arch?: string; version?: string }>(
          config.agentcoreSandboxArn, { op: "probe" }, { timeoutMs: 120_000 });
        const remote = { bubblewrap: Boolean(p.bubblewrap?.active), internet: p.network?.internet !== false, arch: p.arch ?? "?", version: p.version };
        if (!p.microvm || remote.internet) return { available: false, transport: "agentcore", remote, reason: "AgentCore 沙箱自检未通过（缺少 microVM 边界或可以访问互联网）" };
        return { available: true, transport: "agentcore", remote };
      } catch (error) {
        return { available: false, transport: "agentcore", reason: `AgentCore 沙箱不可用：${error instanceof Error ? error.message.slice(0, 160) : "未知"}` };
      }
    }
    const bwrap = config.bwrap ?? "bwrap";
    try {
      const runtime = await sandboxRuntime(config);
      const script = "import socket,os\ntry:\n socket.create_connection(('1.1.1.1',53),timeout=2); print('net')\nexcept OSError: print('isolated', os.path.exists(os.path.expanduser('~/.config')))";
      const r = await runEngine(config, { engine: "cad", program: bwrap, args: sandboxArgs(config, runtime, { readOnly: [], writable: [] }, [runtime.python, "-I", "-c", script]),
        cwd: "/", mounts: { write: [] }, timeoutMs: 20_000, untrusted: true });
      if (r.exitCode !== 0) return { available: false, bwrap, reason: `bubblewrap 无法创建隔离环境：${r.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? `exit ${r.exitCode}`}` };
      if (r.stdout.trim() !== "isolated False") return { available: false, bwrap, reason: "沙箱自检未通过（网络或主目录可见）" };
      return { available: true, bwrap, transport: "local" };
    } catch (error) {
      return { available: false, bwrap, reason: `bubblewrap 不可用：${error instanceof Error ? error.message.slice(0, 160) : "未知"}` };
    }
  })();
  cached.set(key, probe);
  return probe;
}
