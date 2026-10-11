import { validRuntimeArn } from "./agentcore.js";
import { parseTenants, type Tenant } from "./tenant-config.js";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  workspace: string; state: string; web: string;
  robotRoot: string; stressSource: string; evalarcRoot: string; controlRoot: string; radarFile: string;
  port: number; controllerEntrypoint?: string; controllerDatabase?: string; blender?: string; cadquery?: string; repository: string;
  /** Pinned physics toolchain (npm run setup:physics): Python with Gmsh/Optuna/scikit-learn/MuJoCo, and CalculiX ccx. */
  physicsPython?: string; ccx?: string;
  /** Newton (setup:physics -- --with-newton): cross-engine check of the exported OpenUSD robot cell. */
  newtonPython?: string;
  /** FreeCAD 1.1 CAM toolchain (npm run setup:cam): Python with FreeCAD, OpenCAMLib and ocp-freecad-cam. */
  camPython?: string;
  /** Pinned OR-Tools venv (tools/setup_logistics.py) for the logistics planning artifact. */
  logisticsPython?: string;
  /** Pinned strands-robots venv with an offline MuJoCo Menagerie (tools/setup_robots.py); simulation only. */
  robotsPython?: string; robotsAssets?: string;
  /** Strands Decider `/v1/systemone` endpoint (loopback or private network only); routing suggestions, never verdicts. */
  deciderUrl?: string; deciderModel?: string;
  /** Container backend of the engine runtime (ADR 0004); engines not listed keep the process backend. */
  engineContainer?: EngineContainerConfig;
  /** AWS KMS asymmetric key (ECC_NIST_P256) that signs release packages; local Ed25519 when unset. */
  signingKmsKeyId?: string;
  /** RFC 3161 time-stamping authority for release seals (only a SHA-256 digest is sent) and its CA bundle. */
  tsaUrl?: string; tsaCaFile?: string;
  /** S3 bucket with Object Lock for write-once archiving of sealed release packages, and the retention in days. */
  /** Aerodynamics lane: the pinned OpenCFD OpenFOAM image (name@sha256 digest) and the cores to give OpenFOAM. */
  openfoamImage?: string; cfdProcessors?: number;
  /** FEA scale-out on AWS Batch (PAISolver stack): queue, job definition, jobs bucket and region. */
  solverBatch?: { queue: string; jobDefinition: string; cfdJobDefinition?: string; camJobDefinition?: string; bucket: string; region: string };
  packageArchiveBucket?: string; packageRetentionDays: number; packageLockMode: "COMPLIANCE" | "GOVERNANCE";
  /** bubblewrap binary for generated CAD code; generated code is refused when it cannot isolate. */
  bwrap?: string;
  /** Amazon Bedrock AgentCore runtimes (infra/agentcore.ts): remote executor and remote CAD sandbox. */
  agentcoreAgentArn?: string; agentcoreSandboxArn?: string;
  /** Engines this deployment may use, in fallback order; a subset of the executor's reviewed profiles. */
  aiProfiles?: string[];
  /** Region for the Claude engine on Amazon Bedrock (executor process only). */
  claudeBedrockRegion?: string;
  listenHost?: string; publicOrigin?: string;
  albAuth?: { albArn: string; issuer: string; clientId: string };
  /** Machine agents (OAuth client credentials) for `/api/agent/*`; see src/agent-api.ts. */
  agentAuth?: { userPoolId: string; clientIds: string[]; /** Pre-loaded JWKS (tests, air-gapped hosts); otherwise fetched from the pool. */ jwks?: unknown };
  authLogoutUrl?: string;
  /** Invite-only tenants (src/tenants.ts): Cognito client id -> tenant id and quotas. */
  tenants?: Tenant[];
}
/** Only a loopback or private-network Decider: the request carries task text. */
export interface EngineContainerConfig {
  cli: "podman" | "docker";
  /** Engine -> image pinned by digest (`registry/repo@sha256:…`). */
  images: Record<string, string>;
  /** Engines switched to containers. */
  engines: string[];
  /** Host tool prefix that maps to /opt/pai/tools in the images (same layout by construction). */
  toolsDir: string;
  /** Rootless podman storage root (graph and run roots below it); also its HOME/XDG dirs. */
  storageRoot?: string;
  /** NVIDIA CDI (podman) / --gpus (docker) available on this host. */
  gpu: boolean;
}
function engineContainer(env: NodeJS.ProcessEnv): EngineContainerConfig | undefined {
  const engines = (env.PAI_ENGINE_CONTAINERS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!engines.length) return undefined;
  const images = JSON.parse(env.PAI_ENGINE_IMAGES || "{}") as Record<string, string>;
  for (const e of engines) if (!/^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(images[e] ?? ""))
    throw new Error(`PAI_ENGINE_IMAGES must pin ${e} by digest`);
  const cli = env.PAI_ENGINE_CONTAINER_CLI === "docker" ? "docker" : "podman";
  if (!env.PAI_ENGINE_TOOLS_DIR) throw new Error("PAI_ENGINE_TOOLS_DIR is required with PAI_ENGINE_CONTAINERS");
  return { cli, images, engines, toolsDir: env.PAI_ENGINE_TOOLS_DIR.replace(/\/+$/, ""), storageRoot: env.PAI_CONTAINERS_ROOT || undefined, gpu: env.PAI_ENGINE_GPU === "1" };
}
function deciderUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const u = new URL(value);
  const privateHost = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(u.hostname);
  if (!["http:", "https:"].includes(u.protocol) || !privateHost || u.pathname !== "/v1/systemone" || u.username || u.password) {
    throw new Error("PAI_DECIDER_URL must be http(s)://<loopback or private address>/v1/systemone");
  }
  return u.toString();
}
const ALL_PROFILES = ["kiro-primary", "kiro-backup", "kiro-backup2", "codex", "claude"];
function aiProfiles(value?: string): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(",").map(x => x.trim()).filter(Boolean);
  if (!list.length || list.some(x => !ALL_PROFILES.includes(x)) || new Set(list).size !== list.length) throw new Error("PAI_AI_PROFILES must list distinct executor profiles");
  // Keep the executor's reviewed order (Kiro primary → backup → backup2 → Codex → Claude).
  return ALL_PROFILES.filter(x => list.includes(x));
}
export function configuration(): Config {
  const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const repository = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;
  const workspace = resolve(process.env.PAI_WORKSPACE ?? resolve(repository, ".."));
  const publicOrigin = process.env.PAI_PUBLIC_ORIGIN;
  if (publicOrigin && (new URL(publicOrigin).protocol !== "https:" || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error("PAI_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  const albValues = [process.env.PAI_AUTH_ALB_ARN, process.env.PAI_AUTH_ISSUER, process.env.PAI_AUTH_CLIENT_ID];
  if (albValues.some(Boolean) && !albValues.every(Boolean)) throw new Error("All ALB authentication settings are required");
  const albAuth = albValues.every(Boolean) ? { albArn: albValues[0]!, issuer: albValues[1]!, clientId: albValues[2]! } : undefined;
  const agentPool = process.env.PAI_AGENT_USER_POOL_ID, agentClients = process.env.PAI_AGENT_CLIENT_IDS?.split(",").map(x => x.trim()).filter(Boolean);
  if (Boolean(agentPool) !== Boolean(agentClients?.length)) throw new Error("PAI_AGENT_USER_POOL_ID and PAI_AGENT_CLIENT_IDS are required together");
  if (agentPool && !/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{1,64}$/.test(agentPool)) throw new Error("PAI_AGENT_USER_POOL_ID must be a Cognito user pool id");
  if (agentClients?.some(c => !/^[a-z0-9]{1,128}$/.test(c))) throw new Error("PAI_AGENT_CLIENT_IDS must list Cognito app client ids");
  const tenants = parseTenants(process.env.PAI_TENANTS);
  if (tenants.length && !agentPool && publicOrigin) throw new Error("PAI_TENANTS on a hosted site requires the agent user pool");
  // Tenant clients are verified by the same pool; their tokens carry only the tenant scope.
  const agentAuth = agentPool ? { userPoolId: agentPool, clientIds: [...new Set([...agentClients!, ...tenants.map(t => t.clientId)])] } : undefined;
  const listenHost = process.env.PAI_LISTEN_HOST ?? "127.0.0.1";
  if (listenHost !== "127.0.0.1" && (!publicOrigin || !albAuth)) throw new Error("Network binding requires HTTPS origin and ALB authentication");
  return {
    repository, workspace, state: resolve(process.env.PAI_STATE ?? resolve(repository, ".state")),
    web: resolve(process.env.PAI_WEB ?? resolve(repository, "web-dist")),
    robotRoot: resolve(process.env.PAI_ROBOT_ROOT ?? resolve(workspace, "robot-reel")),
    stressSource: resolve(process.env.PAI_STRESS_SOURCE ?? resolve(workspace, "robot-reel/docs/stress")),
    evalarcRoot: resolve(process.env.PAI_EVALARC_ROOT ?? resolve(workspace, "evalarc")),
    controlRoot: resolve(process.env.PAI_CONTROL_ROOT ?? resolve(workspace, "noteflow-agent-control")),
    radarFile: resolve(process.env.PAI_RADAR_FILE ?? resolve(workspace, "physical-ai-radar/radar/latest.json")),
    port: Number(process.env.PORT ?? "4317"),
    controllerEntrypoint: process.env.PAI_CONTROLLER_ENTRYPOINT,
    controllerDatabase: process.env.PAI_CONTROLLER_DATABASE,
    blender: process.env.PAI_BLENDER,
    cadquery: process.env.PAI_CADQUERY_PYTHON,
    physicsPython: process.env.PAI_PHYSICS_PYTHON, ccx: process.env.PAI_CCX, newtonPython: process.env.PAI_NEWTON_PYTHON || undefined,
    camPython: process.env.PAI_CAM_PYTHON || undefined,
    logisticsPython: process.env.PAI_LOGISTICS_PYTHON || undefined,
    robotsPython: process.env.PAI_ROBOTS_PYTHON || undefined, robotsAssets: process.env.PAI_ROBOTS_ASSETS || undefined,
    deciderUrl: deciderUrl(process.env.PAI_DECIDER_URL), deciderModel: process.env.PAI_DECIDER_MODEL || undefined,
    engineContainer: engineContainer(process.env),
    signingKmsKeyId: process.env.PAI_SIGNING_KMS_KEY_ID || undefined,
    tsaUrl: process.env.PAI_TSA_URL || undefined, tsaCaFile: process.env.PAI_TSA_CA_FILE || undefined,
    openfoamImage: /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(process.env.PAI_OPENFOAM_IMAGE ?? "") ? process.env.PAI_OPENFOAM_IMAGE : undefined,
    cfdProcessors: Number(process.env.PAI_CFD_PROCESSORS) || undefined,
    solverBatch: process.env.PAI_SOLVER_QUEUE && process.env.PAI_SOLVER_JOB_DEFINITION && process.env.PAI_SOLVER_BUCKET
      ? { queue: process.env.PAI_SOLVER_QUEUE, jobDefinition: process.env.PAI_SOLVER_JOB_DEFINITION, cfdJobDefinition: process.env.PAI_SOLVER_CFD_JOB_DEFINITION || undefined,
          camJobDefinition: process.env.PAI_SOLVER_CAM_JOB_DEFINITION || undefined, bucket: process.env.PAI_SOLVER_BUCKET,
          region: process.env.PAI_SOLVER_REGION || process.env.AWS_REGION || "ap-northeast-1" } : undefined,
    packageArchiveBucket: process.env.PAI_PACKAGE_ARCHIVE_BUCKET || undefined,
    packageRetentionDays: Math.min(3650, Math.max(1, Number(process.env.PAI_PACKAGE_RETENTION_DAYS) || 365)),
    packageLockMode: process.env.PAI_PACKAGE_LOCK_MODE === "GOVERNANCE" ? "GOVERNANCE" : "COMPLIANCE",
    bwrap: process.env.PAI_BWRAP,
    agentcoreAgentArn: validRuntimeArn(process.env.PAI_AGENTCORE_AGENT_ARN),
    agentcoreSandboxArn: validRuntimeArn(process.env.PAI_AGENTCORE_SANDBOX_ARN),
    aiProfiles: aiProfiles(process.env.PAI_AI_PROFILES),
    claudeBedrockRegion: /^[a-z]{2}(-[a-z]+)+-\d$/.test(process.env.PAI_CLAUDE_BEDROCK_REGION ?? "") ? process.env.PAI_CLAUDE_BEDROCK_REGION : undefined,
    listenHost, publicOrigin, albAuth, agentAuth,
    authLogoutUrl: process.env.PAI_AUTH_LOGOUT_URL,
    tenants,
  };
}
