/**
 * PAI ontology (`pai-ontology-1`): the platform's single semantic model, in the object / link / action pattern of
 * operational ontologies (Palantir Foundry). It is derived from the code that already enforces it, never a second copy:
 *
 * - every stored record kind is exactly one object type (contract test: tests/ontology.test.ts);
 * - links are the reference fields the records really carry (polymorphic links name their discriminator);
 * - every write route is exactly one action type, and action parameters are the route's own Zod schema, exported as
 *   JSON Schema. Adding a write route without an action type, or an action without a route, fails the build.
 *
 * Standard vocabularies are mapped, not reinvented: W3C PROV-O for provenance roles, QUDT for units, and the
 * existing native formats (STEP, MJCF, OpenUSD) for geometry. Export: JSON (/api/v1/ontology) and OWL 2 + SHACL
 * in Turtle (/api/v1/ontology.ttl).
 */
import { z } from "zod";
import type { RecordKind } from "./kinds.js";
import { CadCodeCheck, CreateCampaign, CreateFeedback, CreateProject, ReviewRequest, ReviseProject, TrackEvent, TransitionFeedback } from "../contracts.js";
import { SceneRequest } from "../scenes.js";
import { CadRequest } from "../cad.js";
import { SweepRequest } from "../sweep.js";
import { OptimizeRequest } from "../optimize.js";
import { InspectionInput } from "../inspection.js";
import { AeroRequest } from "../aero.js";
import { FactoryCriteriaRequest, FactoryReviewRequest } from "../factory.js";
import { AssistantInput, ConfirmPlan, PreflightStep } from "../assistant.js";
import { AiInput, AiReconcile, ExternalPlanInput } from "../ai.js";
import { CreateGrant, RunUnderGrant } from "../autonomy.js";
import { AutopilotRequest } from "../autopilot.js";
import { ProposalInput } from "../proposals.js";
import { KIND_STORE, ReleaseDecision, ReleaseRequest } from "../release.js";
import { CreateArtifact, Transition } from "../artifacts/registry.js";
import { PackageSubmission } from "../signing.js";
import { Bundle } from "../bundle.js";
import { OfferWorkflow, RevokeOffering, TenantRunRequest } from "../tenants.js";
import { Decision as RunDecision, StartRun, WorkflowDefinition } from "../artifacts/workflows.js";

export const ONTOLOGY_SCHEMA = "pai-ontology-1";
export const ONTOLOGY_VERSION = "1.0.0";
export const NS = "https://pai.oneai.host/ontology/1#";
const PROV = "http://www.w3.org/ns/prov#";

type Prov = "Entity" | "Activity" | "Plan" | "Agent" | "Collection";
export interface ObjectType {
  /** PascalCase API name. */ id: string;
  /** Store kind backing the type; `runtime` types are computed from configuration, not stored. */ kind: RecordKind | null;
  label: string; description: string; prov: Prov;
  /** Property shown as the object's title in lists. */ title: string;
  /** Properties every record of this type carries (checked against records in tests). */ properties: string[];
  /** Records are append-only: no action updates them in place. */ immutable?: boolean;
}
export interface LinkType {
  id: string; from: string; via: string; cardinality: "many-to-one" | "many-to-many";
  /** Target type, or a discriminator field whose value selects the target type. */
  to: string | { field: string; map: Record<string, string> };
  prov?: "wasDerivedFrom" | "used" | "wasGeneratedBy" | "wasAssociatedWith" | "wasInformedBy";
}
export type Effect = "create" | "update" | "transition" | "execute-native" | "verify" | "propose";
export interface ActionType {
  id: string; label: string; method: "POST" | "PATCH"; route: string;
  /** Object types written (empty for verify-only actions). */ writes: string[]; effect: Effect;
  /** Who may submit it: a signed-in maintainer, an agent with a scope, or autonomy within a grant. */
  submitters: ("maintainer" | "agent:propose" | "agent:run" | "agent:read" | "tenant")[];
  /** Starts native tools or a model; such runs are claimed by requestId and never replayed automatically. */
  native?: boolean;
  /** Parameters: the route's own input schema. */ parameters?: z.ZodType;
}

