import { EvidenceKindSchema } from "./ontology/evidence.js";
import Fastify, { type FastifyReply } from "fastify";
import type { RecordKind } from "./ontology/kinds.js";
import staticPlugin from "@fastify/static";
import compress from "@fastify/compress";
import { constants as zlib } from "node:zlib";
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldTick } from "node:timers/promises";
import { z, ZodError } from "zod";
import { NativeAdapters, type Adapters } from "./adapters.js";
import { configuration, type Config } from "./config.js";
import { CadCodeCheck, Candidate, CreateProject, Id, ReviseProject } from "./contracts.js";
import { DomainError, sha256 } from "./domain.js";
import { buildInfo } from "./build-info.js";
import { deciderConfigured, suggestLane } from "./decider.js";
import { tenantOfClient, type Tenant } from "./tenants.js";
import { tenantRoutes } from "./tenant-routes.js";
import { actionRuntime } from "./kernel/actions.js";
import { makeBundle, verifyBundle } from "./bundle.js";
import { buildPackage, MAX_PACKAGE_BYTES, PackageSubmission, ReleasePackage, signer, verifySealedPackage } from "./signing.js";
import { archive, timestamp, type Archive } from "./seal.js";
import { solverDataset } from "./dataset.js";
import { inspectionPlan, recordInspection } from "./inspection.js";
import { trackRecord } from "./track-record.js";
import { createGrant, revokeGrant, runUnderGrant } from "./autonomy.js";
import { runAutopilot, type Autopilot } from "./autopilot.js";
import { AERO_FILES, AERO_REFERENCE, DEFAULT_AERO_REQUIREMENTS, aeroConfigured, aeroRunner, reviewAero, type AeroReview } from "./aero.js";
import { propose } from "./proposals.js";
import { Workbench } from "./service.js";
import { Store } from "./store.js";
import { reviewScene, type SceneReview } from "./scenes.js";
import { freezeFactoryCriteria, reviewFactory, REVIEWED_SAMPLE, DEFAULT_FACTORY_CRITERIA, type FactoryReview } from "./factory.js";
import { LiveBus, type Stamped } from "./live.js";
import { confirmPlan, createPlan, type AssistantPlan, preflightPlan, PreflightStep } from "./assistant.js";
import { contextView, createAiPlan, createExternalPlan, reconcileAi, resolveHandle } from "./ai.js";
import { controllerConfigured, controllerTransport, enabledProfiles } from "./controller.js";
import { computeLifecycle, type LifecycleSnapshot } from "./lifecycle.js";
import type { Campaign, Feedback, Project, Review } from "./contracts.js";
import type { Proposal } from "./proposals.js";
import type { FactoryCriteria } from "./factory.js";
import { toolCatalog } from "./tool-catalog.js";
import { CAM_FILE, CAD_TEMPLATES, FAMILY_DEFAULTS, FAMILY_STRUCTURAL, camConfigured, camRunner, DEFAULT_STRUCTURAL, FEA_FILES, CAD_FILES, CAD_TEMPLATE_FILE, checkCadCode, DEFAULT_CAD_REQUIREMENTS, precheckCad, reviewCad, type CadReview } from "./cad.js";
import { ISOLATION, sandboxStatus } from "./sandbox.js";
import { DEFAULT_SWEEP_GRID, DEFAULT_PILLOW_GRID, MAX_SWEEP_POINTS, sweepCad, type CadSweep } from "./sweep.js";
import { DEFAULT_OPTIMIZE_BUDGET, MAX_OPTIMIZE_EVALUATIONS, botorchVersion, optimizeCad, type CadOptimization } from "./optimize.js";
import { KIND_STORE, admission, createRelease, decideRelease, supersedeForRevision, type Release } from "./release.js";
import { acquireRuntime } from "./runtime-lock.js";
import { authentication } from "./auth.js";
import { cognitoDirectory, sessionRole, tenantSessionAllows, type Directory, type SessionRole } from "./members.js";
import { artifactRoutes } from "./artifacts/routes.js";
import { ontologyRoutes } from "./ontology/routes.js";
import { WORKSPACE_FIELDS } from "./ontology/model.js";
import { interruptRunning } from "./artifacts/workflows.js";
import { agentAuthentication, agentRoute, rewriteAgentUrl, type AgentPrincipal } from "./agent-api.js";

