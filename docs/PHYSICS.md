# Physics lane: FEA, physics-aware optimisation and robot simulation

The geometry checks of the CAD lane answer "does it fit and can it be made". This lane answers "does it hold up under load". Every number reported is produced by a native solver from the stored geometry. A surrogate model may only *rank* candidates, and never decides anything.

## Toolchain (`npm run setup:physics`)

| Component | Pin | Source |
|---|---|---|
| Gmsh | 4.15.2 | PyPI wheel, hash-locked (`native/physics-requirements.txt`) |
| CalculiX ccx | 2.21 | Ubuntu 24.04 archive. `apt-get download` checks each package against the signed archive indices; the packages are unpacked into `.state/tools`, with no root and no system change |
| Optuna | 5.0.0 | PyPI, hash-locked |
| scikit-learn | 1.9.1 | PyPI, hash-locked |
| MuJoCo | 3.14.0 | PyPI, hash-locked |

The receipt (`.state/tools/physics-install-receipt.json`) records every .deb digest and the lock hash.

## Structural FEA in the CAD review

Freezing `requirements.structural` adds two checks to the ordinary CAD review. Both baseline and candidate are solved, compared by EvalArc, and included in the release gate.

| Check | Method |
|---|---|
| `max-deflection` | Displacement of the motor axis, taken as the mean of the four M3 bore centroids |
| `max-stress` | Peak integration-point von Mises stress away from fixed nodes, at most yield / SF |

The model in detail:

- **Load case:** a belt-driven stepper. The radial pulley force `forceN` acts at `leverMm` from the mounting face. It is applied as statically equivalent loads on the four M3 bores: −F/4 each in Z, plus a Y couple between the upper and lower pairs.
- **Supports and material:** the M5 base bores are fixed. Material is 6061-T6 (nominal E = 68.9 GPa, ν = 0.33, yield 276 MPa).
- **Mesh:** Gmsh quadratic tetrahedra (C3D10), solved twice at two mesh sizes. Both are recorded, and the convergence ratio is shown next to the result.
- **Mesh dependence:** deflection converges to about 2 %. Peak stress at the sharp, unfilleted corners is mesh-dependent (about 20 %); this is stated wherever it appears.
- **Artefacts:** `fea.json`, a von Mises coloured and deformation-scaled `fea.glb` (the viewport's stress view), the CalculiX deck and `.frd` (open them in cgx or ParaView), and, when Blender is configured, `fea.png`: a native Blender render (`native/render_glb.py`, Cycles on the CPU so it also runs headless in CI; vertex colours as unlit emission with a Freestyle outline, Standard view transform so the solver's colour map is not tone-mapped) of the same GLB in iso and front views, for visual review (`attachments` of `/api/assistant/ai`). The PNG is presentation evidence with its own `blender-render` receipt; a failed render never changes the verdict. All carry digests.
- **Fails closed:** structural requirements without the toolchain return `FEA_NOT_CONFIGURED`. The checks are never skipped.

Measured with the default load (60 N, 50 mm, SF 2, deflection ≤ 0.06 mm):

| Bracket | Mass | Geometry checks | Motor-axis deflection | Peak stress |
|---|---|---|---|---|
| Reference t 4, W 60, H 46 | 48.4 g | pass | 0.048 mm | 49 MPa |
| Grid-sweep "lightest feasible" t 3 | 37.4 g | pass | **0.095 mm (fails)** | 92 MPa |
| Lightweight t 2.5 | 31.9 g | min-wall fails | 0.148 mm | 136 MPa |

Physics changes the decision: the geometry-only optimum is too flexible. Widening the plate also makes it *more* flexible (W 80 at t 3: 0.126 mm), because the ribs sit at the plate edges and move away from the bores.

### 6202 pillow block (`native/fea_pillow.py`)

The housing has its own load case and a third check. The mesher, deck, solve and stress view are shared with the bracket in `native/fea_core.py`; the bracket script was moved onto it with a byte-identical deck and GLB.

| Check | Method |
|---|---|
| `max-deflection` | Displacement of the bearing centre: the mean displacement of the seat surface |
| `bore-distortion` | Out-of-roundness of the loaded seat: the range of radial displacement after removing the mean translation. A distorted seat pinches the outer ring |
| `max-stress` | Peak integration-point von Mises stress away from fixed nodes, at most yield / SF |