const T = (id: string, kind: RecordKind | null, label: string, prov: Prov, title: string, description: string, properties: string[], immutable = false): ObjectType =>
  ({ id, kind, label, prov, title, description, properties: ["id", ...properties], ...(immutable ? { immutable } : {}) });

export const OBJECT_TYPES: ObjectType[] = [
  T("DesignTask", "project", "设计任务", "Entity", "title", "A decision to be made, with frozen acceptance requirements; revisions are versions.", ["title", "intendedDecision", "requirements", "revision", "createdAt"]),
  T("RequirementVersion", "project-version", "需求版本", "Entity", "title", "An append-only snapshot of a task's requirements and their digest.", ["projectId", "revision", "requirementDigest", "frozenAt"], true),
  T("RecordedReview", "review", "记录评审", "Activity", "candidate", "Robot Reel recorded-simulation review of a candidate against the frozen requirements.", ["projectId", "state", "createdAt"]),
  T("SceneReview", "scene-review", "场景评审", "Activity", "id", "Blender scene, factory line or MuJoCo robot cell built and measured natively.", ["projectId", "state", "createdAt"]),
  T("CadReview", "cad-review", "零件评审", "Activity", "id", "CadQuery/OCCT part with B-Rep, DFM, FEA and CAM checks.", ["projectId", "state", "createdAt"]),
  T("DesignSweep", "cad-sweep", "设计空间扫描", "Activity", "id", "Grid of native CAD (and FEA) points; feasible set and Pareto front.", ["projectId", "state", "createdAt"]),
  T("Optimization", "cad-optimize", "物理寻优", "Activity", "id", "Surrogate-ranked optimisation where every recommended point is solved natively.", ["projectId", "state", "createdAt"]),
  T("FirstArticleInspection", "cad-inspection", "首件检验", "Activity", "id", "Measured values against frozen tolerances; the only physical-measurement record.", ["projectId", "cadReviewId", "createdAt"], true),
  T("AeroReview", "aero-review", "气动评审", "Activity", "id", "OpenFOAM RANS on two mesh levels.", ["projectId", "state", "createdAt"]),
  T("FactoryCriteria", "factory-criteria", "工厂验收标准", "Entity", "id", "Frozen factory maintenance and energy criteria.", ["projectId", "digest", "createdAt"], true),
  T("FactoryReview", "factory-review", "工厂孪生评估", "Activity", "id", "Factory Twin seeds judged against frozen criteria.", ["projectId", "criteriaId", "verdict", "createdAt"]),
  T("Feedback", "feedback", "反馈", "Entity", "checkId", "A failing case, closed only by a bound recheck.", ["projectId", "runId", "evidenceKind", "status", "history"]),
  T("Campaign", "campaign", "案例草稿", "Entity", "channel", "Case draft prepared from evidence; never sent automatically.", ["projectId", "runId", "evidenceKind", "createdAt"]),
  T("TrialEvent", "event", "试用观察", "Entity", "kind", "Observed pilot use, separated by actor kind.", ["kind", "actorKind", "at"], true),
  T("Plan", "assistant-plan", "AI 计划", "Plan", "message", "Typed plan from rules, a model or an external agent; authority none until confirmed or run under a grant.", ["plans", "authority", "createdAt"]),
  T("Proposal", "proposal", "模型提议", "Plan", "id", "Recorded model proposal for a task.", ["projectId", "createdAt"]),
  T("AutonomyGrant", "autonomy-grant", "自主授权", "Entity", "id", "Maintainer grant: tools, run count and expiry for autonomous execution.", ["projectId", "tools", "expiresAt"]),
  T("AutopilotRun", "autopilot", "自主迭代", "Activity", "goal", "Bounded propose → native check → revise rounds within one grant.", ["projectId", "grantId", "state"]),
  T("Release", "release", "发布", "Entity", "number", "Release candidate and decision; admission checks; supersession on revision.", ["projectId", "evidenceKind", "runId", "maturity", "history"]),
  T("ReleaseSeal", "release-seal", "发布封存", "Entity", "id", "KMS signature, RFC 3161 time stamp and optional Object Lock archive; one per release.", ["releaseId", "projectId"], true),
  T("Artifact", "artifact", "制品版本", "Entity", "id", "Immutable algorithm or model version (pai-artifact-1): accepted by its own benchmark, released by a person.", ["state", "digest", "tenant"]),
  T("ArtifactFile", "artifact-file", "制品文件", "Entity", "id", "A file of an artifact version, identified by digest.", ["sha256"], true),
  T("Workflow", "workflow", "流程", "Plan", "id", "Typed JSON business process over exact artifact versions (pai-workflow-1).", ["tenant"]),
  T("WorkflowRun", "workflow-run", "流程运行", "Activity", "id", "One run: per-node outputs, receipts and pai-usage-1; no automatic retry.", ["workflowId", "state", "tenant"]),
  T("Offering", "offering", "对外提供", "Entity", "workflowId", "A maintainer's offer of one workflow (at its digest) to invite-only tenants; revocable.", ["workflowId", "workflowDigest", "tenants", "state", "createdAt"]),
  T("AuditEvent", "audit-event", "审计记录", "Activity", "action", "One write attempt through an action: action, caller, actor, path ids, outcome and duration; never the request body. Append-only.", ["at", "action", "caller", "actor", "status", "outcome"], true),
  T("Engine", null, "原生引擎", "Agent", "name", "A native solver or model the platform runs (computed from configuration and pins; not stored).", ["name", "version", "available"]),
];

