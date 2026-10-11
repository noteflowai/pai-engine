# Workbench API

JSON requests; unknown command/path fields are rejected. Default origin is `http://127.0.0.1:4317`.

AWS deployment uses the exact origin `https://pai.oneai.host` and requires signed ALB/Cognito claims for every workspace route. Native review and scene POSTs may return `202`, `Location: /api/runs/:id` or `/api/scenes/:id`, and `Retry-After: 2`. Poll that location until the saved state is no longer running. Polling and duplicate POSTs retain the original identity and do not launch another command. A restarted running task becomes interrupted and requires reconciliation, never automatic replay.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Minimal health status for the ALB; no workspace data |
| `GET /logout` | Expires ALB session cookies and uses the configured Cognito logout |
| `GET /api/state` | Projects, runs, feedback, proposal/campaign states, separated pilot metrics |
| `POST /api/projects` | `{title,intendedDecision,requirements}`; freezes revision 1 |
| `PATCH /api/projects/:id` | Same fields plus `expectedRevision`; compare-and-swap revision update |
| `POST /api/projects/:id/reviews` | `{requestId,projectRevision,candidate,feedbackId?}` |
| `POST /api/projects/:id/proposals` | `{requestId,projectRevision,profiles}`; native control only when configured |
| `POST /api/projects/:id/scenes` | `{requestId,projectRevision,variant,requirements,feedbackId?}`; native Blender workcell (`clear`/`occluded`), or a factory production line with `variant:"plant"` and a bounded `layout` (see [PLANT.md](PLANT.md)) |
| `GET /api/scenes/:id` | Saved native scene checks, receipts and artifact digests |
| `GET /api/scenes/:id/files/:which/:file` | Closed baseline/candidate artifact list (`scene.blend`, `scene.glb`, `preview.png`, `checks.json`; plants also `inspection.png`); digest checked before download |
| `GET /api/scenes/:id/stages/:which/:index` | Staged native GLB written during the Blender run; digest checked; header `X-PAI-Evidence: presentation-stage` |
| `GET /api/live/:requestId` | Server-sent events for a request identity: `step`, `record`, `stage`, `ray`, `render`, `done`. Replays buffered events, heartbeats every 15 s, ends after `done`. Presentation only |
| `POST /api/assistant/plans` | `{requestId,projectId?,message}` → typed tool plans with requirement diff (`new/same/tightened/relaxed/changed`), `authority:"none"` |
| `POST /api/assistant/plans/:id/confirmations` | `{planId,recordKind,recordId}`; links an executed record and records `as-proposed` or `edited-before-execution` |
| `POST /api/projects/:id/factory-criteria` | `{requestId,projectRevision,criteria,rationale}`; freezes Factory Twin acceptance criteria before evidence |
| `POST /api/projects/:id/factory-reviews` | `{requestId,projectRevision,criteriaId,source,feedbackId?}`; `source` is the bundled reviewed sample or an upload of byte-exact `seeds.json` + `manifest.json` |
| `GET /api/factory-reviews/:id` | Saved per-seed results, consistency checks, criteria digest and source digests |
| `GET /api/projects/:id/ai-track-record` | Per AI (model engine or MCP agent): proposals, executed, native verdicts, edited before run, run under a grant, relaxations proposed, and the signed bias of its physical estimates. Derived only from confirmed plan steps and the lanes' own verdicts; also in `/api/state` as `aiTrackRecords` and in the planner workspace as `aiTrackRecord` |
| `GET /api/projects/:id/lifecycle` | Stage status, failing cases, next step and activity derived from durable records (also in `/api/state` as `lifecycles`) |
| `POST /api/projects/:id/cad` | `{requestId,projectRevision,variant,requirements,family?,parameters?,source?,feedbackId?}`; bracket variants `reference/lightweight/undersize-bore/compact`, pillow-block variants `pillow-block/-light/-compact/-tight`, `parametric`, `generated` (code); `requirements.dfm{maxSetups,maxUnitCostEur,cam?{maxCycleMinutes}}` adds DFM/DFA and CAM; may return 202 + `Location: /api/cad/:id` |
| `GET /api/cad/:id` | Saved CAD checks for baseline and candidate, receipts, artifact digests |
| `GET /api/cad/:id/files/:which/:file` | `part.step`, `part.stl`, `part.glb`, `assembly.glb`, `drawing.svg`, `checks.json`; digest checked; SVG served with `default-src 'none'` |
| `GET /api/cad/:id/inspection-plan` | First-article plan of an accepted part: characteristics with nominal, tolerance, instrument and source (from the frozen requirements) |
| `POST /api/cad/:id/inspections` | `{requestId,measuredBy,instrument,partSerial,values{characteristic:value},note?}`: exactly one value per planned characteristic; judged against the plan; `physicalMeasurement: true`; included in a later release package |
| `GET /api/cad/:id/stages/:which/:index` | Staged GLB per modelling feature; presentation only |
| `GET /api/projects/:id/versions` | Immutable snapshots of every frozen requirement version with digest |
| `GET /api/projects/:id/admission?kind=&runId=` | Release admission checks for a completed run |
| `POST /api/projects/:id/releases` | `{requestId,projectRevision,evidenceKind,runId,title,notes?}`; 422 unless every admission check passes; one candidate in review at a time |
| `PATCH /api/projects/:id/releases/:releaseId` | `{expectedRevision,decision:"approve"|"reject",reason}`; approval re-checks admission; the actor is the verified ALB identity; an earlier release becomes superseded |
| `GET /api/tools` | Professional tool survey; integrated/planned/survey-only states |
| `GET /api/runs/:id` | Complete saved state and native receipts |
| `GET /api/runs/:id/media/:candidate/:seed/:view` | Hash-checked original MP4, supports byte ranges |
| `POST /api/feedback` | `{runId,evidenceKind?,kind,seed,checkId?,expected,observed,actorKind}` |
| `PATCH /api/feedback/:id` | `{expectedRevision,status,reason,recheckRunId?}` |
| `GET /api/runs/:id/bundle` | Download completed evidence packet |
| `POST /api/bundles/verify` | Packet integrity and semantic consistency; no provider call |
| `POST /api/campaigns` | `{runId,evidenceKind?,channel}`; creates a draft only |
| `POST /api/events` | `{eventId,campaignId,participantId,actorKind,kind}`; idempotent actual observations |

