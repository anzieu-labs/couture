import type { SkinWeights } from "../avatar/anny";
import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { Posture, Side } from "../avatar/motion";
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
    /** The morphology's rest pose (the garment is prepared around the body as it stands: prepare.ts). */
    positions: Float32Array;
    normals: Float32Array;
    /** The body's triangles (3 vertex indices each). */
    indices: Uint16Array | Uint32Array;
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
  /** Wrist targets (body frame, m) of the arms placed by hand; null: the arm follows the spread. */
  hands: Record<Side, [number, number, number] | null>;
  /** Standing, seated or squatting. */
  posture: Posture;
}

/** "cpu" mode: motion changes, applied at the simulation's current time. */
export interface MotionRequest {
  type: "motion";
  walk?: boolean;
  turn?: boolean;
  cadence?: number;
  /** Wrist target of one arm (body frame, m); null releases it. */
  hand?: { side: Side; target: [number, number, number] | null };
  posture?: Posture;
}

/** "cpu" mode: the cloth held by hand (lib/sim/grab.ts), in the body frame (m). */
export interface GrabRequest {
  type: "grab";
  /** Takes hold of the cloth at `point`, on `triangle`. */
  start?: { triangle: number; point: [number, number, number] };
  /** Moves the hand. */
  target?: [number, number, number];
  /** Lets go. */
  release?: boolean;
}

/** "gpu" mode: global intersection analysis (sim/untangle.ts) of read-back positions. */
export interface TanglesRequest {
  type: "tangles";
  id: number;
  positions: Float32Array;
}

/** "gpu" mode: the garment fastened to the skeleton (sim/tether.ts) as it hangs in read-back positions, the body standing. */
export interface BindRequest {
  type: "bind";
  id: number;
  positions: Float32Array;
}

export type WorkerRequest = DressRequest | MotionRequest | GrabRequest | TanglesRequest | BindRequest | { type: "cancel" };

/** Flat garment mesh as needed for rendering. */
export interface GarmentGeometry {
  /** Flat pattern coordinates (m), also the UVs. */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Fabric thickness (m). */
  thickness: number;
  /** Tensile moduli (N/m), for the fit map. */
  tensile: { warp: number; weft: number };
  /** Positions before sewing, around the body as it stands. */
  initial: Float32Array;
  /** Simulated time (s) from which the cloth may be held by hand: sewn, self-collisions on. */
  grabFrom: number;
  /** How the mesh maps to the pattern (lib/pattern/mesh.ts): piece of each vertex, and the vertices along each pattern edge. */
  piece: Uint8Array;
  pieceIds: string[];
  outline: { piece: string; edge: string; vertices: Uint32Array }[];
}

export type WorkerResponse =
  | ({ type: "model"; id: number; model: ClothModel; sdf: SdfGrid } & GarmentGeometry)
  | ({ type: "mesh"; id: number } & GarmentGeometry)
  /** `time`: simulated time; `bones`: transforms of the body pose the positions were simulated with, from the standing pose (null: standing still). */
  | { type: "frame"; id: number; positions: Float32Array; time: number; progress: number; bones: Float32Array | null }
  | { type: "tangles"; id: number; tangle: Float32Array }
  | { type: "tethers"; id: number; tethers: Float32Array }
  | { type: "error"; id: number; message: string };