const RUN_TARGET = { field: "evidenceKind", map: Object.fromEntries(Object.entries(KIND_STORE).map(([k, kind]) => [k, OBJECT_TYPES.find(t => t.kind === kind)!.id])) };
const L = (id: string, from: string, via: string, to: LinkType["to"], prov?: LinkType["prov"], cardinality: LinkType["cardinality"] = "many-to-one"): LinkType =>
  ({ id, from, via, to, cardinality, ...(prov ? { prov } : {}) });

export const LINK_TYPES: LinkType[] = [
  ...["RequirementVersion", "RecordedReview", "SceneReview", "CadReview", "DesignSweep", "Optimization", "FirstArticleInspection", "AeroReview",
    "FactoryCriteria", "FactoryReview", "Feedback", "Campaign", "Plan", "Proposal", "AutonomyGrant", "AutopilotRun", "Release", "ReleaseSeal"]
    .map(from => L(`${from}.task`, from, "projectId", "DesignTask", from === "RequirementVersion" ? "wasDerivedFrom" : "used")),
  L("Feedback.run", "Feedback", "runId", RUN_TARGET, "wasDerivedFrom"),
  L("Release.evidence", "Release", "runId", RUN_TARGET, "wasDerivedFrom"),
  L("Campaign.run", "Campaign", "runId", { field: "evidenceKind", map: RUN_TARGET.map }, "wasDerivedFrom"),
  ...["RecordedReview", "SceneReview", "CadReview", "FactoryReview"].map(from => L(`${from}.recheckOf`, from, "feedbackId", "Feedback", "wasInformedBy")),
  L("FirstArticleInspection.part", "FirstArticleInspection", "cadReviewId", "CadReview", "used"),
  L("FactoryReview.criteria", "FactoryReview", "criteriaId", "FactoryCriteria", "used"),
  L("AutopilotRun.grant", "AutopilotRun", "grantId", "AutonomyGrant", "wasAssociatedWith"),
  L("ReleaseSeal.release", "ReleaseSeal", "releaseId", "Release", "wasDerivedFrom"),
  L("WorkflowRun.workflow", "WorkflowRun", "workflowId", "Workflow", "used"),
  L("Offering.workflow", "Offering", "workflowId", "Workflow", "used"),
];

const A = (id: string, label: string, method: ActionType["method"], route: string, writes: string[], effect: Effect,
  submitters: ActionType["submitters"], parameters?: z.ZodType, native = false): ActionType =>
  ({ id, label, method, route, writes, effect, submitters, ...(parameters ? { parameters } : {}), ...(native ? { native } : {}) });
