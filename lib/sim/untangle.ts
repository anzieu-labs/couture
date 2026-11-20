import { PrimitiveHash, type SelfCollisionModel } from "./selfCollision";

/**
 * Global intersection analysis (after Baraff, Witkin & Kass 2003, "Untangling
 * cloth"): finds the regions of cloth that went through another layer, so that
 * the self-collision passes push them back instead of keeping them there.
 *
 *  1. Edges crossing a (non-adjacent) triangle are cut.
 *  2. The garment (seam twins joined) is split along the cut edges: the main
 *     part is the largest piece; any small piece bounded by cut edges is a
 *     tangled region — the inside of a closed intersection contour, lying on
 *     the wrong side of the layer it crossed.
 *  3. Each vertex of a region gets a label and a correction direction: across
 *     the crossed triangle, away from the side it is on; the vertices inside
 *     the region inherit the direction of the nearest boundary vertex.
 *
 * Output (also uploaded to the GPU): 4 floats per vertex, direction (xyz) and
 * region label (w, 0: not tangled).
 *
 * Open contours (reaching a free edge or folding against a seam) enclose
 * nothing to turn over: the end points of the cut edges and the crossed
 * triangle are released instead (w = FREE) — no side is enforced on them until
 * the next analysis, and the fabric's own elasticity untangles them.
 */

/** Label of the vertices released from side enforcement (open contours). */
export const FREE = -1;

/** A piece larger than this fraction of the garment is not a tangle (e.g. a whole sleeve cut off). */
const MAX_REGION = 0.15;