- **Load case:** a radial shaft load `forceN` through the bearing, `direction` away from the base (lift: the bolts carry it) or toward it. The outer ring presses on the loaded half of the seat as a cosine pressure p(θ) = p₀ cos θ, applied as CalculiX face pressures. p₀ is set so that the discrete resultant on the meshed seat equals F exactly. On the reference, p₀ = 3.307 MPa matches 2F/(πRB) for R = 17.506 mm and B = 11 mm; the transverse residual is 2·10⁻⁴. `leverMm` is 0, at the bearing centre.
- **Supports:** the M8 bore surfaces are fixed; for `toward-base`, the base bottom is also supported in Z. Bolt preload and contact are ignored, which is conservative for lift.
- **Recognition:** the seat and bolt bores are found on the mesh by least-squares cylinder fits (axis, centre, radius), not from recipe parameters. Generated code is analysed the same way.
- **Default** (`PILLOW_STRUCTURAL`): 1 kN lifting, about 0.27 of the 6202 static rating C₀ = 3.75 kN. Centre displacement ≤ 10 µm and seat out-of-roundness ≤ 6 µm, close to the IT5/2 seat form practice for Ø35 (5.5 µm). Both limits are project assumptions, frozen with the requirement and visible in the form.

Measured with the default (`npm run test:pillow`):

| Housing | Mass | Geometry checks | Centre displacement | Seat out-of-round | Peak stress |
|---|---|---|---|---|---|
| Reference (base 10 mm) | 189.6 g | pass | 5.2 µm | 5.16 µm | 14.8 MPa |
| Base 6 mm | 160.4 g | pass | **10.8 µm (fails)** | **6.85 µm (fails)** | 20.3 MPa |

Two-mesh convergence on the reference: centre displacement 0.5 %, out-of-round 0.7 %, peak stress 16 % (mesh-dependent at sharp corners, not used for a margin claim). Lifting at 1 kN is far from yield; stiffness and seat distortion decide this part, not strength.

## Physics-aware optimisation (`cad-optimize`)

Warm start: besides earlier optimisation records, the measured CalculiX rows shipped with the family's released structural surrogate (same load case only) train the in-loop GP; they are never recommended or counted as found ([study](evidence/warmstart-study.json): lighter in 6 of 6 seed pairs at the same budget).

`native/cad_optimize.py` works in rounds, using the standard practice "surrogate ranks, solver decides":

1. **Initial design.** Measure the reference part, up to four AI-proposed seeds, and scrambled Sobol points. Each one is a CadQuery build with B-Rep checks plus a fine-mesh CalculiX solve.
2. **Fit surrogates.** Fit Gaussian-process surrogates (Matérn 5/2 + noise) for log-deflection, log-stress, mass, minimum wall and hole-edge distance. The leave-one-out error of each round is reported.
3. **Search.** Run Optuna NSGA-II on the surrogate. Constraints are taken at mean ± 1σ, so the search is conservative.
4. **Screen, then solve.** Candidates first get a cheap B-Rep screen (multi-fidelity). Only geometry-feasible ones are solved. Each round adds the lightest feasible candidates (exploit) and the most uncertain near-feasible one (explore). The surrogate's prediction is stored *before* the solve, so its calibration is reported honestly.
5. **Recommend.** The recommendation is the lightest *measured* feasible point. Choosing it creates an ordinary parametric review with `fromOptimize` provenance. That review solves two meshes, re-runs the baseline and EvalArc, and goes through the release gate. The provenance is verified: the point must have been solved, with identical parameters and requirements.

**AI physical reasoning, scored.** An AI planner can propose `cad-optimize` seeds together with its own first-principles estimate (`expectedDeflectionMm`, `expectedMassG`). The tool description gives the scaling laws and the recipe's edge-distance rules. The solver's result scores each estimate, and the score is shown in the panel and stored in the record. In the native test, a model seed at t 3.8, W 57, H 45 was predicted at 0.055 mm and measured at 0.052 mm, a 6 % error. At 43.2 g it is 11 % lighter than the reference and passes all 9 checks.

**Pillow block** (`family: "pillow-block"`, `npm run test:optimize-pillow`). The same loop searches width 80–120, depth 14–24, base thickness 6–14 and bolt pitch 54–76 mm; base depth, axis height, seat, shoulder and crown stay fixed. Each point runs `cad_point.py` with the housing recipe and `fea_pillow.py` under the frozen bearing load. Seat out-of-roundness is an extra surrogate target (log) and constraint, and the bolt edge rule enters the search as a linear limit, (W − pitch)/2 ≥ 1.5 × 9 mm. Both strategies work: BoTorch uses the housing's own linear input constraints (width ≤ envelope, depth ≤ envelope, (W − pitch)/2 ≥ 1.5 × 9 mm) and optimises (mass, log seat out-of-roundness) with the distortion limit as an outcome constraint. Points run on this host or, like the bracket, one AWS Batch job each (`native/solver_job.py` takes `family`).