const M: ActionType["submitters"] = ["maintainer"];

export const ACTION_TYPES: ActionType[] = [
  A("createTask", "新建设计任务", "POST", "/api/projects", ["DesignTask", "RequirementVersion"], "create", M, CreateProject),
  A("reviseRequirements", "修订需求（新版本）", "PATCH", "/api/projects/:id", ["DesignTask", "RequirementVersion", "Release"], "update", M, ReviseProject),
  A("runRecordedReview", "记录评审", "POST", "/api/projects/:id/reviews", ["RecordedReview"], "execute-native", M, ReviewRequest, true),
  A("recordProposal", "记录模型提议", "POST", "/api/projects/:id/proposals", ["Proposal"], "propose", M, ProposalInput, true),
  A("runScene", "原生场景 / 产线 / 机器人单元", "POST", "/api/projects/:id/scenes", ["SceneReview"], "execute-native", M, SceneRequest, true),
  A("runCadReview", "原生零件评审", "POST", "/api/projects/:id/cad", ["CadReview"], "execute-native", M, CadRequest, true),
  A("runSweep", "设计空间扫描", "POST", "/api/projects/:id/cad-sweeps", ["DesignSweep"], "execute-native", M, SweepRequest, true),
  A("runOptimization", "物理寻优", "POST", "/api/projects/:id/cad-optimizations", ["Optimization"], "execute-native", M, OptimizeRequest, true),
  A("checkCadCode", "生成代码策略检查", "POST", "/api/cad/code-check", [], "verify", ["maintainer", "agent:read"], CadCodeCheck),
  A("recordInspection", "录入首件检验", "POST", "/api/cad/:id/inspections", ["FirstArticleInspection"], "create", M, InspectionInput),
  A("runAero", "原生气动评审", "POST", "/api/projects/:id/aero", ["AeroReview"], "execute-native", M, AeroRequest, true),
  A("freezeFactoryCriteria", "冻结工厂标准", "POST", "/api/projects/:id/factory-criteria", ["FactoryCriteria"], "create", M, FactoryCriteriaRequest),
  A("runFactoryReview", "工厂孪生评估", "POST", "/api/projects/:id/factory-reviews", ["FactoryReview"], "execute-native", M, FactoryReviewRequest, true),
  A("planFromRules", "规则生成计划", "POST", "/api/assistant/plans", ["Plan"], "propose", M, AssistantInput),
  A("planFromModel", "模型生成计划", "POST", "/api/assistant/ai", ["Plan"], "propose", M, AiInput, true),
  A("planFromAgent", "外部 Agent 计划", "POST", "/api/assistant/external-plans", ["Plan"], "propose", ["maintainer", "agent:propose"], ExternalPlanInput),
  A("reconcilePlan", "核对未知效果", "POST", "/api/assistant/plans/:id/reconciliation", ["Plan"], "transition", M, AiReconcile),
  A("preflightPlan", "计划预检", "POST", "/api/assistant/plans/:id/preflight", [], "verify", M, PreflightStep),
  A("confirmPlan", "确认执行计划", "POST", "/api/assistant/plans/:id/confirmations", ["Plan"], "execute-native", M, ConfirmPlan, true),
  A("grantAutonomy", "签发自主授权", "POST", "/api/projects/:id/autonomy-grants", ["AutonomyGrant"], "create", M, CreateGrant),
  A("revokeAutonomy", "撤销授权", "POST", "/api/autonomy-grants/:id/revoke", ["AutonomyGrant"], "transition", M),
  A("runUnderGrant", "授权内执行", "POST", "/api/assistant/plans/:id/autonomous-runs", ["Plan"], "execute-native", ["maintainer", "agent:run"], RunUnderGrant, true),
  A("startAutopilot", "自主迭代", "POST", "/api/projects/:id/autopilot", ["AutopilotRun"], "execute-native", M, AutopilotRequest, true),
  A("recordFeedback", "登记失败案例", "POST", "/api/feedback", ["Feedback"], "create", M, CreateFeedback),
  A("transitionFeedback", "推进反馈", "PATCH", "/api/feedback/:id", ["Feedback"], "transition", M, TransitionFeedback),
  A("draftCampaign", "生成案例草稿", "POST", "/api/campaigns", ["Campaign"], "create", M, CreateCampaign),
  A("recordTrialEvent", "记录试用观察", "POST", "/api/events", ["TrialEvent"], "create", M, TrackEvent),
  A("createReleaseCandidate", "创建发布候选", "POST", "/api/projects/:id/releases", ["Release"], "create", M, ReleaseRequest),
  A("decideRelease", "审批发布", "PATCH", "/api/projects/:id/releases/:releaseId", ["Release", "ReleaseSeal"], "transition", M, ReleaseDecision),
  A("verifyReleasePackage", "核验发布包", "POST", "/api/packages/verify", [], "verify", M, PackageSubmission),
  A("verifyBundle", "核验交接包", "POST", "/api/bundles/verify", [], "verify", M, Bundle),
  A("buildArtifact", "从可信源构建制品版本", "POST", "/api/v1/artifacts", ["Artifact", "ArtifactFile"], "create", M, CreateArtifact),
  A("validateArtifact", "运行验收基准", "POST", "/api/v1/artifacts/:id/validation", ["Artifact"], "execute-native", M, undefined, true),
  A("decideArtifact", "发布 / 弃用制品", "POST", "/api/v1/artifacts/:id/lifecycle", ["Artifact"], "transition", M, Transition),
  A("sampleArtifactInput", "生成样例输入", "POST", "/api/v1/artifacts/:id/samples", [], "verify", M),
  A("verifyArtifactPackage", "核验制品包", "POST", "/api/v1/artifact-packages/verification", [], "verify", M, PackageSubmission),
  A("importArtifact", "导入制品包", "POST", "/api/v1/artifact-packages", ["Artifact", "ArtifactFile"], "create", M, PackageSubmission),
  A("validateWorkflow", "校验流程", "POST", "/api/v1/workflow-validation", [], "verify", M, WorkflowDefinition),
  A("saveWorkflow", "保存流程", "POST", "/api/v1/workflows", ["Workflow"], "create", M, WorkflowDefinition),
  A("startWorkflowRun", "运行流程", "POST", "/api/v1/workflow-runs", ["WorkflowRun"], "execute-native", M, StartRun, true),
  A("decideWorkflowStep", "人工确认节点", "POST", "/api/v1/workflow-runs/:id/decisions", ["WorkflowRun"], "execute-native", M, RunDecision, true),
  A("offerWorkflow", "向租户提供流程", "POST", "/api/v1/offerings", ["Offering"], "create", M, OfferWorkflow),
  A("revokeOffering", "撤销对外提供", "POST", "/api/v1/offerings/:id/revoke", ["Offering"], "transition", M, RevokeOffering),
  A("startTenantRun", "租户运行流程", "POST", "/api/v1/tenant/runs", ["WorkflowRun"], "execute-native", ["tenant"], TenantRunRequest, true),
  A("decideTenantRunStep", "租户确认节点", "POST", "/api/v1/tenant/runs/:id/decisions", ["WorkflowRun"], "execute-native", ["tenant"], RunDecision, true),
  A("resumeWorkflowRun", "恢复流程", "POST", "/api/v1/workflow-runs/:id/resume", ["WorkflowRun"], "execute-native", M, undefined, true),
];

