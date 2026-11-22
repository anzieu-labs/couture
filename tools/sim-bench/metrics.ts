import type { BodySdf } from "../../lib/sim/bodySdf";
import type { ClothModel } from "../../lib/sim/model";

/**
 * Quality measures of a simulated garment, all independent of the solver's own
 * bookkeeping (they only read positions):
 *
 *  - strain: elongation of the mesh edges against their flat-pattern length. A
 *    woven fabric (1–2 % under a light load) hanging under its own weight should
 *    show a fraction of a percent; more is the solver not converging;
 *  - crossings: mesh edges going through a non-adjacent triangle (0 for a
 *    garment free of self-intersections);
 *  - penetration: cloth vertices under the skin of the posed body;
 *  - skin through: body vertices standing out of the cloth (see skinThrough).
 */

export interface Strain {
  /** Mean elongation of the stretched edges, mean over all edges (%). */
  mean: number;
  p95: number;
  p99: number;
  max: number;
  /** Strongest compression (%, ≤ 0). */
  min: number;
  /** Garment length gained: Σ stretched lengths / Σ rest lengths − 1 (%). */
  total: number;
}

export function strain(pos: Float32Array, m: ClothModel): Strain {
  const n = m.edgeRest.length;
  const e = new Float64Array(n);
  let sum = 0, len = 0, rest = 0;
  for (let c = 0; c < n; c++) {
    const a = 3 * m.edges[2 * c], b = 3 * m.edges[2 * c + 1];
    const l = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
    e[c] = l / m.edgeRest[c] - 1;
    sum += Math.max(0, e[c]);
    len += l;
    rest += m.edgeRest[c];
  }
  const sorted = e.slice().sort();
  const q = (f: number) => 100 * sorted[Math.min(n - 1, Math.floor(f * n))];
  return { mean: (100 * sum) / n, p95: q(0.95), p99: q(0.99), max: 100 * sorted[n - 1], min: 100 * sorted[0], total: 100 * (len / rest - 1) };
}

/** Number of (edge, triangle) pairs that cross, seam twins counted as one vertex. */
export function crossings(pos: Float32Array, m: ClothModel): number {
  const T = m.triangles, E = m.edges;
  const canon = m.self?.canon;
  const id = (v: number) => (canon ? canon[v] : v);
  let cell = 0;
  for (const l of m.edgeRest) cell = Math.max(cell, l);
  cell *= 1.5;
  const key = (x: number, y: number, z: number) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const grid = new Map<number, number[]>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  const box = (verts: number[]) => {
    for (let a = 0; a < 3; a++) {
      let mn = Infinity, mx = -Infinity;
      for (const v of verts) {
        mn = Math.min(mn, pos[3 * v + a]);
        mx = Math.max(mx, pos[3 * v + a]);
      }
      lo[a] = Math.floor(mn / cell);
      hi[a] = Math.floor(mx / cell);
    }
  };
  for (let t = 0; t < T.length / 3; t++) {
    box([T[3 * t], T[3 * t + 1], T[3 * t + 2]]);
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const k = key(x, y, z);
          const list = grid.get(k);
          if (list) list.push(t);
          else grid.set(k, [t]);
        }
  }
  const seen = new Int32Array(T.length / 3).fill(-1);
  let count = 0;
  for (let e = 0; e < E.length / 2; e++) {
    const a = E[2 * e], b = E[2 * e + 1];
    const ca = id(a), cb = id(b);
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const dx = pos[3 * b] - ax, dy = pos[3 * b + 1] - ay, dz = pos[3 * b + 2] - az;
    box([a, b]);
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++)
          for (const t of grid.get(key(x, y, z)) ?? []) {
            if (seen[t] === e) continue;
            seen[t] = e;
            const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
            const c0 = id(i0), c1 = id(i1), c2 = id(i2);
            if (c0 === ca || c1 === ca || c2 === ca || c0 === cb || c1 === cb || c2 === cb) continue;
            // Segment ↔ triangle (Möller–Trumbore).
            const ox = pos[3 * i0], oy = pos[3 * i0 + 1], oz = pos[3 * i0 + 2];
            const e1x = pos[3 * i1] - ox, e1y = pos[3 * i1 + 1] - oy, e1z = pos[3 * i1 + 2] - oz;
            const e2x = pos[3 * i2] - ox, e2y = pos[3 * i2 + 1] - oy, e2z = pos[3 * i2 + 2] - oz;
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-18) continue;
            const sx = ax - ox, sy = ay - oy, sz = az - oz;
            const u = (sx * px + sy * py + sz * pz) / det;
            if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = (dx * qx + dy * qy + dz * qz) / det;
            if (v < 0 || u + v > 1) continue;
            const w = (e2x * qx + e2y * qy + e2z * qz) / det;
            if (w > 0 && w < 1) count++;
          }
  }
  return count;
}