See Zod contracts in `src/contracts.ts` and `src/proposals.ts` for the complete enumerations and bounds. A native comparison exit 1 is a valid recorded regression; non-comparable native inputs fail the review.

To document a decision to retain a failing condition, move assigned → no-change-with-reason, supplying a substantive reason. Create a review with that feedback ID and selected candidate, then link it on rechecked → closed. This path records unresolved performance under a deliberate resolution; it never changes the native outcome to success.

The UI's quick recheck follows rollback-to-reference for recorded robotics and removal of the explicit obstruction for the Blender scene recipe. Scene constraints remain unchanged. More complex repairs require separately produced native artifacts and appropriate evaluators.

## AI studio and live progress

The assistant parses a message into plans whose payloads validate against the same Zod contracts as the forms. It never executes; the client runs a plan only after the user confirms it, through the normal route with a new request identity, then posts a confirmation. Dependent steps (`{p1}` placeholders) require their predecessor to be executed first. Any relaxed constraint is labelled and warned; it only creates a new frozen version. Model calls occur only as an explicit `model-proposal` plan when the controller and reviewed ledger are configured; otherwise parsing is deterministic and `model.used` is false.

**AI engine.** `POST /api/assistant/ai` with `{requestId, message, projectId?}` returns 202 and an assistant-plan identity (poll `GET /api/assistant/plans/:id`). The workbench builds a bounded prompt (record handles such as `cad-1`, `feedback-2`, `version-1`; the JSON schema of every allowed tool; workspace text escaped as data) and calls the NoteFlow executor once with the enabled profiles (`capabilities.assistant.engines`, from `PAI_AI_PROFILES`; order Kiro primary → backup → backup2 → Codex → Claude). Executor routing and fallback stay inside the executor and its ledger. The reply is re-validated against the same Zod contracts and relax diff; invalid plans and the tools `approve-release`/feedback dispositions are dropped with a reason, and any citation to a record that does not exist invalidates the answer. `POST /api/assistant/plans/:id/preflight {planId}` is called before a step starts any native tool and returns the same 409 for unreconciled model runs, so nothing runs before the gate. A run whose effects are not verified (`reconcile`, `interrupted`, or an empty report) blocks plan confirmation (`409 AI_RECONCILIATION_REQUIRED`) and new AI runs until `POST /api/assistant/plans/:id/reconciliation` records a human reason; nothing is retried automatically. `deferred-budget` does not block. A disabled engine returns `422 AI_PROFILE_NOT_ENABLED`; no executor/ledger returns 503.