/**
 * Workspace projection (ADR 0003 step 5): the object types the workspace snapshot (/api/state, and /api/agent/state for
 * agents) returns, under these field names. The snapshot is generated from this table, and agents' object reads are
 * limited to exactly these kinds, so the two can never drift.
 */
export const WORKSPACE_FIELDS = {
  "project": "projects",
  "project-version": "projectVersions",
  "review": "reviews",
  "scene-review": "scenes",
  "cad-review": "cads",
  "cad-sweep": "cadSweeps",
  "cad-optimize": "cadOptimizations",
  "cad-inspection": "inspections",
  "aero-review": "aeros",
  "factory-criteria": "factoryCriteria",
  "factory-review": "factoryReviews",
  "feedback": "feedback",
  "campaign": "campaigns",
  "assistant-plan": "assistantPlans",
  "proposal": "proposals",
  "autonomy-grant": "autonomyGrants",
  "autopilot": "autopilots",
  "release": "releases",
  "release-seal": "releaseSeals",
} as const satisfies Partial<Record<RecordKind, string>>;
export const AGENT_STATE_KINDS = Object.keys(WORKSPACE_FIELDS) as (keyof typeof WORKSPACE_FIELDS)[];
/** Never served as objects: file bytes belong to their artifact version and its signed package. */
export const NOT_OBJECT_READABLE = ["artifact-file"] as const;
export const objectReadable = (t: ObjectType) => Boolean(t.kind) && !(NOT_OBJECT_READABLE as readonly string[]).includes(t.kind!);
export const agentReadable = (t: ObjectType) => objectReadable(t) && (AGENT_STATE_KINDS as readonly string[]).includes(t.kind!);
export const objectType = (id: string) => OBJECT_TYPES.find(t => t.id === id);
export const objectTypeOfKind = (kind: string) => OBJECT_TYPES.find(t => t.kind === kind);