export function findTangles(pos: Float32Array, triangles: Uint32Array, self: SelfCollisionModel, out?: Float32Array): Float32Array {
  const n = pos.length / 3;
  const { edges: E, canon } = self;
  const result = out ?? new Float32Array(4 * n);
  result.fill(0);

  // 1. Edge ↔ triangle crossings.
  const hash = new PrimitiveHash(self.buckets, triangles, 3, self.triCell, 0);
  hash.build(pos);
  const seen = new Int32Array(triangles.length / 3).fill(-1);
  const cut = new Uint8Array(E.length / 2);
  /** Crossing pairs: edge, triangle. */
  const crossings: number[] = [];
  const fix = new Float32Array(3 * n);
  const P = (i: number, a: number) => pos[3 * i + a];
  for (let e = 0; e < E.length / 2; e++) {
    const a = E[2 * e], b = E[2 * e + 1];
    const ca = canon[a], cb = canon[b];
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(P(a, k), P(b, k)) / hash.cell));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(P(a, k), P(b, k)) / hash.cell));
    for (let x = lo[0]; x <= Math.min(hi[0], lo[0] + 2); x++)
      for (let y = lo[1]; y <= Math.min(hi[1], lo[1] + 2); y++)
        for (let z = lo[2]; z <= Math.min(hi[2], lo[2] + 2); z++) {
          const bucket = hash.bucketOf((x + 0.5) * hash.cell, (y + 0.5) * hash.cell, (z + 0.5) * hash.cell);
          for (let k = hash.starts[bucket], end = k + hash.counts[bucket]; k < end; k++) {
            const t = hash.entries[k];
            if (seen[t] === e) continue;
            seen[t] = e;
            const i0 = triangles[3 * t], i1 = triangles[3 * t + 1], i2 = triangles[3 * t + 2];
            const c0 = canon[i0], c1 = canon[i1], c2 = canon[i2];
            if (c0 === ca || c1 === ca || c2 === ca || c0 === cb || c1 === cb || c2 === cb) continue;
            const ox = P(i0, 0), oy = P(i0, 1), oz = P(i0, 2);
            const e1x = P(i1, 0) - ox, e1y = P(i1, 1) - oy, e1z = P(i1, 2) - oz;
            const e2x = P(i2, 0) - ox, e2y = P(i2, 1) - oy, e2z = P(i2, 2) - oz;
            const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const da = (P(a, 0) - ox) * nx + (P(a, 1) - oy) * ny + (P(a, 2) - oz) * nz;
            const db = (P(b, 0) - ox) * nx + (P(b, 1) - oy) * ny + (P(b, 2) - oz) * nz;
            if (da * db >= 0) continue;
            // Crossing point inside the triangle?
            const f = da / (da - db);
            const qx = P(a, 0) + f * (P(b, 0) - P(a, 0)) - ox, qy = P(a, 1) + f * (P(b, 1) - P(a, 1)) - oy, qz = P(a, 2) + f * (P(b, 2) - P(a, 2)) - oz;
            const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z;
            const d20 = qx * e1x + qy * e1y + qz * e1z, d21 = qx * e2x + qy * e2y + qz * e2z;
            const den = d00 * d11 - d01 * d01;
            const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
            if (v < 0 || w < 0 || v + w > 1) continue;
            cut[e] = 1;
            crossings.push(e, t);
            // Each end point would go across, away from its side.
            const nl = Math.hypot(nx, ny, nz);
            for (const [i, d] of [[a, da], [b, db]] as const) {
              const sg = d > 0 ? -1 : 1;
              fix[3 * i] += (sg * nx) / nl; fix[3 * i + 1] += (sg * ny) / nl; fix[3 * i + 2] += (sg * nz) / nl;
            }
          }
        }
  }
  if (!cut.some((c) => c)) return result;

  // 2. Pieces of the garment once cut (union-find over uncut edges and seam twins).
  const parent = Uint32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) union(i, canon[i]);
  for (let e = 0; e < E.length / 2; e++) if (!cut[e]) union(E[2 * e], E[2 * e + 1]);
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[find(i)]++;
  let main = 0;
  for (let i = 0; i < n; i++) if (size[i] > size[main]) main = i;

  // 3. Regions: small pieces touching a cut edge.
  const region = new Int32Array(n).fill(-1);
  const labels = new Map<number, number>();
  for (let e = 0; e < E.length / 2; e++) {
    if (!cut[e]) continue;
    for (const i of [E[2 * e], E[2 * e + 1]]) {
      const r = find(i);
      if (r === main || size[r] > MAX_REGION * n) continue;
      if (!labels.has(r)) labels.set(r, labels.size + 1);
    }
  }
  for (let i = 0; i < n; i++) region[i] = labels.get(find(i)) ?? -1;

  // Open contours: crossings with no tangled region on either side of the edge.
  for (let c = 0; c < crossings.length; c += 2) {
    const e = crossings[c], t = crossings[c + 1];
    if (region[E[2 * e]] >= 0 || region[E[2 * e + 1]] >= 0) continue;
    for (const i of [E[2 * e], E[2 * e + 1], triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2]])
      if (region[i] < 0) result[4 * i + 3] = FREE;
  }
  if (!labels.size) return result;

  // Directions: boundary vertices (on cut edges) first, then breadth-first inside each region
  // (along the edges, and across seams to the twins).
  const { vertexEdgeStart: VS, vertexEdges: VE } = self;
  const twins = new Map<number, number[]>();
  for (let i = 0; i < n; i++)
    if (canon[i] !== i && region[i] >= 0) {
      const list = twins.get(canon[i]) ?? [canon[i]];
      list.push(i);
      twins.set(canon[i], list);
    }
  const queue: number[] = [];
  const done = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (region[i] < 0) continue;
    const l = Math.hypot(fix[3 * i], fix[3 * i + 1], fix[3 * i + 2]);
    if (l === 0) continue;
    for (let a = 0; a < 3; a++) result[4 * i + a] = fix[3 * i + a] / l;
    result[4 * i + 3] = region[i];
    done[i] = 1;
    queue.push(i);
  }
  const visit = (i: number, j: number) => {
    if (done[j] || region[j] !== region[i]) return;
    done[j] = 1;
    for (let a = 0; a < 4; a++) result[4 * j + a] = result[4 * i + a];
    queue.push(j);
  };
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (let k = VS[i]; k < VS[i + 1]; k++) visit(i, E[2 * (VE[k] >> 1) + 1 - (VE[k] & 1)]);
    for (const j of twins.get(canon[i]) ?? []) visit(i, j);
  }
  return result;
}
