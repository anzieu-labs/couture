import type { SkinWeights } from "../avatar/anny";
import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { Pattern } from "../pattern/types";
import type { SdfGrid } from "../sim/bodySdf";
import type { ClothModel, ClothParams } from "../sim/model";

/** Messages exchanged with lib/garment/sim.worker.ts. */

export interface DressRequest {
  type: "dress";
  id: number;
  /**
   * "gpu": the worker only prepares the cloth model (mesh, placement, collision
   * field, coloured constraints); the main thread simulates it on the renderer's
   * GPU device. "cpu": the worker also runs the solver and streams positions.
   */
  mode: "gpu" | "cpu";
  pattern: Pattern;
  body: {
    /** Rest pose. */
    positions: Float32Array;
    normals: Float32Array;
    joints: Record<string, [number, number, number]>;
    skin: SkinWeights;
    /** Animation rig: joint labels (keys of `joints`) and parent indices. */
    rig: { labels: string[]; parents: number[] };
  };
  torso: TorsoFrame;
  cloth: Partial<ClothParams>;
  /** Motion to apply once the garment is sewn ("cpu" mode). */
  motion: MotionSettings;
}

export interface MotionSettings {
  walking: boolean;
  /** Steps per minute. */
  cadence: number;
  /** Arm spread (degrees from the body); null: rest pose. */
  arms: number | null;
}

/** "cpu" mode: motion changes, applied at the simulation's current time. */
export interface MotionRequest {
  type: "motion";
  walk?: boolean;
  turn?: boolean;
  cadence?: number;
  arms?: number | null;
}

/** "gpu" mode: global intersection analysis (sim/untangle.ts) of read-back positions. */
export interface TanglesRequest {
  type: "tangles";
  id: number;
  positions: Float32Array;
}

export type WorkerRequest = DressRequest | MotionRequest | TanglesRequest | { type: "cancel" };

/** Flat garment mesh as needed for rendering. */
export interface GarmentGeometry {
  /** Flat pattern coordinates (m), also the UVs. */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Fabric thickness (m). */
  thickness: number;
  /** Tensile moduli (N/m), for the fit map. */
  tensile: { warp: number; weft: number };
  /** Positions before sewing. */
  initial: Float32Array;
}

export type WorkerResponse =
  | ({ type: "model"; id: number; model: ClothModel; sdf: SdfGrid } & GarmentGeometry)
  | ({ type: "mesh"; id: number } & GarmentGeometry)
  /** `bones`: transforms of the body pose the positions were simulated with (null: rest pose). */
  | { type: "frame"; id: number; positions: Float32Array; progress: number; bones: Float32Array | null }
  | { type: "tangles"; id: number; tangle: Float32Array }
  | { type: "error"; id: number; message: string };
