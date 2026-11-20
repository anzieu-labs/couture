import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { Pattern } from "../pattern/tshirt";
import type { ClothParams } from "../sim/cloth";

/** Messages exchanged with lib/garment/sim.worker.ts. */

export interface DressRequest {
  type: "dress";
  id: number;
  pattern: Pattern;
  body: {
    positions: Float32Array;
    normals: Float32Array;
    joints: Record<string, [number, number, number]>;
  };
  torso: TorsoFrame;
  cloth: Partial<ClothParams>;
}

export type WorkerRequest = DressRequest | { type: "cancel" };

export type WorkerResponse =
  | { type: "mesh"; id: number; rest: Float32Array; triangles: Uint32Array; positions: Float32Array }
  | { type: "frame"; id: number; positions: Float32Array; progress: number }
  | { type: "error"; id: number; message: string };
