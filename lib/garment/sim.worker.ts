/// <reference lib="webworker" />
import { meshPattern } from "../pattern/mesh";
import { BodySdf } from "../sim/bodySdf";
import { ClothSim, DEFAULT_CLOTH } from "../sim/cloth";
import { placeGarment } from "./place";
import type { DressRequest, WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Garment pipeline off the main thread: pattern → mesh → placement → body SDF
 * → XPBD sewing & draping. The solver runs faster than real time and streams
 * positions at most once per animation frame; a new request cancels the
 * current one.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const FRAME_DT = 1 / 60;
const POST_INTERVAL_MS = 16;
let current = 0;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

function dress(req: DressRequest) {
  const { id, pattern, body, torso } = req;
  const mesh = meshPattern(pattern, 2);
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
  const params = { ...DEFAULT_CLOTH, ...req.cloth };
  const sim = new ClothSim(mesh, initial, sdf, params);

  post({ type: "mesh", id, rest: mesh.rest, triangles: mesh.triangles, positions: Float32Array.from(sim.pos) });

  let lastPost = performance.now();
  const run = () => {
    if (id !== current) return; // superseded
    const start = performance.now();
    // Simulate for ~12 ms per slice so incoming messages are still handled.
    while (!sim.done && performance.now() - start < 12) sim.step(FRAME_DT);
    const now = performance.now();
    if (sim.done || now - lastPost >= POST_INTERVAL_MS) {
      lastPost = now;
      const positions = Float32Array.from(sim.pos);
      post({ type: "frame", id, positions, progress: sim.progress }, [positions.buffer]);
    }
    if (!sim.done) setTimeout(run, 0);
  };
  run();
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    current = -1;
    return;
  }
  current = msg.id;
  try {
    dress(msg);
  } catch (err) {
    post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
