import { convexHullPerimeter, MeshSlicer, type Vec3 } from "../geometry/slice";
import type { BodyMeasures } from "../pattern/types";
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
  /** Neck section at the HPS: centre depth, half width, half depth (m). */
  neckCenterZ: number;
  neckHalfWidth: number;
  neckHalfDepth: number;
  /** Head envelope (ears included) and top (m). */
  headHalfWidth: number;
  headFrontZ: number;
  headBackZ: number;
  headTopY: number;
  /** Lowest point of the body (soles). */
  floorY: number;
  /** Natural waist height (narrowest girth). */
  waistY: number;
  /**
   * Body sections every 2 cm from the waist down to the ankles (legs together below
   * the crotch, hands left out): what a skirt is wrapped around before sewing.
   */
  lowerSections: { y: number; halfWidth: number; zMin: number; zMax: number }[];
}

/** Section of the body at height y: every loop near the mid-plane (both legs), not the hands. */
function lowerSection(slicer: MeshSlicer, y: number) {
  let halfWidth = 0, zMin = Infinity, zMax = -Infinity;
  for (const loop of slicer.horizontal(y)) {
    let cx = 0;
    for (const p of loop.pts) cx += p[0];
    if (Math.abs(cx / loop.pts.length) > 0.2) continue; // a hand or a forearm
    for (const p of loop.pts) {
      halfWidth = Math.max(halfWidth, Math.abs(p[0]));
      zMin = Math.min(zMin, p[1]);
      zMax = Math.max(zMax, p[1]);
    }
  }
  return Number.isFinite(zMin) ? { y, halfWidth, zMin, zMax } : null;
}

/** Envelope of the horizontal sections between two heights (largest loop straddling x = 0). */
function envelope(slicer: MeshSlicer, y0: number, y1: number, cuts: number) {
  let halfWidth = 0, zMin = Infinity, zMax = -Infinity;
  for (let s = 0; s <= cuts; s++) {
    const c = torsoSection(slicer, y0 + ((y1 - y0) * s) / cuts);
    if (!c.girth) continue;
    halfWidth = Math.max(halfWidth, c.halfWidth);
    zMin = Math.min(zMin, c.zMin);
    zMax = Math.max(zMax, c.zMax);
  }
  return { halfWidth, zMin, zMax };
}

/** Upper arm girth (m): cut perpendicular to the arm, 45 % of the way to the elbow. */
export function upperArmGirth(slicer: MeshSlicer, j: BodyShape["joints"], side: "L" | "R"): number {
  const a = j[`upperarm01.${side}`], b = j[`lowerarm01.${side}`];
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  const origin: Vec3 = [a[0] + d[0] * 0.45, a[1] + d[1] * 0.45, a[2] + d[2] * 0.45];
  const loops = slicer.plane(origin, [d[0] / l, d[1] / l, d[2] / l]);
  const nearest = loops.reduce((best, l2) => (!best || l2.meanDist < best.meanDist ? l2 : best), loops[0]);
  return nearest ? convexHullPerimeter(nearest.pts) : 0;
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

  const upperArm = (upperArmGirth(slicer, j, "L") + upperArmGirth(slicer, j, "R")) / 2;
  const span = (a: string, b: string) => Math.hypot(j[a][0] - j[b][0], j[a][1] - j[b][1], j[a][2] - j[b][2]);
  const armLength = (side: "L" | "R") => span(`upperarm01.${side}`, `lowerarm01.${side}`) + span(`lowerarm01.${side}`, `wrist.${side}`);

  // Head, neck, floor (capes, hoods, long garments).
  let topY = -Infinity, floorY = Infinity;
  for (let i = 1; i < shape.positions.length; i += 3) {
    topY = Math.max(topY, shape.positions[i]);
    floorY = Math.min(floorY, shape.positions[i]);
  }
  const head = envelope(slicer, j["head"][1], topY - 0.03, 10);

  // Natural waist (narrowest girth between the spine joints, as measured) and fullest hip.
  let waistY = j["spine03"][1], waistG = Infinity, hipLevel = hipY, hipG = 0;
  for (let s = 0; s <= 24; s++) {
    const yy = j["spine04"][1] + ((j["spine02"][1] - j["spine04"][1]) * s) / 24;
    const g = torsoSection(slicer, yy).girth;
    if (g && g < waistG) [waistG, waistY] = [g, yy];
  }
  for (let s = 0; s <= 24; s++) {
    const yy = hipY - 0.15 + ((j["spine05"][1] + 0.02 - (hipY - 0.15)) * s) / 24;
    const g = torsoSection(slicer, yy).girth;
    if (g > hipG) [hipG, hipLevel] = [g, yy];
  }
  const kneeY = (j["lowerleg01.L"][1] + j["lowerleg01.R"][1]) / 2;
  const lowerSections = [];
  for (let yy = waistY; yy > floorY + 0.08; yy -= 0.02) {
    const sec = lowerSection(slicer, yy);
    if (sec) lowerSections.push(sec);
  }
  const neckCut = torsoSection(slicer, j["neck01"][1] + 0.015);

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
      hpsToFloor: (hpsY - floorY) * 100,
      headHeight: (topY - hpsY) * 100,
      headDepth: (head.zMax - head.zMin) * 100,
      headWidth: 2 * head.halfWidth * 100,
      waistToHip: (waistY - hipLevel) * 100,
      waistToKnee: (waistY - kneeY) * 100,
      hpsToWaist: (hpsY - waistY) * 100,
      waistToFloor: (waistY - floorY) * 100,
      armLength: (armLength("L") + armLength("R")) * 50,
    },
    torso: {
      halfWidth,
      halfDepth: (zMax - zMin) / 2,
      centerZ: (zMax + zMin) / 2,
      hpsY,
      armpitY: body.armpitY,
      upperArmRadius: upperArm / (2 * Math.PI),
      neckCenterZ: (neckCut.zMin + neckCut.zMax) / 2,
      neckHalfWidth: neckCut.halfWidth,
      neckHalfDepth: (neckCut.zMax - neckCut.zMin) / 2,
      headHalfWidth: head.halfWidth,
      headFrontZ: head.zMax,
      headBackZ: head.zMin,
      headTopY: topY,
      floorY,
      waistY,
      lowerSections,
    },
  };
}