Measured with the same small budget (4 initial points, 1 round of 3; `PAI_OPTIMIZE_STRATEGY=botorch-qlognehvi npm run test:optimize-pillow`, 204 s): 12 geometry-only Sobol screens, then BoTorch proposed three thin housings (depth 14, base 6–12.5 mm). The solver rejected all three on seat distortion (6.26–7.02 µm against 6 µm); their predicted distortion was 5.24–5.46 µm, about 15–25 % low. Trained on 4 solved points, the surrogate was over-optimistic in that corner. The recommendation stayed the AI seed (155.3 g, 5.79 µm). GP + NSGA-II with the same budget also kept the seed. The surrogate only ranks; this run is why. The solver dataset keeps each family's own inputs, so the bracket warm start never sees housing rows.

Measured run (reference, one AI seed, 2 Sobol points, 1 surrogate round; 7 points, 131 s): every solved housing passed except one Sobol point that broke the bolt edge rule. The lightest feasible point was the AI seed W 96 / D 18 / base 8 / pitch 62: 155.3 g against 189.6 g for the reference, out-of-round 5.79 µm (limit 6). The formal two-mesh review agreed exactly (5.79 µm, convergence 0.7 %) and was accepted. The AI's own estimate was poor: 5.5 µm centre displacement against 3.6 µm measured, 53 % high. That error is recorded on the seed and in the AI track record.

## Robot workcell simulation (MuJoCo, scene variant `robot-cell`)

`native/robot_sim.py` generates an MJCF model from eight bounded parameters (no user XML):

- a generic 6-axis arm with UR5e-class link lengths from the public datasheet, on a pedestal;
- a conveyor pick station and a fixture place station;
- four guard panels.

The arm runs 10 fixed seeds, each with a seeded jitter on the pick pose. For each seed:

1. Damped least-squares IK on the MuJoCo Jacobian, within joint limits.
2. A joint-space quintic trajectory at the configured fraction of rated joint speed: approach → pick → lift → transfer → place → retract.
3. Position actuators driven with full rigid-body dynamics at 500 Hz, with contact detection between arm links and the static scene.

| Check | Measured |
|---|---|
| `reach` | TCP error ≤ 2 mm at pick and place, every seed |
| `collision-free` | No arm-link contact with guards, conveyor frame or fixture during the motion |
| `cycle-time` | Slowest seed's cycle including settling, ≤ `maxCycleSeconds` |
| `success-rate` | Share of seeds that reach, stay collision-free and meet the cycle, ≥ `minSuccessRate` |

The baseline is the reference cell. Both cells run the same seeds, and the validate view shows the paired seed table (Robot Reel style: a lost baseline success is flagged). EvalArc compares the four checks. Artefacts: `scene.xml` (the exact MJCF, which opens in MuJoCo viewer or can be converted for Isaac), `robot.json` (per-seed results) and `robot.glb`.

Measured (`npm run test:robot`), with the target raised to a 5 s cycle:

| Cell | Result |
|---|---|
| Reference at 50 % speed | 5.90 s, fails the new target |
| Faster cell (75 %) with guards pulled in to 0.12 m | 4.60 s, but the elbow hits the guard on every seed: rejected |
| Same speed with guards at 0.30 m | 4.60 s, 10/10 seeds: accepted (22 % faster than the reference) |

Feedback is closed by that recheck. Scope: a rigid-body simulation of a generic arm and controller; the part is attached kinematically. It is not the vendor's controller, a safety assessment, or a grasp-physics model.

## Scope

Linear static, small deformation, nominal material. Not included: contact, bolt preload, fatigue, thermal effects, tolerances, or test data. Results are simulation evidence, not certification.

## CAD → MJCF / OpenUSD

A robot-cell request may carry `tool: { cadReviewId, payloadKg }`. The server accepts only a completed, accepted CAD
review of the same project and checks the STL against the digest that review recorded. `native/robot_sim.py` then:

- mounts the exact STL on the gripper as a mesh body, with mass and inertia from the exact (non-convex) mesh volume
  (`inertia="exact"`, 2.70 g/cm³) and collisions on its convex hull, plus the declared payload (default: a 0.28 kg
  NEMA 17 motor) on the motor axis;
