import { EvidenceKindSchema } from "./ontology/evidence.js";
import { z } from "zod";

export const Candidate = z.enum(["reference", "camera", "dim"]);
export type CandidateId = z.infer<typeof Candidate>;
export const Id = z.uuid();
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Requirements = z.object({
  minSuccessRate: z.number().min(0).max(1),
  preserveBaselineSuccess: z.boolean(),
  requireSignificantImprovement: z.boolean(),
  alpha: z.number().gt(0).lte(0.1),
}).strict();
export const CreateProject = z.object({
  title: z.string().trim().min(1).max(160),
  intendedDecision: z.string().trim().min(5).max(2000),
  requirements: Requirements,
}).strict();
/** PATCH /api/projects/:id: the full requirements plus the revision the caller saw (optimistic concurrency). */
export const ReviseProject = CreateProject.extend({ expectedRevision: z.number().int().positive() }).strict();
/** POST /api/cad/code-check: static policy check of editor code; parses only, never executes. */
export const CadCodeCheck = z.object({ code: z.string().min(1).max(20_000) }).strict();
export const ReviewRequest = z.object({
  requestId: Id,
  projectRevision: z.number().int().positive(),
  candidate: Candidate,
  feedbackId: Id.optional(),
}).strict();
export const CreateFeedback = z.object({
  runId: Id,
  kind: z.enum(["regression", "design-check", "usability", "evidence", "value"]),
  evidenceKind: EvidenceKindSchema.default("robot-review"),
  checkId: z.enum(["footprint-area", "declared-target-envelope", "camera-visibility", "aisle-clearance", "guard-clearance", "camera-coverage", "egress-travel", "reach", "collision-free", "cycle-time", "success-rate",
    "output-per-seed", "demand-intervals", "hall-comfort", "ev-service", "closed-failures",
    "solid-valid", "nema17-interface", "bearing-seat", "shoulder", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope", "max-deflection", "max-stress", "bore-distortion",
    "drag-coefficient", "grid-convergence", "iterative-convergence", "mesh-quality",
    "machining-setups", "hole-drillability", "fastener-access", "unit-cost", "cam-toolpath", "cycle-time"]).optional(),
  // Robot panels use seeds 0–9; Factory Twin panels use their own recorded seed IDs.
  seed: z.number().int().min(0).max(1000).nullable(),
  expected: z.string().trim().min(1).max(2000),
  observed: z.string().trim().min(1).max(2000),
  actorKind: z.enum(["maintainer", "independent", "fixture"]),
}).strict();
export const FeedbackStatus = z.enum([
  "received", "needs-context", "reproducible", "assigned",
  "fix-proposed", "no-change-with-reason", "rechecked", "closed",
]);
export const TransitionFeedback = z.object({
  expectedRevision: z.number().int().positive(),
  status: FeedbackStatus,
  reason: z.string().trim().min(5).max(2000),
  recheckRunId: Id.optional(),
}).strict();
export const CreateCampaign = z.object({
  runId: Id,
  evidenceKind: EvidenceKindSchema.default("robot-review"),
  channel: z.enum(["hugging-face", "github", "website", "bilibili", "youtube", "direct-pilot"]),
}).strict();
export const TrackEvent = z.object({
  eventId: Id,
  campaignId: Id,
  participantId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  actorKind: z.enum(["maintainer", "independent", "fixture"]),
  kind: z.enum(["started", "completed", "evidence-reopened", "feedback", "repeat-use"]),
}).strict();

const Condition = z.object({
  id: Candidate, trials: z.number().int().positive(), successes: z.number().int().nonnegative(),
  wilson95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  mean_policy_seconds: z.number().nonnegative(),
}).passthrough();
const Pair = z.object({
  seed: z.number().int().min(0).max(9), condition: z.enum(["camera", "dim"]),
  reference_success: z.boolean(), condition_success: z.boolean(),
}).passthrough();
export const NativeStress = z.object({
  planned_trials: z.literal(30), completed_trials: z.literal(30),
  attempts: z.number().int().gte(30), execution_errors: z.literal(0),
  conditions: z.array(Condition).length(3), pairs: z.array(Pair).length(20),
  paired_exact_test: z.object({
    comparisons: z.array(z.object({
      condition: z.enum(["camera", "dim"]), paired_seeds: z.literal(10),
      lost_success: z.number().int().min(0).max(10),
      gained_success: z.number().int().min(0).max(10),
      exact_p_two_sided: z.number().min(0).max(1),
      holm_adjusted_p: z.number().min(0).max(1),
    }).passthrough()).length(2),
    method: z.string(), scope: z.string(),
  }).passthrough(),
}).passthrough();
export type StressResult = z.infer<typeof NativeStress>;
export const NativeDiff = z.object({
  schema_version: z.literal("evalarc.results-diff.v1"),
  gate_passed: z.boolean(), blocking_changes: z.number().int().nonnegative(),
  changes: z.array(z.object({
    case_id: z.string(), check: z.string(), kind: z.string(),
  }).passthrough()),
  interpretation: z.string(),
}).passthrough();
export type DiffResult = z.infer<typeof NativeDiff>;
export const RadarDocument = z.object({
  date: z.string(),
  picked: z.array(z.object({
    id: z.string(), title: z.string(), url: z.url().refine(value => /^https?:\/\//.test(value)),
    evidence: z.enum(["O", "R", "M"]), lane: z.string(),
    published: z.string(), summary: z.string(),
  }).passthrough()).max(100),
}).passthrough();
export type RadarResult = z.infer<typeof RadarDocument>;

export interface Receipt {
  adapter: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdoutSha256: string;
  sourceDigests: Record<string, string>;
}
export interface ProjectVersion {
  id: string; projectId: string; revision: number; title: string; intendedDecision: string;
  requirements: Project["requirements"]; requirementDigest: string; frozenAt: string;
}
export interface Project extends z.infer<typeof CreateProject> {
  id: string; revision: number; createdAt: string;
}
export interface Decision {
  verdict: "accepted-in-recorded-panel" | "rejected" | "needs-more-evidence";
  checks: { id: string; passed: boolean | null; detail: string }[];
  scope: "retrospective-recorded-simulation";
  physicalValidation: false;
}
export interface Review {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof ReviewRequest>;
  requestDigest: string; requirementDigest: string; project: Project;
  state: "running" | "completed" | "interrupted" | "failed";
  createdAt: string; finishedAt?: string; error?: string;
  candidate: CandidateId; feedbackId?: string;
  stress?: StressResult; diff?: DiffResult; decision?: Decision;
  receipts: Receipt[]; artifacts: Record<string, string>;
  sourceDigests: Record<string, string>; radar?: RadarResult;
  controller?: { state: string; mode: "read-only-accounting"; publicationApproved: false };
}
export interface Feedback extends z.infer<typeof CreateFeedback> {
  id: string; projectId: string; revision: number; status: z.infer<typeof FeedbackStatus>;
  history: { status: string; reason: string; at: string; recheckRunId?: string }[];
}
export interface Campaign extends z.infer<typeof CreateCampaign> {
  id: string; projectId: string; state: "draft"; text: string; createdAt: string;
}
