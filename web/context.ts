import type { AeroReview, AeroParameters, AeroRequirementsValue } from "../src/aero";
import type { Inspection } from "../src/inspection";
import type { TrackRecord } from "../src/track-record";
import type { AutonomyGrant } from "../src/autonomy";
import type { Autopilot } from "../src/autopilot";
import type { CadOptimization } from "../src/optimize";
import { createContext, useContext } from "react";
import type { Campaign, Feedback, Project, Review } from "../src/contracts";
import type { Proposal } from "../src/proposals";
import type { SceneReview } from "../src/scenes";
import type { FactoryCriteria, FactoryCriteriaValues, FactoryReview } from "../src/factory";
import type { AssistantPlan } from "../src/assistant";
import type { StructuralRequirements, CadReview, CadRequirements } from "../src/cad";
import type { CadSweep, SweepGrid } from "../src/sweep";
import type { Release } from "../src/release";
import type { ProjectVersion } from "../src/contracts";
import type { Lifecycle, StageId, EvidenceKind } from "../src/lifecycle";
import type { LiveSession, LiveTrack } from "./studio";

export type RunKind = EvidenceKind;
export type ViewId = "overview" | StageId | "artifacts";
export type State = {
  projects: Project[]; reviews: Review[]; feedback: Feedback[]; campaigns: Campaign[]; proposals: Proposal[]; scenes: SceneReview[]; cads?: CadReview[]; aeros?: AeroReview[]; cadSweeps?: CadSweep[]; cadOptimizations?: CadOptimization[];
  factoryCriteria?: FactoryCriteria[]; factoryReviews?: FactoryReview[]; inspections?: Inspection[]; assistantPlans?: AssistantPlan[]; lifecycles?: Record<string, Lifecycle>; aiTrackRecords?: Record<string, TrackRecord>; autonomyGrants?: AutonomyGrant[]; autopilots?: Autopilot[];
  releases?: Release[]; projectVersions?: ProjectVersion[];
  projectArchives?: { projectId: string; archived: boolean; reason: string; at: string }[];
  build?: { version: string; commit: string | null; source: "packaged" | "checkout" | "unknown"; dirty?: boolean; packagedAt?: string; releaseDigest?: string };
  metrics: { independentParticipants: number; independentEvents: number; independentRepeatUsers: number; maintainerEvents: number; fixtureEvents: number };
  capabilities: { aero?: false | { engine: string; reference: AeroParameters; defaultRequirements: AeroRequirementsValue }; modelProposal: boolean; assistant?: { modelInvocation: boolean; engines: string[]; images?: boolean }; blender: boolean; cad?: false | { engine: string; defaultRequirements: CadRequirements; families?: Record<string, CadRequirements>; cam?: false | { engine: string };
    generatedCode?: { available: boolean; reason?: string; isolation: string[]; template: string; templates?: Record<string, string> }; sweep?: { defaultGrid: SweepGrid; maxPoints: number } }; authenticatedWorkspace?: boolean;
    signing?: { kms: boolean; keyId: string; algorithm: string };
    physics?: false | { fea: string; defaultStructural: StructuralRequirements; familyStructural?: Record<string, StructuralRequirements>; optimize: { engine: string; defaultBudget: { initial: number; rounds: number; perRound: number }; maxEvaluations: number; strategies?: string[]; botorch?: string | null } };
    factoryTwin?: { defaultCriteria: FactoryCriteriaValues; reviewedSample?: string } };
};
/** Navigation order: decision algorithms and twins first (the platform's product), then the design lifecycle. */
export const VIEWS: { id: ViewId; label: string; short: string; index?: number; group?: string }[] = [
  { id: "artifacts", label: "决策算法与孪生", short: "决策", group: "物理 AI 决策平台" },
  { id: "overview", label: "项目总览", short: "总览", group: "设计生命周期" },
  { id: "requirements", label: "需求冻结", short: "需求", index: 1 },
  { id: "design", label: "候选设计", short: "设计", index: 2 },
  { id: "validate", label: "原生验证", short: "验证", index: 3 },
  { id: "evidence", label: "失败回放", short: "证据", index: 4 },
  { id: "feedback", label: "反馈复测", short: "反馈", index: 5 },
  { id: "deliver", label: "发布交付", short: "发布", index: 6 },
];
export interface Route { view: ViewId; params: URLSearchParams }
export interface Ctx {
  data: State; project?: Project; lifecycle?: Lifecycle; busy: boolean; route: Route;
  navigate(view: ViewId, params?: Record<string, string | undefined>): void;
  perform(action: () => Promise<unknown>, message: string): Promise<boolean>;
  refresh(): Promise<State>; selectProject(id: string): void; toast(message: string, tone?: "ok" | "bad"): void;
  track: LiveTrack; session?: LiveSession; openAssistant(): void;
  /** Open the assistant with a prefilled, context-specific question (Fusion/NX-style "ask about this"). */
  askAI(message: string, attachments?: Attachment[]): void;
}
/** A recorded native image (render, inspection view) sent with an AI question; the server re-checks its digest. */
export interface Attachment { recordKind: "scene-review" | "cad-review" | "aero-review"; recordId: string; which: "baseline" | "candidate"; file: string; label: string }
export const AppContext = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}
export const CAD_VARIANTS: Record<string, [string, string]> = {
  reference: ["基准设计", "4 mm 板厚 · Ø22.5 止口 · 完整安装板"], lightweight: ["轻量化", "板厚降至 2.5 mm 以减重"],
  "undersize-bore": ["止口孔偏小", "止口孔 Ø21.5 mm（电机止口 Ø22）"], compact: ["紧凑化", "降低安装板高度与宽度"],
  parametric: ["参数化", "指定板厚、宽度、安装板高度与止口孔径"],
  "pillow-block": ["6202 轴承座基准", "Ø35 H7 轴承孔 · 2× M8 地脚 · 轴心高 30 mm"], "pillow-block-light": ["轴承座轻量化", "顶部壁厚降到 3.5 mm"],
  "pillow-block-compact": ["轴承座紧凑化", "底座缩短到 88 mm，地脚孔靠近端部"], "pillow-block-tight": ["轴承孔偏小", "Ø34.95，超出 H7 公差带"],
  generated: ["生成代码", "CadQuery 代码在隔离沙箱中建模"],
};
/** Code handed from the assistant or a recheck to the CAD editor; session-scoped, never sent anywhere else. */
export const CAD_DRAFT_KEY = "pai-cad-code-draft";
export const ISOLATION_LABEL: Record<string, string> = { "no-network": "无网络", "read-only-root": "只读文件系统", "hidden-home-state-credentials": "隐藏主目录/状态/凭据",
  "pid-ipc-uts-user-namespaces": "独立命名空间", "no-capabilities": "无特权", "clear-environment": "清空环境变量", "writable-output-only": "仅输出目录可写",
  "rlimit-cpu-memory-files": "CPU 60 s / 内存 3 GiB 上限",
  "agentcore-microvm-per-job": "每个任务独立 AgentCore microVM", "no-network-route": "无网络路由（隔离子网）", "no-credentials": "运行时无凭据", "audit-hook": "审计钩子拦截进程/网络/写文件", "restricted-builtins": "受限内置函数" };
