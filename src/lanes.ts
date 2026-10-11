/**
 * Lane registry (ADR 0003 step 4): the single place that knows which native lane serves which plan tool, what record
 * kind it writes, and how to start it. Product modules (autonomy, and in time the assistant and lifecycle) read this
 * table instead of importing each lane; adding a lane means registering it here.
 */
import type { Config } from "./config.js";
import type { Project } from "./contracts.js";
import type { LiveBus } from "./live.js";
import type { RecordKind } from "./ontology/kinds.js";
import type { Store } from "./store.js";
import { precheckCad, reviewCad } from "./cad.js";
import { optimizeCad } from "./optimize.js";
import { reviewScene } from "./scenes.js";
import { reviewAero } from "./aero.js";

export interface LaneTool {
  /** Store kind of the record the run creates. */ recordKind: RecordKind;
  /** Start the native run; it claims its request before its first await. */
  start(store: Store, config: Config, project: Project, body: unknown, live?: LiveBus): Promise<{ id: string }>;
}

/** Native lanes a maintainer's autonomy grant may cover; each only measures, none changes requirements or releases. */
export const AUTONOMOUS_LANES = {
  "cad-review": { recordKind: "cad-review", start: (s, c, p, b, l) => precheckCad(s, c, b).then(() => reviewCad(s, c, p, b, l)) },
  "cad-code": { recordKind: "cad-review", start: (s, c, p, b, l) => precheckCad(s, c, b).then(() => reviewCad(s, c, p, b, l)) },
  "cad-optimize": { recordKind: "cad-optimize", start: (s, c, p, b, l) => optimizeCad(s, c, p, b, l) },
  "robot-cell": { recordKind: "scene-review", start: (s, c, p, b, l) => reviewScene(s, c, p, b, l) },
  "plant-layout": { recordKind: "scene-review", start: (s, c, p, b, l) => reviewScene(s, c, p, b, l) },
  "aero-body": { recordKind: "aero-review", start: (s, c, p, b, l) => reviewAero(s, c, p, b, l) },
} as const satisfies Record<string, LaneTool>;
