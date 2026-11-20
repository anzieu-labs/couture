/// <reference lib="webworker" />
import { meshPattern } from "../pattern/mesh";
import { BodySdf } from "../sim/bodySdf";
import { CpuClothSolver } from "../sim/cloth";
import { buildClothModel, DEFAULT_CLOTH, RestDetector } from "../sim/model";
import { orientOutward } from "./orient";
import { placeGarment } from "./place";
import type { DressRequest, GarmentGeometry, WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Garment preparation off the main thread: pattern → mesh → placement → body
 * collision field → coloured XPBD constraints. In "gpu" mode the model is sent
 * to the main thread, which simulates it on the renderer's GPU; in "cpu" mode
 * the solver runs here and streams positions about once per animation frame.
 * A new request cancels the current one.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const FRAME_DT = 1 / 60;
const POST_INTERVAL_MS = 16;
/** Mesh resolution (cm): the GPU affords a finer mesh, hence finer folds. */
const SPACING = { gpu: 1.0, cpu: 1.5 };

let current = 0;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const nextTask = () => new Promise((r) => setTimeout(r, 0));

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
  const sdf = new BodySdf(body.positions, body.normals, min, max);
  orientOutward(mesh, initial, sdf);
  const params = { ...DEFAULT_CLOTH, ...req.cloth };
  const model = buildClothModel(mesh, initial, params);
  if (id !== current) return;

  const geometry: GarmentGeometry = { rest: mesh.rest, triangles: mesh.triangles, band: mesh.band, thickness: params.thickness, initial };
  if (mode === "gpu") {
    const grid = { data: sdf.data, nx: sdf.nx, ny: sdf.ny, nz: sdf.nz, min: sdf.min, h: sdf.h };
    post({ type: "model", id, model, sdf: grid, ...geometry });
    return;
  }

  post({ type: "mesh", id, ...geometry });
  const solver = new CpuClothSolver(model, initial, sdf);
  const rest = new RestDetector();
  let lastPost = 0;
  while (id === current) {
    // As many frames as fit in ~12 ms, then let a newer request in.
    let frames = 0;
    const start = performance.now();
    do {
      solver.step(FRAME_DT);
      frames++;
    } while (performance.now() - start < 12);
    const positions = Float32Array.from(solver.pos);
    const done = rest.update(positions, frames * FRAME_DT, solver.time > params.sewTime + 0.5) || solver.time >= params.duration;
    if (done || performance.now() - lastPost >= POST_INTERVAL_MS) {
      lastPost = performance.now();
      post({ type: "frame", id, positions, progress: done ? 1 : solver.time / params.duration }, [positions.buffer]);
    }
    if (done) break;
    await nextTask();
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    current = -1;
    return;
  }
  current = msg.id;
  dress(msg).catch((err) => post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) }));
};
