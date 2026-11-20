/// <reference lib="webworker" />
import { Animator, MOTION_DELAY, SETTLE_TIME } from "../avatar/motion";
import { BONE_STRIDE, Skeleton } from "../avatar/skeleton";
import { meshPattern } from "../pattern/mesh";
import { BodySdf } from "../sim/bodySdf";
import { CpuClothSolver } from "../sim/cloth";
import { buildClothModel, type ClothModel, type ClothParams, DEFAULT_CLOTH, RestDetector, tensileModuli } from "../sim/model";
import { findTangles } from "../sim/untangle";
import { orientOutward } from "./orient";
import { placeGarment } from "./place";
import type { DressRequest, GarmentGeometry, MotionRequest, WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Garment preparation off the main thread: pattern → mesh → placement → body
 * collision field → coloured XPBD constraints. In "gpu" mode the model is sent
 * to the main thread, which simulates it on the renderer's GPU; in "cpu" mode
 * the solver runs here and streams positions about once per animation frame,
 * with the body pose they were simulated with. While the body moves, the
 * simulation is paced to real time; once the cloth is at rest it stops until
 * the next motion request. A new dress request cancels the current one.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const FRAME_DT = 1 / 60;
const POST_INTERVAL_MS = 16;
/** Real-time pacing: simulated time the solver may lag behind before slowing down (s). */
const MAX_LAG = 0.1;
/** Mesh resolution (cm): the GPU affords a finer mesh, hence finer folds. */
const SPACING = { gpu: 1.0, cpu: 1.5 };
/**
 * Substeps: stiffness only converges with small steps (stretch error ∝ h²).
 * The CPU fallback trades some accuracy (slightly stretchier cloth) for speed.
 */
const SUBSTEPS = { gpu: 20, cpu: 10 };
/** Substeps between two self-collision passes. */
const SELF_INTERVAL = { gpu: 2, cpu: 5 };

interface Job {
  id: number;
  solver: CpuClothSolver;
  params: ClothParams;
  animator: Animator;
  rest: RestDetector;
  /** Simulated time the body last moved at. */
  movedAt: number;
  running: boolean;
}

let current = 0;
let job: Job | null = null;
/** "gpu" mode: the model simulated on the main thread (for the intersection analyses). */
let gpuModel: { id: number; model: ClothModel } | null = null;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dress(req: DressRequest) {
  const { id, mode, pattern, body, torso } = req;
  const mesh = meshPattern(pattern, SPACING[mode]);
  const initial = placeGarment(mesh, { positions: body.positions, joints: body.joints }, torso);

  // Collision field around the garment's working volume (+ room to fall).
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < initial.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], initial[i + a] - 0.1);
      max[a] = Math.max(max[a], initial[i + a] + 0.1);
    }
  min[1] -= 0.25;
  const sdf = new BodySdf(body.positions, body.normals, min, max, 0.01, 0.05, body.skin);
  orientOutward(mesh, initial, sdf);
  const params = { ...DEFAULT_CLOTH, substeps: SUBSTEPS[mode], selfInterval: SELF_INTERVAL[mode], ...req.cloth };
  const model = buildClothModel(mesh, initial, params);
  if (id !== current) return;

  const geometry: GarmentGeometry = {
    rest: mesh.rest,
    triangles: mesh.triangles,
    thickness: params.thickness,
    tensile: tensileModuli(params),
    initial,
  };
  if (mode === "gpu") {
    const grid = { data: sdf.data, skin: sdf.skin, nx: sdf.nx, ny: sdf.ny, nz: sdf.nz, min: sdf.min, h: sdf.h };
    gpuModel = { id, model };
    post({ type: "model", id, model, sdf: grid, ...geometry });
    return;
  }

  post({ type: "mesh", id, ...geometry });
  const skeleton = new Skeleton(body.rig.labels, body.rig.parents, body.joints, body.positions, body.skin);
  const animator = new Animator(skeleton);
  animator.holdUntil(params.sewTime + MOTION_DELAY);
  animator.setCadence(req.motion.cadence, 0);
  animator.setArmSpread(req.motion.arms, 0);
  if (req.motion.walking) animator.setWalking(true, 0);
  job = {
    id,
    solver: new CpuClothSolver(model, initial, sdf, skeleton.count),
    params,
    animator,
    rest: new RestDetector(),
    movedAt: -Infinity,
    running: false,
  };
  await run(job);
}

/** Simulates until the cloth is at rest and no motion is pending (the body may stay posed). */
async function run(j: Job) {
  const { solver, params, animator } = j;
  const poseAt = (t: number, out: Float32Array) => animator.sample(t, out);
  const bones = new Float32Array(animator.skeleton.count * BONE_STRIDE);
  j.running = true;
  let lastPost = 0;
  let lag = 0;
  let wall = performance.now();
  while (j === job && j.id === current) {
    // Fast forward (as many frames as fit in ~12 ms) while the body is still,
    // real time while it moves.
    let frames = 0;
    const start = performance.now();
    lag = Math.min(MAX_LAG, lag + (start - wall) / 1000);
    wall = start;
    do {
      const realTime = animator.moving(solver.time);
      if (realTime && lag < FRAME_DT) break;
      solver.step(FRAME_DT, poseAt);
      if (realTime) lag -= FRAME_DT;
      frames++;
    } while (performance.now() - start < 12);
    if (!frames) {
      await sleep(4);
      continue;
    }

    const t = solver.time;
    if (animator.moving(t)) {
      j.movedAt = t;
      j.rest.reset();
    }
    const positions = Float32Array.from(solver.pos);
    const armed = t > params.sewTime + 0.5 && t > j.movedAt + 0.5;
    const atRest = j.rest.update(positions, frames * FRAME_DT, armed);
    const done = !animator.pending(t) && (atRest || t >= Math.max(params.duration, j.movedAt + SETTLE_TIME));
    if (done || performance.now() - lastPost >= POST_INTERVAL_MS) {
      lastPost = performance.now();
      const posed = animator.sample(t, bones) ? Float32Array.from(bones) : null;
      const progress = done ? 1 : Math.min(1, t / params.duration);
      post({ type: "frame", id: j.id, positions, progress, bones: posed }, posed ? [positions.buffer, posed.buffer] : [positions.buffer]);
    }
    if (done) break;
    await sleep(0);
  }
  j.running = false;
}

function motion(req: MotionRequest) {
  const j = job;
  if (!j || j.id !== current) return;
  const t = j.solver.time;
  if (req.cadence !== undefined) j.animator.setCadence(req.cadence, t);
  if (req.arms !== undefined) j.animator.setArmSpread(req.arms, t);
  if (req.walk !== undefined) j.animator.setWalking(req.walk, t);
  if (req.turn) j.animator.startTurn(t);
  if (!j.running && j.animator.pending(t)) run(j).catch((err) => post({ type: "error", id: j.id, message: String(err) }));
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    current = -1;
    job = null;
    return;
  }
  if (msg.type === "motion") {
    motion(msg);
    return;
  }
  if (msg.type === "tangles") {
    const g = gpuModel;
    if (g?.id === msg.id && g.model.self) {
      const tangle = findTangles(msg.positions, g.model.triangles, g.model.self);
      post({ type: "tangles", id: msg.id, tangle }, [tangle.buffer]);
    }
    return;
  }
  current = msg.id;
  job = null;
  gpuModel = null;
  dress(msg).catch((err) => post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) }));
};