- fails closed if the mesh mass differs from the B-Rep mass by more than 3 %. The default convex-hull inertia gave
  110 g for a 31.85 g part, which is what this check exists to catch;
- uses the same tool for the reference and the candidate, so EvalArc compares cells, not tools;
- writes `scene.xml` that references `tool.stl` beside it, so the MJCF carries no local paths and reloads elsewhere;
- writes `scene.usda`: Z-up, metres, one rigid body per MuJoCo body with `MassAPI` (mass, centre of mass, diagonal
  inertia and principal axes), collision shapes (mesh colliders as convex hulls), six revolute joints with limits,
  fixed joints for welded bodies, and an articulation root. Every registered OpenUSD 26.8 `UsdValidation` validator
  runs on the reopened stage, including the UsdPhysics rigid-body, joint, articulation and collider checks. Any
  error or warning fails the run.

`npm run test:robot` mounts the reference bracket (B-Rep 48.37 g, MuJoCo mesh 48.37 g). It checks that the MJCF is
portable, that the USD has the physics joints and articulation root, and that a part that is not accepted is refused
(`TOOL_NOT_ACCEPTED`).

### Newton cross-check of the exported USD

The USD is what Isaac Lab and Newton users receive, so passing `UsdValidation` is not enough: it must be the same
robot PAI simulated. With `npm run setup:physics -- --with-newton` (Newton 1.6, hash-locked
`native/newton-requirements.txt`, own venv because Newton pins its own MuJoCo; CPU Warp, no GPU needed),
`native/usd_newton_check.py` imports the candidate's `scene.usda` into Newton and loads `scene.xml` into MuJoCo:

- one articulation with 6 revolute joints and no orphan joints, and the same body masses;
- forward kinematics at the authored pose and 32 seeded configurations inside the joint limits: every body within
  0.1 mm and 0.01°; the authored body Xforms equal Newton FK at the authored pose.

The first run found two real export bugs that every UsdValidation validator had passed:

1. The articulation root sat on `base`, which is not an ancestor of the (flat) bodies, so Newton refused all joints
   as orphans. The root now sits on `/Workcell`.
2. Joint frames were taken at the pick pose, so joint angle 0 and the limits in USD meant something else than in
   MuJoCo. They now come from the model constants (parent-relative body offset at qpos 0).

After the fix: 33 configurations, worst position error 0.45 µm, orientation 3.1·10⁻⁵ °, masses within 0.5 mg, 4.8 s
([newton-usd.json](evidence/newton-usd.json)). The result is recorded as `newton.json` with a `newton-usd` receipt and
shown under the USD export; it is export conformance and never changes the verdict. Kinematics and mass only; it
says nothing about dynamics agreement between the engines.

## BoTorch strategy (`strategy: "botorch-qlognehvi"`)

This strategy is optional. Install it with `npm run setup:physics -- --with-botorch`, which installs the hash-locked
`native/bo-requirements.txt`: BoTorch 0.18.1, GPyTorch 1.15.2 and CPU PyTorch 2.14.1 from the official PyTorch CPU index.

Only the acquisition step differs from the default; measurement, screening, calibration and the formal review are the
same.

- **Geometry prior.** Before the first round, 12 Sobol points are screened by B-Rep checks only. A screen costs
  seconds, a solve minutes, so the wall, hole-edge and mass models learn where the recipe is feasible before any
  acquisition. Points that pass geometry but are not solved carry `feasible: null`, and the server's consistency
  check accepts that only for those points.
- **Models.** `ModelListGP` holds one standardised `SingleTaskGP` per target: mass, log deflection, log stress,
  minimum wall and hole edge. A recipe build failure counts as zero wall and zero edge distance, so the
  acquisition steers away from that region.
- **Acquisition.** The acquisition function is `qLogNoisyExpectedHypervolumeImprovement` over (−mass, −log
  deflection). The reference point is the mass limit and the deflection limit. The stress, deflection, wall,
  hole-edge and mass limits are outcome constraints. The envelope enters `optimize_acqf` as linear input constraints.
- **Screening loop.** Each proposal is screened on the B-Rep first. After a geometry failure the models are refitted
  and acquisition runs again with the already chosen points as `X_pending`. The screen budget is the same as for
  NSGA-II.

The first local run used the same budget as the default test: 20 points, 7 solved and 5 feasible. BoTorch's three
proposals had surrogate errors of 4–8 %. In that budget the AI seed was still the lightest feasible point.

## Scale-out on AWS Batch (`solver: "batch"`)

