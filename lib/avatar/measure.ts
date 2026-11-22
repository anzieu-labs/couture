import { convexHullPerimeter, MeshSlicer } from "../geometry/slice";
import { AnnyModel, type BodyShape } from "./anny";

/**
 * Tape-measure style body measurements: the mesh is cut by horizontal planes,
 * the torso cross-section is isolated (arms/legs are separate loops in the
 * A-pose) and its girth is the perimeter of its convex hull — like a tape
 * that bridges concavities (e.g. between the breasts).
 */

/** Girths and stature, cm. */
export interface Measurements {
  stature: number;
  bust: number;
  waist: number;
  hips: number;
}

export interface TorsoSection {
  /** Convex-hull girth (m), 0 when no loop crosses the mid-plane. */
  girth: number;
  halfWidth: number;
  zMin: number;
  zMax: number;
}

/** Measurements plus the landmarks found while measuring (body frame, m). */
export interface BodyMeasurement extends Measurements {
  armpitY: number;
  /** Section at bust level. */
  chest: TorsoSection;
}

const EMPTY: TorsoSection = { girth: 0, halfWidth: 0, zMin: 0, zMax: 0 };

/** Cross-section of the loop straddling the body mid-plane (x = 0) at height y. */
export function torsoSection(slicer: MeshSlicer, y: number): TorsoSection {
  let best: [number, number][] | null = null;
  for (const loop of slicer.horizontal(y)) {
    let neg = false, pos = false;
    for (const p of loop.pts) {
      if (p[0] < -0.01) neg = true;
      else if (p[0] > 0.01) pos = true;
    }
    if (neg && pos && (!best || loop.pts.length > best.length)) best = loop.pts;
  }
  if (!best) return EMPTY;
  let halfWidth = 0, zMin = Infinity, zMax = -Infinity;
  for (const p of best) {
    halfWidth = Math.max(halfWidth, Math.abs(p[0]));
    zMin = Math.min(zMin, p[1]);
    zMax = Math.max(zMax, p[1]);
  }
  return { girth: convexHullPerimeter(best), halfWidth, zMin, zMax };
}

function scan(slicer: MeshSlicer, y0: number, y1: number, mode: "max" | "min", steps = 16): number {
  let best = mode === "max" ? 0 : Infinity;
  for (let s = 0; s <= steps; s++) {
    const g = torsoSection(slicer, y0 + ((y1 - y0) * s) / steps).girth;
    if (g) best = mode === "max" ? Math.max(best, g) : Math.min(best, g);
  }
  return Number.isFinite(best) ? best : 0;
}

type Joints = BodyShape["joints"];

/** Height of the hip joints (m). */
export const hipJointY = (j: Joints) => (j["upperleg01.L"][1] + j["upperleg01.R"][1]) / 2;

/** Section at bust level — the fullest one under the arms — and the height of the armpits. */
export function chestSection(slicer: MeshSlicer, j: Joints): { chest: TorsoSection; armpitY: number } {
  const shoulderY = (j["upperarm01.L"][1] + j["upperarm01.R"][1]) / 2;
  // Scan upwards and stop when the section suddenly widens — the arms have joined the
  // torso loop (armpit level); any girth above would include them.
  let chest = EMPTY, armpitY = shoulderY - 0.08, prevHalfWidth = 0;
  const steps = 24, y0 = j["spine02"][1];
  for (let s = 0; s <= steps; s++) {
    const yy = y0 + ((shoulderY - y0) * s) / steps;
    const sec = torsoSection(slicer, yy);
    if (!sec.girth) continue;
    if (prevHalfWidth && sec.halfWidth > prevHalfWidth * 1.2) break;
    prevHalfWidth = sec.halfWidth;
    armpitY = yy;
    if (sec.girth > chest.girth) chest = sec;
  }
  return { chest, armpitY };
}

/** Waist girth (m): the narrowest between the spine joints around it. */
export const waistGirth = (slicer: MeshSlicer, j: Joints) => scan(slicer, j["spine04"][1], j["spine02"][1], "min");

/** Hip girth (m): the fullest around the hip joints. */
export const hipsGirth = (slicer: MeshSlicer, j: Joints) => scan(slicer, hipJointY(j) - 0.15, j["spine05"][1] + 0.02, "max");

export function measureBody(
  shape: BodyShape,
  idx: ArrayLike<number>,
  slicer = new MeshSlicer(shape.positions, idx),
): BodyMeasurement {
  const { chest, armpitY } = chestSection(slicer, shape.joints);
  return {
    stature: AnnyModel.stature(shape.positions) * 100,
    bust: chest.girth * 100,
    waist: waistGirth(slicer, shape.joints) * 100,
    hips: hipsGirth(slicer, shape.joints) * 100,
    armpitY,
    chest,
  };
}
