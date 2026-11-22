/// <reference lib="webworker" />
import { Animator, MOTION_DELAY, SETTLE_TIME } from "../avatar/motion";
import { BONE_STRIDE, Skeleton } from "../avatar/skeleton";
import { CpuClothSolver } from "../sim/cloth";
import { GRAB, selectGrab } from "../sim/grab";
import { type ClothModel, type ClothParams, RestDetector, SELF_DELAY, tensileModuli } from "../sim/model";
import { findTangles } from "../sim/untangle";
import { prepareGarment } from "./prepare";
import type { DressRequest, GarmentGeometry, GrabRequest, MotionRequest, WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Garment preparation off the main thread: pattern → mesh → placement → body
 * collision field → coloured XPBD constraints. In "gpu" mode the model is sent
 * to the main thread, which simulates it on the renderer's GPU; in "cpu" mode
 * the solver runs here and streams positions about once per animation frame,
 * with the body pose they were simulated with. While the body moves or the cloth
 * is held by hand (lib/sim/grab.ts), the simulation is paced to real time; once
 * the cloth is at rest it stops until the next motion or grab request. A new
 * dress request cancels the current one.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const FRAME_DT = 1 / 60;
const POST_INTERVAL_MS = 16;
/** Real-time pacing: simulated time the solver may lag behind before slowing down (s). */
const MAX_LAG = 0.1;

interface Job {
  id: number;
  solver: CpuClothSolver;
  model: ClothModel;
  params: ClothParams;
  animator: Animator;
  rest: RestDetector;
  /** Simulated time the body last moved at, or the cloth was last held. */
  movedAt: number;
  /** The cloth is held by hand. */
  holding: boolean;
  /** Simulated time until which the simulation stays in real time (the cloth let go falls back). */
  liveUntil: number;
  running: boolean;
}

let current = 0;
let job: Job | null = null;
/** "gpu" mode: the model simulated on the main thread (for the intersection analyses). */
let gpuModel: { id: number; model: ClothModel } | null = null;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dress(req: DressRequest) {
  const { id, mode, body } = req;
  const { mesh, initial, start, sdf, params, model } = prepareGarment(req);
  if (id !== current) return;

  const geometry: GarmentGeometry = {
    rest: mesh.rest,
    triangles: mesh.triangles,
    thickness: params.thickness,
    tensile: tensileModuli(params),
    initial: start,
    grabFrom: params.sewTime + SELF_DELAY,
    piece: mesh.piece,
    pieceIds: mesh.pieceIds,
    outline: mesh.edges,
  };
  if (mode === "gpu") {
    const grid = { data: sdf.data, skin: sdf.skin, nx: sdf.nx, ny: sdf.ny, nz: sdf.nz, min: sdf.min, h: sdf.h, limbs: sdf.limbs };
    gpuModel = { id, model };
    post({ type: "model", id, model, sdf: grid, restPose: initial, ...geometry });
    return;
  }

  post({ type: "mesh", id, ...geometry });
  const skeleton = new Skeleton(body.rig.labels, body.rig.parents, body.joints, body.positions, body.skin);
  const animator = new Animator(skeleton);
  animator.holdUntil(params.sewTime + params.settleTime + MOTION_DELAY);
  animator.setCadence(req.motion.cadence, 0);
  for (const side of ["L", "R"] as const) {
    const target = req.motion.hands[side];
    if (target) animator.setHandTarget(side, target, 0);
  }
  animator.setPosture(req.motion.posture, 0);
  if (req.motion.walking) animator.setWalking(true, 0);
  job = {
    id,
    solver: new CpuClothSolver(model, initial, sdf, skeleton.count, start),
    model,
    params,
    animator,
    rest: new RestDetector(),
    movedAt: -Infinity,
    holding: false,
    liveUntil: -Infinity,
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
    // real time while it moves or the cloth is held.
    let frames = 0;
    const start = performance.now();
    lag = Math.min(MAX_LAG, lag + (start - wall) / 1000);
    wall = start;
    do {
      const realTime = animator.moving(solver.time) || j.holding || solver.time < j.liveUntil;
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
    if (animator.moving(t) || j.holding) {
      j.movedAt = t;
      j.rest.reset();
    }
    const positions = Float32Array.from(solver.pos);
    const armed = t > params.sewTime + 0.5 && t > j.movedAt + 0.5;
    const atRest = j.rest.update(positions, frames * FRAME_DT, armed);
    const done = !animator.pending(t) && !j.holding && (atRest || t >= Math.max(params.duration, j.movedAt + SETTLE_TIME));
    if (done || performance.now() - lastPost >= POST_INTERVAL_MS) {
      lastPost = performance.now();
      const posed = animator.sample(t, bones) ? Float32Array.from(bones) : null;
      const progress = done ? 1 : Math.min(1, t / params.duration);
      post({ type: "frame", id: j.id, positions, time: t, progress, bones: posed }, posed ? [positions.buffer, posed.buffer] : [positions.buffer]);
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
  if (req.hand) j.animator.setHandTarget(req.hand.side, req.hand.target, t);
  if (req.posture !== undefined) j.animator.setPosture(req.posture, t);
  if (req.walk !== undefined) j.animator.setWalking(req.walk, t);
  if (req.turn) j.animator.startTurn(t);
  if (!j.running && j.animator.pending(t)) run(j).catch((err) => post({ type: "error", id: j.id, message: String(err) }));
}

/** The cloth held by hand: wakes the simulation up. */
function grab(req: GrabRequest) {
  const j = job;
  if (!j || j.id !== current) return;
  const { solver } = j;
  if (req.start && solver.time >= j.params.sewTime + SELF_DELAY) {
    const patch = selectGrab(j.model, solver.pos, req.start.triangle, req.start.point);
    solver.setGrab(patch, req.start.point);
    j.holding = !!patch;
  }
  if (req.target) solver.moveGrab(req.target);
  if (req.release && j.holding) {
    solver.setGrab(null);
    j.holding = false;
    j.liveUntil = solver.time + GRAB.settle;
  }
  if (!j.running && (j.holding || solver.time < j.liveUntil)) run(j).catch((err) => post({ type: "error", id: j.id, message: String(err) }));
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
  if (msg.type === "grab") {
    grab(msg);
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