export interface Penetration {
  /** Vertices under the skin. */
  count: number;
  /** Deepest one (mm, ≥ 0). */
  depth: number;
  /** Vertices closer to the skin than half the clearance the solver keeps. */
  close: number;
}

/** Cloth vertices against a distance field of the body in the pose they were simulated with. */
export function penetration(pos: Float32Array, body: BodySdf, clearance: number): Penetration {
  let count = 0, depth = 0, close = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const d = body.sample(pos[i], pos[i + 1], pos[i + 2]);
    if (d < 0) {
      count++;
      depth = Math.max(depth, -d);
    }
    if (d < clearance / 2) close++;
  }
  return { count, depth: depth * 1000, close };
}

export interface SkinThrough {
  /** Body vertices standing out of the cloth. */
  count: number;
  /** How far the worst one stands above the cloth (mm). */
  depth: number;
}

/**
 * Skin showing through the cloth: the points of the body (as shown: `body`, `normals`; its
 * vertices and, given its triangles, the middle of each: a speck of skin 2 mm wide shows
 * between vertices 1 cm apart) that have a cloth triangle under them — going inwards from the skin, less than `reach` away, deeper than
 * half the fabric's thickness (what the rendered shell cannot hide), facing the same way as
 * the skin (cloth on the far side of a thin part, a finger or an ear, faces the other way),
 * and itself under the skin there according to `field`, a distance field of that body (where
 * the skin folds on itself — an eyelid, with a hood's edge hanging in front of the eye — the
 * vertex normals point anywhere, and "inwards" may lead out into the open).
 *
 * The solvers only keep the cloth's vertices off the body, and in a collision space of their
 * own (lib/sim/posedBody.ts): every vertex can be where the solver wants it while the skin as
 * rendered stands out between them — a hole in the garment for the eye. `penetration` does not
 * see it (it samples the cloth's vertices); this does.
 */