**Generated CAD code.** `POST /api/projects/:id/cad` also accepts `variant: "generated"` with `source: {language: "cadquery-2.8", code}` (and only then). The code is policy-checked before any record exists (`422 CAD_CODE_POLICY`; `503 CAD_SANDBOX_UNAVAILABLE` without a working sandbox), built in the bubblewrap sandbox and measured by the same native checks; `record.sandbox` holds the code digest, isolation layers and outcome. `POST /api/cad/code-check {code}` runs only the static policy. `capabilities.cad.generatedCode` reports availability, reason, isolation and the editable template. The assistant tool `cad-code` proposes such a request. See [CAD_CODE.md](CAD_CODE.md).

**Design-space sweep.** `POST /api/projects/:id/cad-sweeps {requestId, projectRevision, requirements, family?, grid}` builds and measures every grid point (≤ 36) with the family's trusted recipe and its own checks. Bracket (default) `grid:{thickness, width, plateHeight, pilotBore}` (bounds 2–8, 46–80, 40–60, 21–24 mm); pillow block `family: "pillow-block"`, `grid:{width, depth, baseThickness, boltPitch}` (60–140, 14–40, 6–20, 40–120 mm; baseDepth 36, axisHeight 30, seat Ø35.012, shoulder Ø28 fixed, recorded as `fixed`). A sweep measures geometry only: `requirements.structural` is refused (freeze it on the chosen candidate). Pillow points carry their complete recipe parameters, so `fromSweep` works the same way; returns 202 on the hosted site (poll `GET /api/cad-sweeps/:id`). The record holds every point's checks, `lightestFeasible` (recomputed by the server) and a Pareto set over mass and min-wall margin. A sweep accepts nothing: a point becomes a normal review through `POST /api/projects/:id/cad` with `variant: "parametric"`, `parameters` and `fromSweep:{sweepId, point}`; provenance that does not match a measured point of a completed sweep of the project returns `422 INVALID_SWEEP_POINT`. Assistant/MCP tool: `cad-sweep`.

**AgentCore transports.** `PAI_AGENTCORE_AGENT_ARN` routes `/api/assistant/ai` to the AgentCore executor when no local executor is configured (`capabilities.assistant.transport: "agentcore"`, Kiro profiles only). `PAI_AGENTCORE_SANDBOX_ARN` routes generated CAD code to the AgentCore sandbox after a startup probe confirms a microVM with no internet route (`capabilities.cad.generatedCode.transport`, `remote`); `record.sandbox.transport` and `record.sandbox.layers` show where it ran and which layers were active. See [AGENTCORE.md](AGENTCORE.md).

