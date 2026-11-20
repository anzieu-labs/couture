import type { BodyShape } from "../avatar/anny";
import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { GarmentMesh } from "../pattern/mesh";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quarter perimeter of an ellipse (Ramanujan). */
const quarterPerimeter = (a: number, b: number) => (Math.PI / 4) * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

/** Minimum clearance between the body and the panels before sewing (m). */
const MIN_CLEARANCE = 0.015;

/**
 * Elliptic cylinder around the torso whose quarter perimeter equals the
 * panels' half width, so wrapping them does not stretch the fabric; and the
 * angle reached at each arc length (to wrap without distortion).
 */
function torsoWrap(torso: TorsoFrame, halfWidth: number) {
  let lo = MIN_CLEARANCE, hi = 0.3;
  for (let i = 0; i < 40; i++) {
    const d = (lo + hi) / 2;
    if (quarterPerimeter(torso.halfWidth + d, torso.halfDepth + d) < halfWidth) lo = d;
    else hi = d;
  }
  const rx = torso.halfWidth + lo, rz = torso.halfDepth + lo;
  // Arc length → angle table on [0, π/2] (angle measured from the centre front).
  const N = 256;
  const arc = new Float64Array(N + 1);
  for (let k = 1; k <= N; k++) {
    const t0 = ((k - 1) / N) * (Math.PI / 2), t1 = (k / N) * (Math.PI / 2);
    arc[k] = arc[k - 1] + Math.hypot(rx * (Math.sin(t1) - Math.sin(t0)), rz * (Math.cos(t1) - Math.cos(t0)));
  }
  const angleAt = (s: number) => {
    const target = Math.min(Math.abs(s), arc[N]);
    let k = 1;
    while (k < N && arc[k] < target) k++;
    const t = (target - arc[k - 1]) / (arc[k] - arc[k - 1] || 1);
    return Math.sign(s) * ((k - 1 + t) / N) * (Math.PI / 2);
  };
  return { rx, rz, angleAt };
}

/**
 * Axis of the arm (shoulder → elbow → wrist) as a function of the distance s
 * from the shoulder joint, with a cross-section frame (up: outer side of the
 * arm, fwd: front) that turns smoothly around the elbow. Long sleeves follow
 * the forearm instead of continuing straight past the elbow.
 */
function armPath(shape: BodyShape, side: "L" | "R") {
  const j = shape.joints;
  const J = j[`upperarm01.${side}`], E = j[`lowerarm01.${side}`], W = j[`wrist.${side}`];
  const dA = norm(sub(E, J)), dB = norm(sub(W, E));
  const lenA = Math.hypot(...sub(E, J));
  const BEND = 0.05; // half-length of the elbow transition (m)
  const frameOf = (d: V3) => {
    const up = norm(sub([0, 1, 0], [d[0] * d[1], d[1] * d[1], d[2] * d[1]]));
    return { up, fwd: cross(d, up) };
  };
  // Same handedness all along the sleeve, chosen so that fwd faces the front.
  const flip = frameOf(dA).fwd[2] < 0 ? -1 : 1;
  return (s: number) => {
    const center: V3 = s <= lenA
      ? [J[0] + dA[0] * s, J[1] + dA[1] * s, J[2] + dA[2] * s]
      : [E[0] + dB[0] * (s - lenA), E[1] + dB[1] * (s - lenA), E[2] + dB[2] * (s - lenA)];
    const t = Math.min(1, Math.max(0, (s - lenA + BEND) / (2 * BEND)));
    const k = t * t * (3 - 2 * t);
    const d = norm([dA[0] + (dB[0] - dA[0]) * k, dA[1] + (dB[1] - dA[1]) * k, dA[2] + (dB[2] - dA[2]) * k]);
    const { up, fwd } = frameOf(d);
    return { center, up, fwd: [fwd[0] * flip, fwd[1] * flip, fwd[2] * flip] as V3 };
  };
}

/**
 * Initial 3D placement before sewing (like the "arrangement points" of a 3D
 * garment CAD): body panels are wrapped on an elliptic cylinder around the
 * torso, sleeves on a tube following each arm (underarm seam at the bottom). Lengths are preserved, so the fabric starts unstretched (unless the
 * garment is narrower than the body, e.g. a tight sleeve).
 */
export function placeGarment(mesh: GarmentMesh, shape: BodyShape, torso: TorsoFrame): Float32Array {
  const n = mesh.rest.length / 2;
  const out = new Float32Array(n * 3);
  const r = mesh.rest;

  // Per-piece half width of the flat pattern.
  const halfWidth = new Map<number, number>();
  for (let i = 0; i < n; i++) halfWidth.set(mesh.piece[i], Math.max(halfWidth.get(mesh.piece[i]) ?? 0, Math.abs(r[2 * i])));
  const panelHalfWidth = Math.max(
    ...[...halfWidth].filter(([p]) => mesh.pieceIds[p] === "front" || mesh.pieceIds[p] === "back").map(([, w]) => w),
  );
  const wrap = torsoWrap(torso, panelHalfWidth);
  const top = torso.hpsY + 0.02;

  const arms = { "sleeve+": armPath(shape, "L"), "sleeve-": armPath(shape, "R") };

  for (let i = 0; i < n; i++) {
    const id = mesh.pieceIds[mesh.piece[i]];
    const x = r[2 * i], y = r[2 * i + 1];
    const o = 3 * i;
    if (id === "front" || id === "back") {
      const theta = wrap.angleAt(x);
      out[o] = wrap.rx * Math.sin(theta);
      out[o + 1] = top + y;
      out[o + 2] = torso.centerZ + (id === "front" ? 1 : -1) * wrap.rz * Math.cos(theta);
    } else {
      const hw = halfWidth.get(mesh.piece[i])!;
      // Circumference = sleeve width, unless the arm is wider (tight sleeve).
      const radius = Math.max(hw / Math.PI, torso.upperArmRadius + 0.008);
      const phi = x / radius;
      const { center, up, fwd } = arms[id](-0.03 - y);
      const c = Math.cos(phi) * radius, sn = Math.sin(phi) * radius;
      for (let a = 0; a < 3; a++) out[o + a] = center[a] + up[a] * c + fwd[a] * sn;
    }
  }
  return out;
}