const jsonSchema = (schema: z.ZodType) => {
  try { return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }); } catch { return { description: "schema not representable as JSON Schema" }; }
};

/** Serializable ontology description; `digest` identifies this exact model. */
export function describeOntology() {
  const actionTypes = ACTION_TYPES.map(({ parameters, ...a }) => ({ ...a, ...(parameters ? { parameters: jsonSchema(parameters) } : {}) }));
  return { schema: ONTOLOGY_SCHEMA, version: ONTOLOGY_VERSION, namespace: NS,
    standards: { provenance: "W3C PROV-O", units: "QUDT", shapes: "W3C SHACL", geometry: ["ISO 10303 STEP", "MJCF", "OpenUSD"] },
    objectTypes: OBJECT_TYPES, linkTypes: LINK_TYPES, actionTypes };
}

/** OWL 2 classes and object properties plus SHACL node shapes, as Turtle. */
export function ontologyTurtle(): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const out = [`@prefix pai: <${NS}> .`, `@prefix owl: <http://www.w3.org/2002/07/owl#> .`, `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`, `@prefix sh: <http://www.w3.org/ns/shacl#> .`, `@prefix prov: <${PROV}> .`, "",
    `<${NS.slice(0, -1)}> a owl:Ontology ; owl:versionInfo "${ONTOLOGY_VERSION}" ; rdfs:label "PAI Physical AI engine platform ontology" .`, ""];
  for (const t of OBJECT_TYPES) {
    out.push(`pai:${t.id} a owl:Class ; rdfs:subClassOf prov:${t.prov} ; rdfs:label "${esc(t.label)}"@zh , "${t.id}"@en ; rdfs:comment "${esc(t.description)}"@en .`);
    const links = LINK_TYPES.filter(l => l.from === t.id && typeof l.to === "string");
    const props = t.properties.map(p => `  sh:property [ sh:path pai:${p} ; sh:minCount 1 ]`);
    const linkProps = links.map(l => `  sh:property [ sh:path pai:${l.via} ; sh:class pai:${l.to} ; sh:maxCount 1 ]`);
    out.push(`pai:${t.id}Shape a sh:NodeShape ; sh:targetClass pai:${t.id} ;\n${[...props, ...linkProps].join(" ;\n")} .`);
  }
  for (const l of LINK_TYPES) {
    const range = typeof l.to === "string" ? ` ; rdfs:range pai:${l.to}` : "";
    out.push(`pai:${l.id.replace(".", "_")} a owl:ObjectProperty ; rdfs:domain pai:${l.from}${range}${l.prov ? ` ; rdfs:subPropertyOf prov:${l.prov}` : ""} ; rdfs:label "${l.via}" .`);
  }
  for (const a of ACTION_TYPES) out.push(`pai:${a.id} a prov:Plan ; rdfs:label "${esc(a.label)}"@zh ; rdfs:comment "${a.method} ${a.route} (${a.effect})" .`);
  return out.join("\n") + "\n";
}
