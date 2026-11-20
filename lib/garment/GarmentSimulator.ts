import type { DressRequest, WorkerRequest, WorkerResponse } from "./protocol";

export interface SimulatorEvents {
  /** A new garment mesh (flat rest coordinates double as UVs). */
  onMesh: (mesh: { rest: Float32Array; triangles: Uint32Array; positions: Float32Array }) => void;
  onFrame: (positions: Float32Array, progress: number) => void;
}

/** Main-thread handle on the garment simulation worker. */
export class GarmentSimulator {
  private readonly worker: Worker;
  private id = 0;

  constructor(private readonly events: SimulatorEvents) {
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== this.id) return; // stale
      if (msg.type === "mesh") this.events.onMesh(msg);
      else if (msg.type === "frame") this.events.onFrame(msg.positions, msg.progress);
      else console.error("Garment simulation failed:", msg.message);
    };
  }

  dress(req: Omit<DressRequest, "type" | "id">) {
    const msg: WorkerRequest = { type: "dress", id: ++this.id, ...req };
    this.worker.postMessage(msg);
  }

  cancel() {
    this.id++;
    this.worker.postMessage({ type: "cancel" } satisfies WorkerRequest);
  }

  dispose() {
    this.worker.terminate();
  }
}
