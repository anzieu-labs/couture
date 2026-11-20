import { convexHullPerimeter, MeshSlicer, type Vec3 } from "../geometry/slice";
import type { BodyMeasures } from "../pattern/tshirt";
import type { BodyShape } from "./anny";
import { torsoSection, type BodyMeasurement } from "./measure";

export interface TorsoFrame {
  /**
   * Half width / half depth / centre depth of the box enclosing the torso from
   * the chest down past the hips (m): the garment is wrapped around it before
   * sewing, so it must clear the buttocks and the belly as well as the bust.
   */
  halfWidth: number;
  halfDepth: number;
  centerZ: number;
  /** Heights (m, body frame). */
  hpsY: number;
  armpitY: number;
  /** Mean radius of the upper arm (m). */
  upperArmRadius: number;
}

/** Depth of the torso envelope below the hip joints (m), and its number of cuts. */
const ENVELOPE_BELOW_HIP = 0.25;
const ENVELOPE_CUTS = 24;

/** Measurements needed to draft and place a top garment. */
export function measureForPattern(
  shape: BodyShape,
  idx: ArrayLike<number>,
  body: BodyMeasurement,
  slicer = new MeshSlicer(shape.positions, idx),
): { measures: BodyMeasures; torso: TorsoFrame } {
  const j = shape.joints;
  const hpsY = j["neck01"][1] + 0.01;
  const hipY = (j["upperleg01.L"][1] + j["upperleg01.R"][1]) / 2;

  // Upper arm girth: cut perpendicular to the arm, 45 % of the way to the elbow.
  const arm = (side: "L" | "R") => {
    const a = j[`upperarm01.${side}`], b = j[`lowerarm01.${side}`];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...d);
    const origin: Vec3 = [a[0] + d[0] * 0.45, a[1] + d[1] * 0.45, a[2] + d[2] * 0.45];
    const loops = slicer.plane(origin, [d[0] / l, d[1] / l, d[2] / l]);
    const nearest = loops.reduce((best, l2) => (!best || l2.meanDist < best.meanDist ? l2 : best), loops[0]);
    return nearest ? convexHullPerimeter(nearest.pts) : 0;
  };

  const upperArm = (arm("L") + arm("R")) / 2;

  // Torso envelope, from the chest down to below the longest usual hem (under
  // the crotch no loop straddles the mid-plane: those cuts are skipped).
  let halfWidth = body.chest.halfWidth, zMin = body.chest.zMin, zMax = body.chest.zMax;
  const top = body.armpitY - 0.03, bottom = hipY - ENVELOPE_BELOW_HIP;
  for (let s = 0; s <= ENVELOPE_CUTS; s++) {
    const c = torsoSection(slicer, top + ((bottom - top) * s) / ENVELOPE_CUTS);
    if (!c.girth) continue;
    halfWidth = Math.max(halfWidth, c.halfWidth);
    zMin = Math.min(zMin, c.zMin);
    zMax = Math.max(zMax, c.zMax);
  }
  return {
    measures: {
      bust: body.bust,
      waist: body.waist,
      hips: body.hips,
      neck: torsoSection(slicer, j["neck01"][1] + 0.015).girth * 100,
      upperArm: upperArm * 100,
      shoulderWidth: (Math.abs(j["upperarm01.L"][0] - j["upperarm01.R"][0]) + 0.08) * 100,
      hpsToArmpit: (hpsY - body.armpitY) * 100,
      hpsToHip: (hpsY - hipY) * 100,
    },
    torso: {
      halfWidth,
      halfDepth: (zMax - zMin) / 2,
      centerZ: (zMax + zMin) / 2,
      hpsY,
      armpitY: body.armpitY,
      upperArmRadius: upperArm / (2 * Math.PI),
    },
  };
}
