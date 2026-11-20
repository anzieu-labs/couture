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

/**
 * Initial 3D placement before sewing (like the "arrangement points" of a 3D
 * garment CAD): body panels are wrapped on an elliptic cylinder around the
 * torso, sleeves on a cylinder around each upper arm, underarm seam at the bottom.
 */
export function placeGarment(mesh: GarmentMesh, shape: BodyShape, torso: TorsoFrame): Float32Array {
  const n = mesh.rest.length / 2;
  const out = new Float32Array(n * 3);
  const r = mesh.rest;

  // Per-piece extents of the flat pattern.
  const halfWidth = new Map<number, number>();
  for (let i = 0; i < n; i++) halfWidth.set(mesh.piece[i], Math.max(halfWidth.get(mesh.piece[i]) ?? 0, Math.abs(r[2 * i])));

  const rx = torso.halfWidth + 0.05;
  const rz = torso.halfDepth + 0.055;
  const top = torso.hpsY + 0.02;

  const sleeveFrame = (side: "L" | "R") => {
    const j = shape.joints;
    const J = j[`upperarm01.${side}`], E = j[`lowerarm01.${side}`];
    const d = norm(sub(E, J));
    const up = norm(sub([0, 1, 0], [d[0] * d[1], d[1] * d[1], d[2] * d[1]]));
    let fwd = cross(d, up);
    if (fwd[2] < 0) fwd = [-fwd[0], -fwd[1], -fwd[2]];
    return { J, d, up, fwd };
  };
  const frames = { "sleeve+": sleeveFrame("L"), "sleeve-": sleeveFrame("R") };

  for (let i = 0; i < n; i++) {
    const id = mesh.pieceIds[mesh.piece[i]];
    const x = r[2 * i], y = r[2 * i + 1];
    const o = 3 * i;
    if (id === "front" || id === "back") {
      const theta = (x / halfWidth.get(mesh.piece[i])!) * (Math.PI / 2);
      out[o] = rx * Math.sin(theta);
      out[o + 1] = top + y;
      out[o + 2] = torso.centerZ + (id === "front" ? 1 : -1) * rz * Math.cos(theta);
    } else {
      const { J, d, up, fwd } = frames[id];
      const hw = halfWidth.get(mesh.piece[i])!;
      const radius = hw / Math.PI + 0.02;
      const phi = (x / hw) * Math.PI;
      const s = -0.03 - y;
      const c = Math.cos(phi) * radius, sn = Math.sin(phi) * radius;
      for (let a = 0; a < 3; a++) out[o + a] = J[a] + d[a] * s + up[a] * c + fwd[a] * sn;
    }
  }
  return out;
}