The `PAISolver` stack (`infra/solver.ts`) runs each solved optimisation point as its own Batch job on Fargate.
Geometry-only screens stay on the host because they take seconds.

- **Image.** `Dockerfile.solver` runs the same `cad_point.py` and `fea_bracket.py` with the same pins: CadQuery from
  its hash lock, Gmsh / NumPy / boto3 from `native/solver-requirements.txt` (constrained to the physics lock), and
  CalculiX 2.21 from the signed Ubuntu archive. CodeBuild builds it into an immutable ECR tag.
- **Tags per image.** `tools/package_solver.py` tags each of the three images (FEA, CFD, CAM) by the digest of its own
  Dockerfile and the files that Dockerfile COPYs, read from the Dockerfile itself (`image-tags.json`). An FEA change
  rebuilds only the FEA image. Before this, one shared tag rebuilt the OpenFOAM image too, and the build failed on
  Docker Hub's anonymous pull limit (HTTP 429). When an image's inputs are known to be unchanged under a new tag,
  `cdk deploy PAISolver -c solverReuse=cfd:<old>,cam:<old>` copies it inside ECR instead of pulling the base again.
- **Job contract.** The job reads `jobs/<run>/<index>/input.json` (parameters and requirements only) and writes
  `point.json`, `fea.json`, `part.step` and `result.json` (file digests, tool versions, image tag). The optimiser
  re-hashes every file and requires gmsh 4.15.2, ccx 2.21 and CadQuery 2.8.0. Anything else is a failed measurement.
- **Failures.** One attempt per job and a 30-minute timeout. A lost or failed job is recorded and never resubmitted.
- **Activation.** Deploy with `PAI_ENABLE_SOLVER_BATCH=1 python3 tools/aws_operator.py apply-release`. Requests may
  set `solver: "local"`; batch is the default whenever it is configured.

On the hosted site the reference bracket gave 0.0478 mm in a Batch job, the same value as the local run. A full
optimisation completed with 5 Batch jobs ([solver-batch.json](evidence/solver-batch.json)). After the move to the
shared `native/fea_core.py`, `PAI_OPTIMIZE_SOLVER=batch npm run test:optimize` solved all 7 points as Batch jobs on
image `fea-34c84c6c6c7573ba`; the reference again gave 0.0478 mm.

## Strategy comparison

`python3 tools/compare_optimizers.py <dir>` runs both strategies on the same budget and seeds, without AI seeds. On
seeds 3, 7 and 11 ([optimizer-compare.json](evidence/optimizer-compare.json)):

| | GP + NSGA-II | BoTorch qLogNEHVI |
|---|---|---|
| Mean hypervolume of the measured feasible front (reference 80 g, 0.06 mm) | 0.482 | 1.056 |
| Mean lightest feasible mass | 46.87 g | 46.57 g |
| Mean solver calls | 15.0 | 15.7 |
| Wall time per run (local) | 142–189 s | 489–804 s |

On every seed BoTorch maps a much wider mass–stiffness front. NSGA-II reaches the lightest feasible design just as
well, in about a quarter of the time. This is a three-seed panel and not a statistical claim.

## Warm start from the solver dataset

Every optimisation reuses earlier solver measurements of the same recipe and load as training data for the
surrogate. `warmStart: true` is the default. The rows come from `GET /api/dataset/solver`, the measured fine-mesh FEA
points and reviews. Each row carries deflection, stress, mass, minimum wall and hole-edge distance.

Prior points rank candidates and never become results. They are not recommended, and the lightest feasible point is
always measured in the run itself and then formally reviewed. With a warm start the run spends fewer solves on Sobol
space filling; the saved budget becomes extra surrogate rounds, so the total number of solves stays the same.

The record keeps `warmStart.points` and the source record ids.

Paired comparison on seeds 7 and 11 with gp-nsga2 and the same budget
([warm-start.json](evidence/warm-start.json)):

| | Cold | Warm (27 prior points) |
|---|---|---|
| Mean lightest feasible mass | 46.33 g | 44.14 g |
| Mean solver calls | 16.5 | 14.5 |

The first version carried only deflection, stress and mass, and made seed 7 worse (48.4 g). Without wall and
hole-edge observations, the geometry surrogates sent 11 candidates into the infeasible region. Prior rows now include
the measured geometry outputs.

A deep surrogate such as PhysicsNeMo is not used here on purpose. The dataset is about 80 scalar rows over a
3-parameter recipe, and a GP is the appropriate model for that. PhysicsNeMo fits field-level problems (meshes,
DrivAerML-scale aero data); see ROADMAP.