export function skinThrough(
  pos: Float32Array,
  triangles: Uint32Array,
  body: Float32Array,
  normals: Float32Array,
  field: BodySdf,
  halfThickness: number,
  faces?: ArrayLike<number>,
  reach = 0.012,
): SkinThrough {
  const cell = 0.03;
  const key = (x: number, y: number, z: number) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const grid = new Map<number, number[]>();
  for (let t = 0; t < triangles.length; t += 3) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++) {
        const c = Math.floor(pos[3 * triangles[t + k] + a] / cell);
        lo[a] = Math.min(lo[a], c);
        hi[a] = Math.max(hi[a], c);
      }
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const k = key(x, y, z);
          const list = grid.get(k);
          if (list) list.push(t);
          else grid.set(k, [t]);
        }
  }
  let count = 0, worst = 0;
  const vertices = body.length / 3;
  for (let s = 0; s < vertices + (faces ? faces.length / 3 : 0); s++) {
    // A vertex, then the middle of each face (mean of its vertices and of their normals).
    let ox = 0, oy = 0, oz = 0, dx = 0, dy = 0, dz = 0;
    for (let k = 0; k < (s < vertices ? 1 : 3); k++) {
      const v = 3 * (s < vertices ? s : faces![3 * (s - vertices) + k]);
      ox += body[v]; oy += body[v + 1]; oz += body[v + 2];
      // Inwards.
      dx -= normals[v]; dy -= normals[v + 1]; dz -= normals[v + 2];
    }
    if (s >= vertices) {
      const l = Math.hypot(dx, dy, dz) || 1;
      ox /= 3; oy /= 3; oz /= 3;
      dx /= l; dy /= l; dz /= l;
    }
    const ex = ox + dx * reach, ey = oy + dy * reach, ez = oz + dz * reach;
    let depth = 0;
    for (let x = Math.floor(Math.min(ox, ex) / cell); x <= Math.floor(Math.max(ox, ex) / cell); x++)
      for (let y = Math.floor(Math.min(oy, ey) / cell); y <= Math.floor(Math.max(oy, ey) / cell); y++)
        for (let z = Math.floor(Math.min(oz, ez) / cell); z <= Math.floor(Math.max(oz, ez) / cell); z++)
          for (const t of grid.get(key(x, y, z)) ?? []) {
            const i0 = 3 * triangles[t], i1 = 3 * triangles[t + 1], i2 = 3 * triangles[t + 2];
            const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
            const e1x = pos[i1] - ax, e1y = pos[i1 + 1] - ay, e1z = pos[i1 + 2] - az;
            const e2x = pos[i2] - ax, e2y = pos[i2 + 1] - ay, e2z = pos[i2 + 2] - az;
            // Same side out: the triangle's normal (away from the body) along the skin's.
            const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            if (-(nx * dx + ny * dy + nz * dz) < 0.3 * Math.sqrt(nx * nx + ny * ny + nz * nz)) continue;
            // Ray ↔ triangle (Möller–Trumbore).
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-14) continue;
            const sx = ox - ax, sy = oy - ay, sz = oz - az;
            const u = (sx * px + sy * py + sz * pz) / det;
            if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const w = (dx * qx + dy * qy + dz * qz) / det;
            if (w < 0 || u + w > 1) continue;
            const d = (e2x * qx + e2y * qy + e2z * qz) / det;
            if (d > Math.max(depth, halfThickness) && d < reach && field.sample(ox + dx * d, oy + dy * d, oz + dz * d) < 0) depth = d;
          }
    if (depth > 0) {
      count++;
      worst = Math.max(worst, depth);
    }
  }
  return { count, depth: worst * 1000 };
}

/** Number of cloth triangles crossed by the segments (3 + 3 floats each): a limb under a garment crosses none. */
export function segmentsThrough(pos: Float32Array, triangles: Uint32Array, segments: number[][]): number {
  let hits = 0;
  for (const [ax, ay, az, bx, by, bz] of segments) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const reach = Math.hypot(dx, dy, dz) + 0.15;
    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = 3 * triangles[t], i1 = 3 * triangles[t + 1], i2 = 3 * triangles[t + 2];
      const ox = pos[i0], oy = pos[i0 + 1], oz = pos[i0 + 2];
      if (Math.abs(ox - ax) > reach || Math.abs(oy - ay) > reach || Math.abs(oz - az) > reach) continue;
      // Segment ↔ triangle (Möller–Trumbore).
      const e1x = pos[i1] - ox, e1y = pos[i1 + 1] - oy, e1z = pos[i1 + 2] - oz;
      const e2x = pos[i2] - ox, e2y = pos[i2 + 1] - oy, e2z = pos[i2 + 2] - oz;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const sx = ax - ox, sy = ay - oy, sz = az - oz;
      const u = (sx * px + sy * py + sz * pz) / det;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) / det;
      if (v < 0 || u + v > 1) continue;
      const w = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (w > 0 && w < 1) hits++;
    }
  }
  return hits;
}

/** Mean and max vertex speed (mm/s) between two position samples `dt` apart. */
export function speed(pos: Float32Array, last: Float32Array, dt: number): { mean: number; max: number } {
  let sum = 0, max = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const v = Math.hypot(pos[i] - last[i], pos[i + 1] - last[i + 1], pos[i + 2] - last[i + 2]) / dt;
    sum += v;
    max = Math.max(max, v);
  }
  return { mean: (1000 * sum) / (pos.length / 3), max: 1000 * max };
}