export async function createApp(config: Config, adapters: Adapters = new NativeAdapters(config), deps: { directory?: Directory; /** Test seam for hosted ALB verification. */ authenticated?: (h: Record<string, string | string[] | undefined>) => Promise<boolean> } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 4_000_000, requestTimeout: 120_000, rewriteUrl: rewriteAgentUrl });
  // Every registered route, so the ontology contract test can prove each write route is exactly one action type.
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", r => { for (const method of [r.method].flat()) routes.push({ method, url: r.url }); });
  // Compress JSON and the app shell (the signed-in /api/state is ~2.4 MB of JSON: ~0.1 MB as brotli). Brotli at quality 5
  // keeps a dynamic response cheap to encode; images, video and already-compressed files are left alone. Hijacked
  // live streams (text/event-stream) are not touched.
  await app.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip"],
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }, zlibOptions: { level: 6 } });
  const release = await acquireRuntime(config.state);
  let store: Store;
  try { store = new Store(join(config.state, "workbench.sqlite")); } catch (error) { await release(); throw error; }
  store.interruptPending(); interruptRunning(store);
  const live = new LiveBus();
  const workbench = new Workbench(store, adapters, config.state, live);
  const streams = new Set<() => void>();
  const authenticated = deps.authenticated ?? authentication(config), agentAuthenticated = agentAuthentication(config);
  const principals = new WeakMap<object, AgentPrincipal>();
  const tenantOf = new WeakMap<object, Tenant>();
  /** Browser sessions resolved to a role (default deny, src/members.ts). */
  const sessions = new WeakMap<object, SessionRole>();
  // Hosted: the Cognito pool behind the ALB (issuer https://cognito-idp.<region>.amazonaws.com/<pool>).
  const pool = config.albAuth ? /cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([\w-]+_[\w]+)$/.exec(config.albAuth.issuer) : null;
  const directory = deps.directory ?? (pool ? await cognitoDirectory(pool[2], pool[1]) : undefined);
  // Writes are ontology actions: the runtime authorizes the caller against the action's submitters and checks parameters.
  const action = actionRuntime(app, raw => {
    const tenant = tenantOf.get(raw as object), principal = principals.get(raw as object);
    return tenant ? { kind: "tenant", tenant: tenant.id } : principal?.scope ? { kind: "agent", scope: principal.scope } : { kind: "maintainer" };
  }, { record: event => store.insert("audit-event", event),
    actor: request => { const p = principals.get(request.raw); const t = tenantOf.get(request.raw);
      const m = sessions.get(request.raw);
      return m?.kind === "tenant" ? `tenant:${m.tenant.id}/member:${m.member.id}` : t ? `tenant:${t.id}` : p ? `agent:${p.clientId}` : config.albAuth && typeof request.headers["x-amzn-oidc-identity"] === "string"
        ? `cognito:${String(request.headers["x-amzn-oidc-identity"]).slice(0, 64)}` : "local-maintainer"; } });
  // Audit log: maintainers only (not in the workspace projection, so agents and tenants never see it). Newest first.
  app.get("/api/v1/audit", async request => {
    const q = z.object({ action: z.string().regex(/^[a-zA-Z]{1,40}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict().parse(request.query);
    const all = store.list<{ action: string }>("audit-event").filter(e => !q.action || e.action === q.action);
    return { total: all.length, events: all.slice(-q.limit).reverse() };
  });
  const activeJobs = new Set<Promise<unknown>>();
  app.addHook("preClose", async () => { for (const end of [...streams]) end(); await Promise.allSettled([...activeJobs]); });
  app.addHook("onClose", async () => { store.close(); await release(); });
  app.addHook("onRequest", async (request, reply) => {
    const healthCheck = request.method === "GET" && request.url === "/healthz";
    const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
    if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
    if (!healthCheck && !allowedHosts.has(request.headers.host ?? "")) return reply.code(403).send({ error: "LOCAL_HOST_REQUIRED" });
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    if (config.publicOrigin) reply.header("Strict-Transport-Security", "max-age=31536000");
    if (request.url === "/api/agent-not-found") return reply.code(404).send({ error: "NOT_FOUND" });
    const agent = agentRoute(request.raw);
    if (agent) {
      // Agent routes: bearer token (hosted) or loopback; never the browser session, never a cross-origin browser.
      if (request.headers.origin || request.headers.cookie) return reply.code(403).send({ error: "AGENT_ROUTE_BROWSER" });
      const principal = await agentAuthenticated(request.headers, agent.scope);
      if (!principal) return reply.code(401).send({ error: "AGENT_AUTHENTICATION_REQUIRED" });
      // Tenants and workspace agents never cross: a tenant client gets only tenant routes, a workspace agent none of them.
      // Loopback without a pool names the tenant in a header (local development and tests only).
      const local = !principal.verified && !config.publicOrigin;
      const header = request.headers["x-pai-tenant"];
      const tenant = local ? config.tenants?.find(t => t.id === header) : tenantOfClient(config, principal.clientId);
      if (agent.scope === "tenant" ? !tenant : Boolean(tenant)) return reply.code(403).send({ error: "TENANT_BOUNDARY" });
      principals.set(request.raw, { ...principal, scope: agent.scope });
      if (tenant) tenantOf.set(request.raw, tenant);
      return;
    }
    if (!healthCheck && !await authenticated(request.headers)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    if (!healthCheck) {
      // Roles, default deny: a maintainer by subject, an active tenant member, or nothing (only /api/session answers).
      const role = sessionRole(store, config, typeof request.headers["x-amzn-oidc-identity"] === "string" ? request.headers["x-amzn-oidc-identity"] : undefined);
      sessions.set(request.raw, role);
      const path = request.url.split("?")[0];
      if (role.kind === "none" && path.startsWith("/api/") && path !== "/api/session") return reply.code(403).send({ error: "ACCESS_NOT_GRANTED" });
      if (role.kind === "tenant") {
        if (!tenantSessionAllows(request.method, request.url)) return reply.code(403).send({ error: "TENANT_SESSION_SCOPE" });
        tenantOf.set(request.raw, role.tenant);
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin
        && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.publicOrigin ? [config.publicOrigin] : [])].includes(request.headers.origin)) {
      return reply.code(403).send({ error: "CROSS_ORIGIN_WRITE" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.code, message: error.message });
    if (error instanceof ZodError || error instanceof SyntaxError) return reply.code(400).send({ error: "INVALID_INPUT", message: "Input does not match the documented schema" });
    const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "REQUEST_REJECTED" });
    return reply.code(500).send({ error: "LOCAL_TOOL_UNAVAILABLE", message: "Check local configuration and retained receipts" });
  });
  const sandbox = config.cadquery ? await sandboxStatus(config) : { available: false, reason: "CadQuery 未配置" };
  const cadTemplate = await readFile(join(config.repository, CAD_TEMPLATE_FILE), "utf8");
  const cadTemplates = Object.fromEntries(await Promise.all(Object.entries(CAD_TEMPLATES).map(async ([f, file]) => [f, await readFile(join(config.repository, file), "utf8")])));
  const paramId = (p: unknown, field = "id") => Id.parse((p as Record<string, unknown>)[field]);
  const nativeResponse = <T extends { id: string; state: string }>(record: T, reply: FastifyReply, route: string) => {
    if (record.state === "running" && config.publicOrigin) reply.code(202).header("Location", `/api/${route}/${record.id}`).header("Retry-After", "2");
    return record;
  };
  const executeNative = async <T extends { id: string; state: string }>(
    reply: FastifyReply, input: unknown, kind: RecordKind, route: string, execute: () => Promise<T>,
  ) => {
    const requestId = Id.parse((input as Record<string, unknown>)?.requestId);
    const operation = execute();
    if (!config.publicOrigin) return await operation;
    const early = await Promise.race([
      operation.then(record => ({ done: true as const, record })),
      yieldTick().then(() => ({ done: false as const })),
    ]);
    if (early.done) return nativeResponse(early.record, reply, route);
    // Both native services atomically claim their request before their first await.
    const id = store.requestRun(requestId);
    if (!id) return await operation; // Validation failed before any side effect.
    const tracked = operation.catch(() => {
      const record = store.get<T & { error?: string }>(kind, id);
      if (record?.state === "running") {
        record.state = "interrupted";
        record.error = "Background operation stopped; retain identity and reconcile without automatic replay.";
        store.put(kind, record);
      }
    });
    activeJobs.add(tracked);
    void tracked.finally(() => activeJobs.delete(tracked));
    return nativeResponse(store.get<T>(kind, id)!, reply, route);
  };
  app.get("/healthz", async () => ({ status: "ok" }));
  // Running version for the signed-in UI and operators; /healthz stays state-free.
  const build = buildInfo(config.repository);
  app.get("/api/version", async () => build);
  app.get("/logout", async (_request, reply) => {
    if (!config.authLogoutUrl) return reply.code(404).send({ error: "NOT_FOUND" });
    const names = ["PAIAuthSession", ...Array.from({ length: 4 }, (_, i) => `PAIAuthSession-${i}`)];
    reply.header("Set-Cookie", names.map(name => `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`));
    return reply.redirect(config.authLogoutUrl);
  });
  /** Reads each record kind once per call (read-only); /api/state used to parse every kind again for every project. */
  const snapshotReader = (): Pick<Store, "list" | "get"> => {
    const memo = new Map<string, unknown[]>();
    return { list: <T>(kind: RecordKind) => { if (!memo.has(kind)) memo.set(kind, store.list(kind)); return memo.get(kind) as T[]; }, get: (kind, id) => store.get(kind, id) };
  };
  const lifecycle = (project: Project, from: Pick<Store, "list"> = store) => {
    const mine = <T extends { projectId?: string }>(kind: RecordKind) => from.list<T>(kind).filter(x => x.projectId === project.id);
    const campaigns = mine<Campaign>("campaign"), ids = new Set(campaigns.map(c => c.id));
    const releases = mine<Release>("release");
    const snapshot: LifecycleSnapshot = { project, releases, reviews: mine<Review>("review"), scenes: mine<SceneReview>("scene-review"), cads: mine<CadReview>("cad-review"), aeros: mine<AeroReview>("aero-review"),
      factoryCriteria: mine<FactoryCriteria>("factory-criteria"), factoryReviews: mine<FactoryReview>("factory-review"),
      feedback: mine<Feedback>("feedback"), campaigns,
      events: from.list<LifecycleSnapshot["events"][number]>("event").filter(e => ids.has(e.campaignId)),
      plans: mine<AssistantPlan>("assistant-plan"), proposals: mine<Proposal>("proposal") };
    return computeLifecycle(snapshot);
  };
  app.get("/api/projects/:id/lifecycle", async request => lifecycle(workbench.project(paramId(request.params))));
  // The auth hook has already verified the ALB-signed token and that its subject equals this header.
  const actor = (headers: Record<string, unknown>) => config.albAuth && typeof headers["x-amzn-oidc-identity"] === "string"
    ? `cognito:${String(headers["x-amzn-oidc-identity"]).slice(0, 64)}` : "local-maintainer";
  artifactRoutes(app, { store, config, actor, executeNative, action, track: job => { const t = job.catch(() => undefined); activeJobs.add(t); void t.finally(() => activeJobs.delete(t)); } });
  app.get("/api/session", async request => {
    const r = sessions.get(request.raw) ?? { kind: "maintainer" as const };
    return { role: r.kind, ...(r.kind === "tenant" ? { tenant: r.tenant.id, email: r.member.email } : {}), logoutUrl: config.authLogoutUrl ?? null };
  });
  tenantRoutes(app, { store, config, actor, executeNative, action, directory, tenant: raw => tenantOf.get(raw as object),
    track: job => { const t = job.catch(() => undefined); activeJobs.add(t); void t.finally(() => activeJobs.delete(t)); } });
  ontologyRoutes(app, store, config, JSON.parse(await readFile(join(config.repository, "tools/runtime-pins.json"), "utf8")), raw => Boolean(agentRoute(raw)));
  app.get("/api/projects/:id/ai-track-record", async request => trackRecord(store, workbench.project(paramId(request.params)).id));
  app.get("/api/projects/:id/versions", async request => workbench.versions(paramId(request.params)));
  app.get("/api/projects/:id/admission", async request => {
    const q = z.object({ kind: EvidenceKindSchema, runId: Id }).strict().parse(request.query);
    const p = workbench.project(paramId(request.params));
    return admission(store, p, lifecycle(p), q.kind, q.runId);
  });
  action("createReleaseCandidate", async ({ request }) => {
    const p = workbench.project(paramId(request.params));
    return createRelease(store, p, lifecycle(p), request.body, actor(request.headers));
  });
  action("decideRelease", async ({ request }) => {
    const p = workbench.project(paramId(request.params));
    return decideRelease(store, p, lifecycle(p), paramId(request.params, "releaseId"), request.body, actor(request.headers));
  });
  // Signed, self-contained release package: record + digest-checked native files + release decision.
  const DIRS: Record<string, string> = { "scene-review": "scenes", "cad-review": "cad", "aero-review": "aero" };
  // A release is sealed once: signed, optionally time-stamped (RFC 3161) and archived write-once (S3 Object Lock).
  // Later downloads return the same bytes, so the archived copy, the time-stamp and every download agree.
  const sealing = new Map<string, Promise<Buffer>>();
  const sealed = (release: Release) => {
    const existing = sealing.get(release.id);
    if (existing) return existing;
    const file = join(config.state, "packages", `${release.id}.json`);
    const job = (async () => {
      const stored = await readFile(file).catch(() => undefined);
      if (stored) return stored;
      let pkg = await packageOf(release);
      if (config.tsaUrl) pkg = { ...pkg, timestamp: await timestamp(config, Buffer.from(pkg.signature.value, "base64")) };
      const bytes = Buffer.from(JSON.stringify(pkg));
      let archived: Archive | undefined;
      if (config.packageArchiveBucket) archived = await archive(config, `releases/${release.projectId}/${release.number}-${release.id}.json`, bytes);
      await mkdir(join(config.state, "packages"), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      const seal = { id: release.id, releaseId: release.id, projectId: release.projectId, number: release.number, sealedAt: new Date().toISOString(),
        packageSha256: sha256(bytes), manifestSha256: pkg.manifestSha256, signer: { keyId: pkg.signature.keyId, algorithm: pkg.signature.algorithm },
        timestamp: pkg.timestamp ? { tsa: pkg.timestamp.tsa, genTime: pkg.timestamp.genTime, serial: pkg.timestamp.serial } : null, archive: archived ?? null };
      store.insert("release-seal", seal); // append-only: one seal per release
      return bytes;
    })().finally(() => sealing.delete(release.id));
    sealing.set(release.id, job);
    return job;
  };
  app.get("/api/releases/:id/package", async (request, reply) => {
    const release = store.get<Release>("release", paramId(request.params));
    if (!release) throw new DomainError("NOT_FOUND", "Release not found", 404);
    if (release.maturity !== "released") throw new DomainError("NOT_RELEASED", "Only an approved release can be packaged", 409);
    const bytes = await sealed(release);
    reply.header("Content-Disposition", `attachment; filename="pai-release-${release.number}.json"`);
    return reply.type("application/json").send(bytes);
  });
  async function packageOf(release: Release): Promise<ReleasePackage> {
    const kind = KIND_STORE[release.evidenceKind];
    const record = store.get<{ id: string; verdict?: string; decision?: { verdict: string }; requirementDigest: string; files?: Record<string, string>; artifacts?: Record<string, string> }>(kind, release.runId);
    if (!record) throw new DomainError("NOT_FOUND", "Release evidence not found", 404);
    const files: Record<string, Buffer> = {};
    for (const [name, digest] of Object.entries(record.files ?? {})) {
      const dir = DIRS[kind]; if (!dir) continue;
      const content = await readFile(join(config.state, dir, record.id, name));
      if (sha256(content) !== digest) throw new DomainError("NATIVE_FILE_CHANGED", `Native artifact differs from its verified digest: ${name}`, 422);
      files[name] = content;
    }
    for (const [name, content] of Object.entries(record.artifacts ?? {})) files[`artifacts/${name}`] = Buffer.from(content);
    // First-article inspections recorded before the release travel with it, as signed physical evidence.
    for (const i of store.list<{ id: string; cadReviewId: string; createdAt: string }>("cad-inspection").filter(i => i.cadReviewId === record.id && i.createdAt <= (release.history.find(h => h.maturity === "released")?.at ?? new Date().toISOString()))) {
      files[`inspections/${i.id}.json`] = Buffer.from(JSON.stringify(i, null, 2));
    }
    return buildPackage(config, { ...release }, { ...record, verdict: record.verdict ?? record.decision?.verdict ?? null }, files);
  }
  app.get("/api/signing/public-key", async () => { const s = await signer(config); return { keyId: s.keyId, algorithm: s.algorithm, publicKeyPem: s.publicKeyPem }; });
  // Packages carry base64 native files (FEA results are several MB): this route alone accepts up to the package cap.
  action("verifyReleasePackage", async ({ request }) => {
    const body = PackageSubmission.parse(request.body);
    return verifySealedPackage(body.package, body.trustedPublicKeyPem, config.tsaCaFile);
  }, { bodyLimit: Math.ceil(MAX_PACKAGE_BYTES * 1.4) + 1_000_000 });
  app.get("/api/dataset/solver", async request => {
    const { domain } = z.object({ domain: z.enum(["structural-fea", "aero-rans"]).optional() }).parse(request.query);
    const d = solverDataset(store);
    if (!domain) return d;
    const data = d.data.filter(r => r.domain === domain);
    return { ...d, rows: data.length, data, sha256: sha256(JSON.stringify(data)), domain };
  });
  app.get("/api/state", async () => { const r = snapshotReader(); return {
    build,
    // Record lists are the ontology's workspace projection; derived views follow.
    ...Object.fromEntries(Object.entries(WORKSPACE_FIELDS).map(([kind, field]) => [field, r.list(kind as RecordKind)])),
    lifecycles: Object.fromEntries(r.list<Project>("project").map(p => [p.id, lifecycle(p, r)])),
    aiTrackRecords: Object.fromEntries(r.list<Project>("project").map(p => [p.id, trackRecord(r, p.id)])),
    metrics: workbench.metrics(),
    tools: toolCatalog, capabilities: { recordingVerification: true, physicalValidation: false, automaticPublication: false,
      modelProposal: Boolean(config.controllerEntrypoint && config.controllerDatabase),
      authenticatedWorkspace: Boolean(config.albAuth && config.authLogoutUrl),
      blender: Boolean(config.blender),
      signing: { kms: Boolean(config.signingKmsKeyId), keyId: (await signer(config)).keyId, algorithm: (await signer(config)).algorithm },
      physics: config.physicsPython && config.ccx ? { fea: "Gmsh 4.15 + CalculiX 2.21 (C3D10, linear static)", defaultStructural: DEFAULT_STRUCTURAL, familyStructural: FAMILY_STRUCTURAL,
        optimize: { engine: "Optuna 5 NSGA-II + scikit-learn GP surrogate (ranking only)", defaultBudget: DEFAULT_OPTIMIZE_BUDGET, maxEvaluations: MAX_OPTIMIZE_EVALUATIONS,
          strategies: (await botorchVersion(config)) ? ["gp-nsga2", "botorch-qlognehvi"] : ["gp-nsga2"], botorch: await botorchVersion(config) } } : false,
      aero: aeroConfigured(config) ? { engine: `OpenFOAM v2512 (OpenCFD image${aeroRunner(config) === "batch" ? ", AWS Batch 16 vCPU" : ""}) · snappyHexMesh + simpleFoam k-ω SST · two mesh levels`, reference: AERO_REFERENCE,
        defaultRequirements: DEFAULT_AERO_REQUIREMENTS } : false,
      cad: config.cadquery ? { engine: "CadQuery 2.8.0 / OCCT 7.9", defaultRequirements: DEFAULT_CAD_REQUIREMENTS, families: FAMILY_DEFAULTS,
        cam: camConfigured(config) ? { engine: `FreeCAD 1.1.4 CAM (ocp-freecad-cam) + OpenCAMLib${camRunner(config) === "batch" ? " on AWS Batch" : ""} · independent dexel simulation` } : false,
        generatedCode: { ...sandbox, isolation: ISOLATION, template: cadTemplate, templates: cadTemplates }, sweep: { defaultGrid: DEFAULT_SWEEP_GRID, grids: { "nema17-bracket": DEFAULT_SWEEP_GRID, "pillow-block": DEFAULT_PILLOW_GRID }, maxPoints: MAX_SWEEP_POINTS } } : false,
      factoryTwin: { mode: "read-only illustrative-simulation review", reviewedSample: REVIEWED_SAMPLE.id, defaultCriteria: DEFAULT_FACTORY_CRITERIA, productionToolUpgraded: false },
      assistant: { mode: "typed plans; confirmation required", modelInvocation: controllerConfigured(config), engines: controllerConfigured(config) ? enabledProfiles(config) : [],
        transport: controllerTransport(config) ?? null,
        // Visual review: recorded images go to the model only through an executor that pins them by digest.
        images: controllerConfigured(config) && process.env.PAI_EXECUTOR_IMAGES === "1" },
      liveStream: "server-sent events; presentation only",
      controllerMode: "native text proposal only when configured; otherwise read-only accounting" },
  }; });
  app.get("/api/tools", async () => toolCatalog);
  action("createTask", async ({ request }) => workbench.createProject(request.body));
  action("reviseRequirements", async ({ request }) => {
    const input = ReviseProject.parse(request.body);
    const { expectedRevision, ...project } = input;
    const updated = workbench.updateProject(paramId(request.params), expectedRevision, project);
    supersedeForRevision(store, updated, actor(request.headers));
    return updated;
  });
  action("runRecordedReview", async ({ request, reply }) =>
    executeNative(reply, request.body, "review", "runs", () => workbench.runReview(paramId(request.params), request.body)));
  action("recordProposal", async ({ request }) => propose(store, config, workbench.project(paramId(request.params)), request.body));
  action("runScene", async ({ request, reply }) =>
    executeNative(reply, request.body, "scene-review", "scenes", () => reviewScene(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/scenes/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id);
    const stage = scene?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!scene || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("SCENE_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  action("runCadReview", async ({ request, reply }) => {
    await precheckCad(store, config, request.body);
    return executeNative(reply, request.body, "cad-review", "cad", () => reviewCad(store, config, workbench.project(paramId(request.params)), request.body, live));
  });
  action("runSweep", async ({ request, reply }) =>
    executeNative(reply, request.body, "cad-sweep", "cad-sweeps", () => sweepCad(store, config, workbench.project(paramId(request.params)), request.body, live)));
  action("runOptimization", async ({ request, reply }) =>
    executeNative(reply, request.body, "cad-optimize", "cad-optimizations", () => optimizeCad(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/cad-optimizations/:id", async (request, reply) => {
    const run = store.get<CadOptimization>("cad-optimize", paramId(request.params));
    if (!run) throw new DomainError("NOT_FOUND", "Optimisation not found", 404);
    return nativeResponse(run, reply, "cad-optimizations");
  });
  app.get("/api/cad-sweeps/:id", async (request, reply) => {
    const sweep = store.get<CadSweep>("cad-sweep", paramId(request.params));
    if (!sweep) throw new DomainError("NOT_FOUND", "CAD sweep not found", 404);
    return nativeResponse(sweep, reply, "cad-sweeps");
  });
  // Static policy check for the code editor; parses only, never executes.
  action("checkCadCode", async ({ request }) => {
    const { code } = CadCodeCheck.parse(request.body);
    if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "CadQuery 未配置", 503);
    const violations = await checkCadCode(config, code);
    return { ok: violations.length === 0, violations };
  });
  app.get("/api/aero/:id", async (request, reply) => {
    const run = store.get<AeroReview>("aero-review", paramId(request.params));
    if (!run) throw new DomainError("NOT_FOUND", "Aerodynamics review not found", 404);
    return nativeResponse(run, reply, "aero");
  });
  // First-article inspection: the plan of an accepted part, and measured values judged against it (physical evidence).
  app.get("/api/cad/:id/inspection-plan", async request => {
    const cad = store.get<CadReview>("cad-review", paramId(request.params));
    if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
    return { cadReviewId: cad.id, characteristics: inspectionPlan(cad) };
  });
  action("recordInspection", async ({ request }) => recordInspection(store, paramId(request.params), request.body, actor(request.headers)));
  app.get("/api/cad/:id", async (request, reply) => {
    const cad = store.get<CadReview>("cad-review", paramId(request.params));
    if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
    return nativeResponse(cad, reply, "cad");
  });
  app.get("/api/cad/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.union([z.enum([...CAD_FILES, ...FEA_FILES, "dfm.json", "fea.png"]), z.string().regex(CAM_FILE)]) }).parse(request.params);
    const cad = store.get<CadReview>("cad-review", p.id);
    if (!cad || cad.state !== "completed" || !cad.files[`${p.which}/${p.file}`]) throw new DomainError("NOT_FOUND", "Completed CAD evidence required", 404);
    const content = await readFile(join(config.state, "cad", p.id, p.which, p.file));
    if (sha256(content) !== cad.files[`${p.which}/${p.file}`]) throw new DomainError("CAD_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types: Record<string, string> = { "part.step": "application/step", "part.stl": "model/stl", "part.glb": "model/gltf-binary", "assembly.glb": "model/gltf-binary",
      "drawing.svg": "image/svg+xml", "checks.json": "application/json", "fea.json": "application/json", "fea.glb": "model/gltf-binary",
      "bracket-fine.inp": "text/plain", "bracket-fine.frd": "text/plain", "pillow-fine.inp": "text/plain", "pillow-fine.frd": "text/plain", "dfm.json": "application/json", "fea.png": "image/png", "cam.json": "application/json", "cam-verify.json": "application/json", "cam-job.json": "application/json", "cam-sim.png": "image/png" };
    // Generated SVG is displayed as an image only; forbid any script or external fetch inside it.
    if (p.file === "drawing.svg") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    else if (!p.file.endsWith(".glb") && !p.file.endsWith(".png")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    return reply.type(types[p.file] ?? "text/plain").send(content);
  });
  action("runAero", async ({ request, reply }) =>
    executeNative(reply, request.body, "aero-review", "aero", () => reviewAero(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/aero/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(AERO_FILES) }).parse(request.params);
    const run = store.get<AeroReview>("aero-review", p.id);
    if (!run || run.state !== "completed" || !run.files[`${p.which}/${p.file}`]) throw new DomainError("NOT_FOUND", "Completed aerodynamics evidence required", 404);
    const content = await readFile(join(config.state, "aero", p.id, p.which, p.file));
    if (sha256(content) !== run.files[`${p.which}/${p.file}`]) throw new DomainError("AERO_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    if (!p.file.endsWith(".glb")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    const type = p.file.endsWith(".glb") ? "model/gltf-binary" : p.file.endsWith(".json") ? "application/json" : p.file.endsWith(".step") ? "application/step" : p.file.endsWith(".stl") ? "model/stl" : "text/plain";
    return reply.type(type).send(content);
  });
  app.get("/api/aero/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const run = store.get<AeroReview>("aero-review", p.id);
    const stage = run?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!run || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "aero", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("AERO_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  app.get("/api/cad/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const cad = store.get<CadReview>("cad-review", p.id);
    const stage = cad?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!cad || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "cad", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("CAD_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  app.get("/api/live/:requestId", async (request, reply) => {
    const key = paramId(request.params, "requestId");
    const headers = { ...reply.getHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" };
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, headers as Record<string, string>);
    let ended = false;
    const write = (event: Stamped) => { if (!ended) raw.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); };
    const end = () => { if (ended) return; ended = true; clearInterval(heartbeat); subscription.close(); streams.delete(end); raw.end(); };
    const subscription = live.subscribe(key, event => { write(event); if (event.kind === "done") end(); });
    raw.write("retry: 3000\n: presentation-only progress; durable records remain authoritative\n\n");
    for (const event of subscription.replay) write(event);
    // Shared ALB idle timeout is 60 s; comment heartbeats keep the stream open without data.
    const heartbeat = setInterval(() => { if (!ended) raw.write(": heartbeat\n\n"); }, 15_000);
    streams.add(end);
    request.raw.on("close", end);
    if (subscription.done) end();
  });
  action("freezeFactoryCriteria", async ({ request }) =>
    freezeFactoryCriteria(store, workbench.project(paramId(request.params)), request.body));
  action("runFactoryReview", async ({ request }) =>
    reviewFactory(store, config.repository, workbench.project(paramId(request.params)), request.body, live));
  app.get("/api/factory-reviews/:id", async request => {
    const review = store.get<FactoryReview>("factory-review", paramId(request.params));
    if (!review) throw new DomainError("NOT_FOUND", "Factory review not found", 404);
    return review;
  });
  action("planFromRules", async ({ request }) => createPlan(store, request.body, Boolean(config.controllerEntrypoint && config.controllerDatabase),
    deciderConfigured(config) ? message => suggestLane(config, message) : undefined));
  action("planFromModel", async ({ request, reply }) =>
    executeNative(reply, request.body, "assistant-plan", "assistant/plans", async () => { const r = await createAiPlan(store, config, request.body, lifecycle, live); return { ...r, state: r.state ?? "done" }; }));
  app.get("/api/assistant/plans/:id", async (request, reply) => {
    const plan = store.get<AssistantPlan & { state?: string }>("assistant-plan", paramId(request.params));
    if (!plan) throw new DomainError("NOT_FOUND", "Assistant plan not found", 404);
    return nativeResponse({ ...plan, state: plan.state ?? "done" }, reply, "assistant/plans");
  });
  // Grounded planner context and external-agent proposals (used by the MCP server). Proposals carry no authority.
  app.get("/api/assistant/context", async request => {
    const q = z.object({ projectId: Id.optional() }).strict().parse(request.query);
    const p = q.projectId ? workbench.project(q.projectId) : undefined;
    return contextView(store, config, p, p ? lifecycle(p) : undefined);
  });
  app.get("/api/projects/:id/records/:handle", async request => {
    const p = workbench.project(paramId(request.params));
    const handle = z.string().regex(/^(project|[a-z]+-[0-9]{1,3})$/).parse((request.params as { handle?: string }).handle);
    return resolveHandle(store, p, handle, lifecycle(p));
  });
  // Bounded autonomy: a maintainer grants native runs (never approval/release/feedback); plans then run without a click.
  const autonomyDeps = { store, config, live, project: (id: string) => workbench.project(id), lifecycle };
  action("grantAutonomy", async ({ request }) => createGrant(store, workbench.project(paramId(request.params)), request.body, actor(request.headers)));
  app.get("/api/autonomy-grants", async request => {
    const q = z.object({ projectId: Id }).strict().parse(request.query);
    return store.list<{ projectId: string }>("autonomy-grant").filter(g => g.projectId === q.projectId);
  });
  action("revokeAutonomy", async ({ request }) => revokeGrant(store, paramId(request.params), actor(request.headers)));
  action("runUnderGrant", async ({ request }) => {
    const principal = principals.get(request.raw);
    return runUnderGrant(autonomyDeps, paramId(request.params), request.body, principal ? `agent:${principal.clientId}${principal.session ? `:${principal.session}` : ""}` : actor(request.headers));
  });
  action("startAutopilot", async ({ request, reply }) =>
    executeNative(reply, request.body, "autopilot", "autopilots", () => runAutopilot(autonomyDeps, workbench.project(paramId(request.params)), request.body, actor(request.headers))));
  app.get("/api/autopilots/:id", async (request, reply) => {
    const a = store.get<Autopilot>("autopilot", paramId(request.params));
    if (!a) throw new DomainError("NOT_FOUND", "Autopilot not found", 404);
    return nativeResponse(a, reply, "autopilots");
  });
  action("planFromAgent", async ({ request }) => createExternalPlan(store, config, request.body, lifecycle, principals.get(request.raw)));
  action("reconcilePlan", async ({ request }) => reconcileAi(store, config, paramId(request.params), request.body, actor(request.headers)));
  action("preflightPlan", async ({ request }) =>
    preflightPlan(store, paramId(request.params), PreflightStep.parse(request.body).planId));
  action("confirmPlan", async ({ request }) => confirmPlan(store, paramId(request.params), request.body));
  app.get("/api/scenes/:id", async (request, reply) => {
    const scene = store.get<SceneReview>("scene-review", paramId(request.params));
    if (!scene) throw new DomainError("NOT_FOUND", "Scene not found", 404);
    return nativeResponse(scene, reply, "scenes");
  });
  app.get("/api/scenes/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(["scene.blend", "scene.glb", "preview.png", "inspection.png", "checks.json", "robot.json", "scene.xml", "scene.usda", "tool.stl", "robot.glb", "newton.json", "robots.json"]) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id), name = `${p.which}/${p.file}`;
    if (!scene || scene.state !== "completed" || !scene.files[name]) throw new DomainError("NOT_FOUND", "Completed scene evidence required", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, p.file));
    if (sha256(content) !== scene.files[name]) throw new DomainError("SCENE_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types = { "scene.blend": "application/octet-stream", "scene.glb": "model/gltf-binary", "preview.png": "image/png", "inspection.png": "image/png", "checks.json": "application/json", "robot.json": "application/json", "scene.xml": "application/xml", "scene.usda": "model/vnd.usda", "tool.stl": "model/stl", "robot.glb": "model/gltf-binary", "newton.json": "application/json", "robots.json": "application/json" };
    if (!p.file.endsWith(".png") && !p.file.endsWith(".glb")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    return reply.type(types[p.file]).send(content);
  });
  app.get("/api/runs/:id", async (request, reply) => nativeResponse(workbench.review(paramId(request.params)), reply, "runs"));
  action("recordFeedback", async ({ request }) => workbench.createFeedback(request.body));
  action("transitionFeedback", async ({ request }) => workbench.transitionFeedback(paramId(request.params), request.body));
  action("draftCampaign", async ({ request }) => workbench.createCampaign(request.body));
  action("recordTrialEvent", async ({ request }) => workbench.trackEvent(request.body));
  app.get("/api/runs/:id/bundle", async (request, reply) => {
    const id = paramId(request.params);
    reply.header("Content-Disposition", `attachment; filename="pai-review-${id}.json"`);
    return makeBundle(workbench.review(id));
  });
  action("verifyBundle", async ({ request }) => {
    const { bundle: _, ...result } = verifyBundle(request.body); return result;
  });
  app.get("/api/runs/:id/media/:candidate/:seed/:view", async (request, reply) => {
    const p = z.object({ id: Id, candidate: Candidate, seed: z.coerce.number().int().min(0).max(9), view: z.enum(["main", "wrist"]) }).parse(request.params);
    const run = workbench.review(p.id);
    if (run.state !== "completed") throw new DomainError("UNVERIFIED_RUN", "Complete verification before replay");
    const manifestRaw = await readFile(join(config.stressSource, "manifest.json"));
    if (sha256(manifestRaw) !== run.sourceDigests["stress/manifest.json"]) throw new DomainError("SOURCE_CHANGED", "Recording manifest differs from the verified run", 422);
    const name = `runs/seed-${String(p.seed).padStart(2, "0")}-${p.candidate}/attempt-001/${p.view}.mp4`;
    const content = await readFile(join(config.stressSource, name));
    if (sha256(content) !== JSON.parse(manifestRaw.toString()).files[name]) throw new DomainError("MEDIA_CHANGED", "Recording content differs from the verified manifest", 422);
    reply.type("video/mp4").header("Accept-Ranges", "bytes");
    const range = request.headers.range;
    if (!range) return reply.send(content);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return reply.code(416).header("Content-Range", `bytes */${content.length}`).send();
    const start = match[1] ? Number(match[1]) : Math.max(0, content.length - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    if (start >= content.length || end < start) return reply.code(416).header("Content-Range", `bytes */${content.length}`).send();
    return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${content.length}`).send(content.subarray(start, end + 1));
  });
  try {
    await access(config.web);
    await app.register(staticPlugin, { root: resolve(config.web), prefix: "/" });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"));
  } catch { /* API-only mode supports CLI and tests before the web build. */ }
  return { app, workbench, store, routes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = configuration();
  const { app } = await createApp(config);
  await app.listen({ port: config.port, host: config.listenHost ?? "127.0.0.1" });
  console.log(`PAI Design Workbench: ${config.publicOrigin ?? `http://127.0.0.1:${config.port}`}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close().then(() => process.exit(0)));
}
