import type { DressRequest, GrabRequest, MotionRequest, WorkerRequest, WorkerResponse } from "./protocol";

export interface SimulatorEvents {
  /** A new garment mesh (flat rest coordinates double as UVs). */
  /** CPU mode: a new garment whose positions will follow through `onFrame`. */
  onMesh: (mesh: Extract<WorkerResponse, { type: "mesh" }>) => void;
  /** GPU mode: a prepared cloth model to simulate on the renderer's device. */
  onModel: (model: Extract<WorkerResponse, { type: "model" }>) => void;
  /** CPU mode: simulated positions at the simulated `time`, and the body pose they were simulated with (null: rest). */
  onFrame: (positions: Float32Array, time: number, progress: number, bones: Float32Array | null) => void;
  /** GPU mode: tangled regions of the positions sent with `untangle`. */
  onTangles: (tangle: Float32Array) => void;
  /** GPU mode: the tethers of the positions sent with `bind`. */
  onTethers: (tethers: Float32Array) => void;
}

/** Main-thread handle on the garment simulation worker. */
export class GarmentSimulator {
  private readonly worker: Worker;
  private id = 0;
  /** Id of the garment last delivered (mesh / model): the one on screen. */
  private shown = 0;

  constructor(private readonly events: SimulatorEvents) {
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== this.id) return; // stale
      if (msg.type === "mesh" || msg.type === "model") this.shown = msg.id;
      if (msg.type === "mesh") this.events.onMesh(msg);
      else if (msg.type === "model") this.events.onModel(msg);
      else if (msg.type === "frame") this.events.onFrame(msg.positions, msg.time, msg.progress, msg.bones);
      else if (msg.type === "tangles") this.events.onTangles(msg.tangle);
      else if (msg.type === "tethers") this.events.onTethers(msg.tethers);
      else console.error("Garment simulation failed:", msg.message);
    };
  }

  dress(req: Omit<DressRequest, "type" | "id">) {
    const msg: WorkerRequest = { type: "dress", id: ++this.id, ...req };
    this.worker.postMessage(msg);
  }

  /** CPU mode: walk / turn request for the garment being simulated in the worker. */
  motion(req: Omit<MotionRequest, "type">) {
    this.worker.postMessage({ type: "motion", ...req } satisfies WorkerRequest);
  }

  /** CPU mode: the cloth held by hand, for the garment being simulated in the worker. */
  grab(req: Omit<GrabRequest, "type">) {
    this.worker.postMessage({ type: "grab", ...req } satisfies WorkerRequest);
  }

  /**
   * GPU mode: asks for the intersection analysis of the displayed garment's positions.
   * Tagged with that garment's id, not the latest request's: positions read back from the
   * old garment while a new one is being prepared must not be analysed against the new
   * mesh (the reply would be written into buffers of another size).
   */
  untangle(positions: Float32Array) {
    this.worker.postMessage({ type: "tangles", id: this.shown, positions } satisfies WorkerRequest, [positions.buffer]);
  }

  /** GPU mode: asks for the displayed garment to be fastened to the skeleton as it hangs in these positions (the body standing still). */
  bind(positions: Float32Array) {
    this.worker.postMessage({ type: "bind", id: this.shown, positions } satisfies WorkerRequest, [positions.buffer]);
  }

  cancel() {
    this.id++;
    this.worker.postMessage({ type: "cancel" } satisfies WorkerRequest);
  }

  dispose() {
    this.worker.terminate();
  }
}
