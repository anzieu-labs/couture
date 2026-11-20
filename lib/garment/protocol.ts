import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { Pattern } from "../pattern/tshirt";
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
    positions: Float32Array;
    normals: Float32Array;
    joints: Record<string, [number, number, number]>;
  };
  torso: TorsoFrame;
  cloth: Partial<ClothParams>;
}

export type WorkerRequest = DressRequest | { type: "cancel" };

/** Flat garment mesh as needed for rendering. */
export interface GarmentGeometry {
  /** Flat pattern coordinates (m), also the UVs. */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Hem / neck band weight per vertex (double layer). */
  band: Float32Array;
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
  | { type: "frame"; id: number; positions: Float32Array; progress: number }
  | { type: "error"; id: number; message: string };