**External agents (MCP).** `GET /api/assistant/context?projectId=` returns the same handle-addressed workspace and tool JSON schemas the engine sees. `GET /api/projects/:id/records/:handle` resolves a handle to its full record. `POST /api/assistant/external-plans` with `{requestId, projectId?, agent, intent, output:{interpretation, answer?, plans}}` stores a `source: "external"` plan after the same validation; `422 INVALID_CITATION` / `NO_VALID_PLAN` otherwise. These back the stdio server in [MCP.md](MCP.md); they grant no execution or approval.

Open `GET /api/live/:requestId` before posting the native request with that identity. Events describe work as it happens; the stored record, receipts and digests remain authoritative. Staged GLBs are presentation snapshots of the same native scene, not additional evidence.

## Parametric CAD review

`requirements`: `maxMassG`, `minWallMm`, `edgeDistanceFactor`, `requireNoInterference`, `maxEnvelopeMm` (3 values). The baseline always uses the reference parameters. Checks: `solid-valid`, `nema17-interface`, `motor-interference`, `min-wall`, `hole-edge-distance`, `mass`, `envelope`. Feedback is `design-check` with the `checkId` that lost its baseline pass. A recheck must keep the same requirements; `fix-proposed` closes only if that check then passes. No user geometry or code is accepted.

## Factory Twin review

Freeze criteria first: `maxOutputLossPerSeed`, `maxClosedIntervalsOverLimit`, `maxHallC`, `minEvServiceRatio`, `maxClosedFailures`, `requireNetOutputGain`. The review verifies the `seeds.json` digest and size against `manifest.json`, unique seeds, zero shadow-mode actuation and recomputes the upstream summary from per-seed results; any mismatch fails with 422. Every seed is evaluated and kept. Energy intensity is reported but never offsets output, EV service or comfort. Feedback for a factory review is `design-check` with a failing `seed` and `checkId`; a recheck must use the original criteria record, and `fix-proposed` can close only if that seed then passes. Uploaded sources are marked `reviewedByWorkbench:false`.

Manual `independent` events are participant declarations, not independently authenticated adoption. The service does not infer exposure, conversion, causal promotion effects or purchases.

## Artifacts and workflows (v1)

Workspace routes behind the same authentication as the browser (ALB + Cognito hosted, loopback locally); none is reachable under `/api/agent`. Design: [ADR 0001](adr/0001-artifacts-and-workflows.md).

| Route | Purpose |
|---|---|
| `GET /api/v1/artifacts` · `GET /api/v1/artifacts/:name@x.y.z` | List versions; one version with its manifest, lifecycle history and validation evidence |
| `POST /api/v1/artifacts` `{adapter, version}` | Build a draft from this release's trusted sources (immutable; same content returns the existing version) |
| `POST /api/v1/artifacts/:ref/validation` | Run the artifact's own acceptance benchmark; passing makes it `validated` |
| `POST /api/v1/artifacts/:ref/lifecycle` `{to: released\|deprecated, reason}` | A person's decision |
| `POST /api/v1/artifacts/:ref/samples` `{scenario, seed, orders, vehicles}` | Labelled synthetic input generated by the artifact's code |
| `GET /api/v1/artifacts/:ref/package` | Signed `pai-artifact-package-1` (validated or released only) |
| `POST /api/v1/artifact-packages/verification` `{package, trustedPublicKeyPem?}` | Verify; returns `{valid:false, error}` with `PACKAGE_SCHEMA` / `PACKAGE_FILE` / `PACKAGE_MANIFEST` / `PACKAGE_SIGNATURE` |
| `POST /api/v1/artifact-packages` `{package, trustedPublicKeyPem?}` | Import as a draft. Signer must be this deployment or the pinned key (`UNTRUSTED_SIGNER`); code and manifest claims must equal the trusted build (`UNTRUSTED_CODE`, `UNTRUSTED_CLAIMS`) |
| `POST /api/v1/workflow-validation` · `POST /api/v1/workflows` | Dry-check or save an immutable `pai-workflow-1` version (`name@n`) |
| `POST /api/v1/workflow-runs` `{requestId, workflow, inputs}` | Run; hosted long runs answer 202 with `Location` |
| `GET /api/v1/workflow-runs[/:id]` · `GET /api/v1/workflow-runs/:id/data?node=&name=` | Runs with per-node state, receipts and `pai-usage-1`; digest-checked outputs |
| `POST /api/v1/workflow-runs/:id/decisions` `{node, approve, reason}` · `POST /api/v1/workflow-runs/:id/resume` | Approval; resume after a restart (effect-free nodes only) |

