import { EVIDENCE_RECORD_KIND } from "./ontology/evidence.js";
import { EvidenceKindSchema } from "./ontology/evidence.js";
import { randomUUID } from "node:crypto";
import type { RecordKind } from "./ontology/kinds.js";
import { z } from "zod";
import { Id, type Feedback, type Project } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { Store } from "./store.js";
import type { Lifecycle, EvidenceKind } from "./lifecycle.js";

/**
 * Design release with maturity, modelled on PDM release candidates (Onshape) and maturity states /
 * change actions (3DEXPERIENCE): a candidate binds one completed, passing review to the current frozen
 * requirement version; admission checks are computed by the server; a maintainer approves or rejects.
 * A release records "this design decision is adopted within this evidence scope" — never physical
 * validation, production approval or publication. Nothing is sent anywhere.
 */
export type Maturity = "in-review" | "released" | "rejected" | "superseded";
export const ReleaseRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(),
  evidenceKind: EvidenceKindSchema, runId: Id,
  title: z.string().trim().min(2).max(160), notes: z.string().trim().max(2000).default(""),
}).strict();
export const ReleaseDecision = z.object({
  expectedRevision: z.number().int().positive(), decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(5).max(2000),
}).strict();
export interface AdmissionCheck { id: string; passed: boolean; detail: string }
export interface Release {
  id: string; projectId: string; revision: number; number: string; title: string; notes: string;
  evidenceKind: EvidenceKind; runId: string; projectRevision: number; requirementDigest: string;
  maturity: Maturity; admission: AdmissionCheck[]; scope: string; createdAt: string;
  history: { maturity: Maturity; reason: string; at: string; actor: string }[];
  physicalValidation: false; publicationApproved: false;
}
const PASSING: Record<EvidenceKind, string> = {
  "robot-review": "accepted-in-recorded-panel", "blender-scene": "accepted-static-scene",
  "cad-part": "accepted-cad-part", "factory-twin": "accepted-illustrative", "aero-body": "accepted-aero-body",
};
const VERDICT_LABEL: Record<string, string> = { "accepted-in-recorded-panel": "记录样本内通过", "accepted-static-scene": "静态场景通过",
  "accepted-cad-part": "零件检查通过", "accepted-aero-body": "气动检查通过", "accepted-illustrative": "演示范围内通过", rejected: "拒绝", "needs-more-evidence": "需要更多证据" };
const SCOPE: Record<EvidenceKind, string> = {
  "robot-review": "回顾性记录仿真：1 个任务、10 个配对种子",
  "blender-scene": "合成静态几何：射线与投影检查",
  "cad-part": "名义参数化几何：B-Rep 实测与 DFM 经验规则",
  "factory-twin": "演示仿真：参数未按真实工厂校准",
  "aero-body": "稳态 RANS（k-ω SST）两级网格：设计比较用的阻力系数，不是风洞实测",
};
type Run = { id: string; projectId: string; projectRevision: number; state: string; verdict?: string; decision?: { verdict: string } };
/** Store kind of each evidence kind (single table in the ontology). */
export const KIND_STORE: Record<EvidenceKind, RecordKind> = EVIDENCE_RECORD_KIND;

export function admission(store: Store, project: Project, lifecycle: Lifecycle, kind: EvidenceKind, runId: string): AdmissionCheck[] {
  const run = store.get<Run>(KIND_STORE[kind], runId);
  if (!run || run.projectId !== project.id) throw new DomainError("NOT_FOUND", "Evidence not found for this project", 404);
  const verdict = run.verdict ?? run.decision?.verdict;
  const feedback = store.list<Feedback>("feedback").filter(f => f.projectId === project.id);
  const open = feedback.filter(f => f.status !== "closed");
  const uncovered = lifecycle.failingCases.filter(c => !c.feedbackId || c.feedbackStatus !== "closed");
  return [
    { id: "evidence-completed", passed: run.state === "completed", detail: `检查状态：${({ completed: "已完成", running: "运行中", failed: "失败", interrupted: "已中断" } as Record<string, string>)[run.state] ?? run.state}` },
    { id: "evidence-accepted", passed: verdict === PASSING[kind], detail: `结论：${VERDICT_LABEL[verdict ?? ""] ?? verdict ?? "无"}；需要“${VERDICT_LABEL[PASSING[kind]]}”` },
    { id: "current-requirements", passed: run.projectRevision === project.revision, detail: `检查绑定需求 v${run.projectRevision}；当前 v${project.revision}` },
    { id: "failures-dispositioned", passed: uncovered.length === 0, detail: uncovered.length
      ? `${uncovered.length} 个失败案例尚未通过已关闭的反馈处置：${uncovered.slice(0, 3).map(c => c.label).join("；")}` : "所有保留的失败案例都有已关闭的反馈" },
    { id: "no-open-feedback", passed: open.length === 0, detail: open.length ? `${open.length} 条反馈未关闭` : "没有未关闭的反馈" },
  ];
}