export const CAD_CHECK_LABELS: Record<string, string> = { "solid-valid": "实体有效性", "nema17-interface": "NEMA 17 接口", "motor-interference": "电机装配干涉",
  "min-wall": "最小壁厚", "hole-edge-distance": "孔边距", mass: "质量", envelope: "外形包络", "max-deflection": "轴心挠度（FEA）", "max-stress": "峰值应力（FEA）", "bore-distortion": "轴承孔变形（FEA）",
  "machining-setups": "装夹次数（DFM）", "hole-drillability": "孔可钻性（DFM）", "fastener-access": "紧固件可装配（DFA）", "bearing-seat": "轴承孔（H7）", "shoulder": "轴承止口与轴孔", "cam-toolpath": "CAM 刀路仿真", "cycle-time": "加工节拍（CAM）", "unit-cost": "单件成本估算（DFM）" };
export const MATURITY: Record<string, [string, "ok" | "warn" | "bad" | "muted" | "info"]> = {
  "in-review": ["待审批", "warn"], released: ["已发布", "ok"], rejected: ["已驳回", "bad"], superseded: ["已废止", "muted"],
};
export const ADMISSION_LABELS: Record<string, string> = {
  "evidence-completed": "检查已完成", "evidence-accepted": "检查结论为通过", "current-requirements": "绑定当前需求版本",
  "failures-dispositioned": "失败案例均已处置", "no-open-feedback": "没有未关闭的反馈",
};
export const CANDIDATES = { reference: "基准设置", camera: "相机偏移", dim: "弱光设置" } as const;
export const FEEDBACK_STATUS: Record<string, string> = {
  received: "已收到", "needs-context": "待补充", reproducible: "已复现", assigned: "已分配",
  "fix-proposed": "方案已提出", "no-change-with-reason": "保留并说明", rechecked: "已复测", closed: "已关闭",
};
export const KIND_LABEL: Record<RunKind, string> = { "robot-review": "机器人记录", "blender-scene": "Blender 场景", "factory-twin": "工厂孪生", "cad-part": "CAD 零件", "aero-body": "气动 CFD" };