## Ontology and engines (v1)

The platform's semantic model (`pai-ontology-1`, [ADR 0002](adr/0002-physical-ai-engine-platform.md)): object types (one per stored record kind), link types (the records' own reference fields) and action types (exactly one per write route, with the route's Zod schema as JSON Schema). Same authentication as the browser; agents read them under `/api/agent/v1/...` with the `pai-agent/read` scope. Writes stay behind the action routes above.

| Route | Purpose |
|---|---|
| `GET /api/v1/ontology` | Object, link and action types with parameter JSON Schemas; `digest` and `ETag` identify the exact model |
| `GET /api/v1/ontology.ttl` | The same model as OWL 2 classes / object properties and SHACL node shapes (Turtle); classes are PROV-O subclasses |
| `GET /api/v1/engines` | Native engines with version, availability, where they run, and authority (`verdict`, `conformance` or `suggestion`) |
| `GET /api/v1/objects` | Stored object types with counts |
| `GET /api/v1/objects/:type?limit=50&after=<id>` | Paged summaries (id, title, createdAt, state, verdict) |
| `GET /api/v1/objects/:type/:id` | The object and its outgoing and incoming links (polymorphic links resolved by their discriminator) |

`Engine` is computed from configuration, not stored (`/api/v1/objects/Engine` → 400). Strands Decider suggestions appear on assistant plans as `suggestion` (`authority: "none"`, confidence and threshold recorded); they are never executed.

## Tenants (v1, invite-only)

A tenant is an OAuth client-credentials app client with the single scope `pai-agent/tenant` (created per tenant by the stack from the deployment context `tenants`). It reaches only these routes under `/api/agent`; workspace agent scopes never reach them and the tenant scope reaches nothing else.

| Route (tenant) | Purpose |
|---|---|
| `GET /api/agent/v1/tenant/catalog` | Workflows offered to this tenant (all artifacts released), with inputs and quotas |
| `POST /api/agent/v1/tenant/runs` `{requestId, workflow, inputs}` | Start a run. Quotas are checked first (429 `QUOTA_CONCURRENT` / `QUOTA_DAILY`, no record); a repeated `requestId` returns the same run; another tenant's `requestId` conflicts (409) |
| `GET /api/agent/v1/tenant/runs` · `/runs/:id` · `/runs/:id/data?node=&name=` | Own runs and outputs only (others are 404) |
| `POST /api/agent/v1/tenant/runs/:id/decisions` `{node, approve, reason}` | Decide an approval node of an own run |
| `GET /api/agent/v1/tenant/usage?since=` | Summed `pai-usage-1`; `priceVersion: null`, `billed: false` |

| Route (maintainer) | Purpose |
|---|---|
| `GET /api/v1/tenants` | Configured tenants, quotas and usage (no client ids) |
| `GET /api/v1/offerings` · `POST /api/v1/offerings` `{workflow, tenants, reason}` · `POST /api/v1/offerings/:id/revoke` `{reason}` | Offer a workflow (at its digest) to tenants; revoke |

## Audit (v1)

`GET /api/v1/audit?action=<actionId>&limit=100` (maintainer session only): the newest audit events first. One event per write attempt through an ontology action: `action`, `method`, `route`, path `params`, `caller` (`maintainer`, `agent` with its scope, or `tenant`), `actor`, HTTP `status`, `outcome` (`done` / `accepted` / `refused` / `invalid` / `failed`), domain error `code`, `durationMs`. Request bodies are never recorded. Not reachable under `/api/agent`.