export function createRelease(store: Store, project: Project, lifecycle: Lifecycle, input: unknown, actor: string): Release {
  const request = ReleaseRequest.parse(input);
  if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Release must use the current requirement revision");
  const checks = admission(store, project, lifecycle, request.evidenceKind, request.runId);
  const failed = checks.filter(c => !c.passed);
  if (failed.length) throw new DomainError("RELEASE_NOT_ADMISSIBLE", `发布准入未满足：${failed.map(c => c.detail).join("；")}`, 422);
  const prior = store.list<Release>("release").filter(r => r.projectId === project.id);
  if (prior.some(r => r.maturity === "in-review")) throw new DomainError("RELEASE_PENDING", "已有待审批的发布候选；先批准或驳回", 409);
  const now = new Date().toISOString();
  const record: Release = {
    id: randomUUID(), projectId: project.id, revision: 1, number: `R${prior.length + 1}`, title: request.title, notes: request.notes,
    evidenceKind: request.evidenceKind, runId: request.runId, projectRevision: project.revision,
    requirementDigest: sha256(canonical(project.requirements)), maturity: "in-review", admission: checks, scope: SCOPE[request.evidenceKind],
    createdAt: now, history: [{ maturity: "in-review", reason: "发布候选已创建；准入检查全部通过", at: now, actor }],
    physicalValidation: false, publicationApproved: false,
  };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "release", projectId: project.id, request })), record, "release");
  return claimed === record.id ? record : store.get<Release>("release", claimed)!;
}

export function decideRelease(store: Store, project: Project, lifecycle: Lifecycle, id: string, input: unknown, actor: string): Release {
  const change = ReleaseDecision.parse(input);
  const release = store.get<Release>("release", id);
  if (!release || release.projectId !== project.id) throw new DomainError("NOT_FOUND", "Release not found", 404);
  if (release.revision !== change.expectedRevision) throw new DomainError("REVISION_CONFLICT", "Release changed; reload it");
  if (release.maturity !== "in-review") throw new DomainError("INVALID_TRANSITION", "只有待审批的发布候选可以批准或驳回");
  let maturity: Maturity = change.decision === "approve" ? "released" : "rejected";
  let admissionNow = release.admission;
  if (maturity === "released") {
    // Re-check at approval time: requirements, evidence or feedback may have changed since the candidate.
    admissionNow = admission(store, project, lifecycle, release.evidenceKind, release.runId);
    const failed = admissionNow.filter(c => !c.passed);
    if (failed.length || release.requirementDigest !== sha256(canonical(project.requirements))) {
      throw new DomainError("RELEASE_NOT_ADMISSIBLE", `批准时复核未通过：${failed.map(c => c.detail).join("；") || "需求已变化"}`, 422);
    }
  }
  const now = new Date().toISOString();
  const history = [...release.history, { maturity, reason: change.reason, at: now, actor }];
  const next: Release = { ...release, revision: release.revision + 1, maturity, admission: admissionNow, history };
  store.put("release", next, change.expectedRevision);
  if (maturity === "released") {
    // One effective release per project: an earlier release becomes superseded, never deleted.
    for (const r of store.list<Release>("release").filter(x => x.projectId === project.id && x.id !== id && x.maturity === "released")) {
      const old: Release = { ...r, revision: r.revision + 1, maturity: "superseded",
        history: [...r.history, { maturity: "superseded", reason: `被 ${next.number} 取代`, at: now, actor }] };
      store.put("release", old, r.revision);
    }
  }
  return next;
}

/** A requirement revision invalidates any release or candidate bound to the previous version. */
export function supersedeForRevision(store: Store, project: Project, actor: string) {
  const now = new Date().toISOString();
  for (const r of store.list<Release>("release").filter(x => x.projectId === project.id && ["released", "in-review"].includes(x.maturity) && x.projectRevision !== project.revision)) {
    const old: Release = { ...r, revision: r.revision + 1, maturity: "superseded",
      history: [...r.history, { maturity: "superseded", reason: `需求修订为 v${project.revision}，此发布绑定的 v${r.projectRevision} 不再有效`, at: now, actor }] };
    store.put("release", old, r.revision);
  }
}
