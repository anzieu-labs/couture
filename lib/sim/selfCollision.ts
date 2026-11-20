/**
 * Cloth self-collisions: vertex ↔ triangle and edge ↔ edge proximity, spatial
 * hashing, plus the untangling of crossed regions (lib/sim/untangle.ts).
 *
 *  - Hashing (every pass): triangles go into the cells of a regular grid that
 *    their bounding box, grown by `reach`, overlaps; edges likewise in a second
 *    grid, their box grown by `reach` + half the longest edge (counting sort:
 *    count per bucket, exclusive prefix sum, fill — no bucket capacity limit).
 *    A vertex reads the triangle bucket of its own cell, an edge the edge
 *    bucket of its midpoint's cell.
 *  - Vertex ↔ triangle: a vertex whose projection falls inside a triangle
 *    closer than `reach` to its plane is kept `distance` away, times ½ (the
 *    facing layer gets the other half from its own vertices).
 *  - Edge ↔ edge: the closest points of two edges are kept `distance` apart,
 *    the correction shared between the four end points by their weights on the
 *    edges (each edge computes the share of its own end points). Catches the
 *    crossings vertex ↔ triangle misses (layers crossing at an angle, a seam
 *    folded flat, coarse meshes). Only for edges with an end point near
 *    another layer — a triangle within `reach` whose plane projection falls
 *    near it (NEAR_MARGIN) —, found by the vertex ↔ triangle pass: most of a
 *    garment is a single layer, and this test is the costly one. Only those
 *    edges are hashed, so the buckets hold few of them.
 *  - Side: the one at the previous pass (a snapshot) — a vertex or edge that
 *    went through between two passes is sent back. Except across the boundary
 *    of a tangled region (crossed layers, found by untangle.ts): there the side
 *    is the one its correction direction points to, so the region is pushed
 *    back through; and around an open crossing contour, where no side is
 *    enforced at all.
 *  - Corrections are averaged per vertex (Jacobi).
 *  - Elements sharing a vertex (or a seam twin: sewn vertices are one vertex of
 *    the garment) are skipped.
 *  - Off until shortly after sewing (model.ts SELF_DELAY).
 *
 * Same formulas as the self-collision kernels of the GPU solver
 * (lib/sim/gpu/shaders.ts).
 */

export interface SelfCollisionModel {
  /** Substeps between two passes. */
  interval: number;
  /** Minimum distance between layers (m): fabric thickness + clearance. */
  distance: number;
  /** Search range (m): `distance` + how far a vertex may cross between passes. */
  reach: number;
  /** Longest rest edge (m). */
  maxEdge: number;
  /** Triangle grid cell (m): a triangle box grown by `reach` spans at most 3 cells per axis. */
  triCell: number;
  /** Edge grid: box growth (m) and cell (m), same bound. */
  edgeGrow: number;
  edgeCell: number;
  /** Hash buckets (power of two). */
  buckets: number;
  /** Seam-merged vertex id ("canonical") of each vertex. */
  canon: Uint32Array;
  /** Mesh edges, 2 vertices each. */
  edges: Uint32Array;
  /** Edges at each vertex (CSR): entries vertexEdgeStart[v] .. vertexEdgeStart[v + 1] of vertexEdges, each 2 × edge + end (0 or 1). */
  vertexEdgeStart: Uint32Array;
  vertexEdges: Uint32Array;
}

/** Clearance between two layers of fabric, on top of the thickness (m). */
const SELF_CLEARANCE = 0.002;
/** How far a vertex may travel through a layer between two passes and still be caught (m). */
const SELF_CATCH = 0.005;
/** Simulated time between two global intersection analyses (untangle.ts), s. */
export const UNTANGLE_INTERVAL = 0.2;
/** Barycentric margin of the "near another layer" test (enables edge ↔ edge). */
export const NEAR_MARGIN = 0.5;
/** Most cells covered by a grown box, per axis. */
export const SELF_CELLS_PER_AXIS = 3;
/**
 * Most primitives a vertex (or an edge) examines in its hash bucket. A normal drape
 * fills buckets with ~35 triangles (≤ 150); cloth crushed between body parts can pile
 * thousands into one cell, and the cost (quadratic) would run away until the GPU gives
 * up. Past this cap the remaining candidates are skipped: those contacts are already
 * meaningless in a crushed lump, and the cost stays bounded.
 */
export const SELF_MAX_CANDIDATES = 256;

export function buildSelfCollision(
  triangles: Uint32Array,
  edges: Uint32Array,
  seams: Uint32Array,
  vertexCount: number,
  maxEdge: number,
  thickness: number,
  interval: number,
): SelfCollisionModel {
  // Seam twins: union-find over the stitched pairs.
  const parent = Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let s = 0; s < seams.length; s += 2) {
    const a = find(seams[s]), b = find(seams[s + 1]);
    if (a !== b) parent[a] = b;
  }
  const canon = parent.map((_, i) => find(i));

  // Vertex → edges (CSR).
  const vertexEdgeStart = new Uint32Array(vertexCount + 1);
  for (const v of edges) vertexEdgeStart[v + 1]++;
  for (let v = 0; v < vertexCount; v++) vertexEdgeStart[v + 1] += vertexEdgeStart[v];
  const cursor = vertexEdgeStart.slice(0, vertexCount);
  const vertexEdges = new Uint32Array(edges.length);
  for (let i = 0; i < edges.length; i++) vertexEdges[cursor[edges[i]]++] = i; // i = 2 × edge + end

  const distance = thickness + SELF_CLEARANCE;
  const reach = distance + SELF_CATCH;
  const edgeGrow = reach + maxEdge / 2;
  let buckets = 1024;
  while (buckets < Math.max(triangles.length / 3, edges.length / 2)) buckets *= 2;
  return {
    interval,
    distance,
    reach,
    maxEdge,
    triCell: (maxEdge + 2 * reach) / (SELF_CELLS_PER_AXIS - 1),
    edgeGrow,
    edgeCell: (maxEdge + 2 * edgeGrow) / (SELF_CELLS_PER_AXIS - 1),
    buckets,
    canon,
    edges,
    vertexEdgeStart,
    vertexEdges,
  };
}

/** Bucket of a grid cell (same hash on the GPU). */
export function selfHash(ix: number, iy: number, iz: number, mask: number): number {
  return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask) >>> 0;
}

/** Spatial hash of primitives (triangles or edges) by their grown bounding boxes (counting sort). */
export class PrimitiveHash {
  readonly counts: Uint32Array;
  readonly starts: Uint32Array;
  readonly entries: Uint32Array;
  private readonly mask: number;

  constructor(
    buckets: number,
    private readonly prims: Uint32Array,
    private readonly arity: number,
    readonly cell: number,
    private readonly grow: number,
  ) {
    this.mask = buckets - 1;
    this.counts = new Uint32Array(buckets);
    this.starts = new Uint32Array(buckets);
    this.entries = new Uint32Array((prims.length / arity) * SELF_CELLS_PER_AXIS ** 3);
  }

  bucketOf(x: number, y: number, z: number): number {
    return selfHash(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell), this.mask);
  }

  private forCells(pos: Float32Array, p: number, visit: (bucket: number) => void) {
    if (this.keep && !this.keep(p)) return;
    const { prims, arity, cell, grow } = this;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < arity; k++) {
        const x = pos[3 * prims[arity * p + k] + a];
        mn = Math.min(mn, x);
        mx = Math.max(mx, x);
      }
      lo[a] = Math.floor((mn - grow) / cell);
      hi[a] = Math.min(lo[a] + SELF_CELLS_PER_AXIS - 1, Math.floor((mx + grow) / cell));
    }
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) visit(selfHash(x, y, z, this.mask));
  }

  /** Primitives left out of the hash (edges far from any other layer). */
  keep: ((p: number) => boolean) | null = null;

  build(pos: Float32Array) {
    const { counts, starts, entries } = this;
    const n = this.prims.length / this.arity;
    counts.fill(0);
    for (let p = 0; p < n; p++) this.forCells(pos, p, (b) => counts[b]++);
    let run = 0;
    for (let b = 0; b < counts.length; b++) {
      starts[b] = run;
      run += counts[b];
      counts[b] = 0;
    }
    for (let p = 0; p < n; p++) this.forCells(pos, p, (b) => (entries[starts[b] + counts[b]++] = p));
  }
}

/**
 * Side (±1) a vertex / edge must keep, along direction n, from a facing
 * element: the snapshot's, unless they lie in different regions of a tangle —
 * then the side the tangled one's correction direction (fix) points to.
 */
export function pairSide(
  labelA: number, fixA: ArrayLike<number>, oa: number,
  labelB: number, fixB: ArrayLike<number>, ob: number,
  nx: number, ny: number, nz: number, snapshotSide: number,
): number {
  if (labelA === labelB) return snapshotSide;
  const d = labelA !== 0
    ? fixA[oa] * nx + fixA[oa + 1] * ny + fixA[oa + 2] * nz
    : -(fixB[ob] * nx + fixB[ob + 1] * ny + fixB[ob + 2] * nz);
  return d > 0 ? 1 : d < 0 ? -1 : snapshotSide;
}

/** Closest points of segments p1q1 and p2q2: parameters [s, t] (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegments(
  p1x: number, p1y: number, p1z: number, d1x: number, d1y: number, d1z: number,
  p2x: number, p2y: number, p2z: number, d2x: number, d2y: number, d2z: number,
): [number, number] {
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz, c = d1x * rx + d1y * ry + d1z * rz;
  const b = d1x * d2x + d1y * d2y + d1z * d2z;
  const den = a * e - b * b;
  let s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (b - c) / a));
  }
  return [s, t];
}

/** CPU implementation (reference for the GPU kernels). */
export class SelfCollider {
  private readonly triHash: PrimitiveHash;
  private readonly edgeHash: PrimitiveHash;
  /** Per vertex: correction sum (xyz) and count. */
  private readonly acc: Float32Array;
  /** Per vertex: another layer within reach (enables edge ↔ edge). */
  private readonly near: Uint8Array;
  /** Positions at the end of the previous pass (sidedness). */
  private readonly snapshot: Float32Array;
  /** Tangled regions (untangle.ts): per vertex correction direction (xyz) and region label (w, 0: none). */
  tangle: Float32Array;

  constructor(private readonly s: SelfCollisionModel, private readonly triangles: Uint32Array, initial: Float32Array) {
    this.triHash = new PrimitiveHash(s.buckets, triangles, 3, s.triCell, s.reach);
    this.edgeHash = new PrimitiveHash(s.buckets, s.edges, 2, s.edgeCell, s.edgeGrow);
    this.edgeHash.keep = (e) => this.near[s.edges[2 * e]] === 1 || this.near[s.edges[2 * e + 1]] === 1;
    this.acc = new Float32Array((initial.length / 3) * 4);
    this.near = new Uint8Array(initial.length / 3);
    this.snapshot = Float32Array.from(initial);
    this.tangle = new Float32Array((initial.length / 3) * 4);
  }

  /** One pass on `pos` (in place); `active` false (not started yet) only refreshes the snapshot. */
  solve(pos: Float32Array, invMass: Float32Array, active: boolean) {
    if (!active) {
      this.snapshot.set(pos);
      return;
    }
    this.triHash.build(pos);
    this.acc.fill(0);
    this.near.fill(0);
    this.vertexTriangle(pos);
    this.edgeHash.build(pos); // near edges only (keep)
    this.edgeEdge(pos);
    const { acc, snapshot } = this;
    for (let v = 0; v < pos.length / 3; v++) {
      const hits = acc[4 * v + 3];
      if (hits && invMass[v])
        for (let a = 0; a < 3; a++) pos[3 * v + a] += acc[4 * v + a] / hits;
    }
    snapshot.set(pos);
  }

  private vertexTriangle(pos: Float32Array) {
    const { s, triangles: T, triHash: H, acc, near, snapshot: S, tangle: G } = this;
    const { canon } = s;
    for (let v = 0; v < pos.length / 3; v++) {
      const px = pos[3 * v], py = pos[3 * v + 1], pz = pos[3 * v + 2];
      const b = H.bucketOf(px, py, pz);
      const cv = canon[v];
      for (let k = H.starts[b], end = H.starts[b] + Math.min(H.counts[b], SELF_MAX_CANDIDATES); k < end; k++) {
        const t = H.entries[k];
        const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
        if (canon[i0] === cv || canon[i1] === cv || canon[i2] === cv) continue;
        // Released around an open crossing contour (untangle.ts).
        if (G[4 * v + 3] < 0 || G[4 * i0 + 3] < 0 || G[4 * i1 + 3] < 0 || G[4 * i2 + 3] < 0) continue;
        const Ax = pos[3 * i0], Ay = pos[3 * i0 + 1], Az = pos[3 * i0 + 2];
        const e1x = pos[3 * i1] - Ax, e1y = pos[3 * i1 + 1] - Ay, e1z = pos[3 * i1 + 2] - Az;
        const e2x = pos[3 * i2] - Ax, e2y = pos[3 * i2 + 1] - Ay, e2z = pos[3 * i2 + 2] - Az;
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        nx /= nl; ny /= nl; nz /= nl;
        const wx = px - Ax, wy = py - Ay, wz = pz - Az;
        const x = wx * nx + wy * ny + wz * nz;
        if (Math.abs(x) >= s.reach) continue;
        // Projection inside the triangle (barycentric coordinates).
        const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z;
        const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
        const d20 = wx * e1x + wy * e1y + wz * e1z, d21 = wx * e2x + wy * e2y + wz * e2z;
        const den = d00 * d11 - d01 * d01;
        const bv = (d11 * d20 - d01 * d21) / den, bw = (d00 * d21 - d01 * d20) / den;
        if (bv > -NEAR_MARGIN && bw > -NEAR_MARGIN && bv + bw < 1 + NEAR_MARGIN) near[v] = 1;
        if (bv < 0 || bw < 0 || bv + bw > 1) continue;
        // Side at the previous pass (or imposed across a tangle boundary).
        const Sx = S[3 * i0], Sy = S[3 * i0 + 1], Sz = S[3 * i0 + 2];
        const f1x = S[3 * i1] - Sx, f1y = S[3 * i1 + 1] - Sy, f1z = S[3 * i1 + 2] - Sz;
        const f2x = S[3 * i2] - Sx, f2y = S[3 * i2 + 1] - Sy, f2z = S[3 * i2 + 2] - Sz;
        const side0 =
          (S[3 * v] - Sx) * (f1y * f2z - f1z * f2y) + (S[3 * v + 1] - Sy) * (f1z * f2x - f1x * f2z) + (S[3 * v + 2] - Sz) * (f1x * f2y - f1y * f2x);
        const snap = side0 > 0 || (side0 === 0 && x >= 0) ? 1 : -1;
        const side = pairSide(G[4 * v + 3], G, 4 * v, G[4 * i0 + 3], G, 4 * i0, nx, ny, nz, snap);
        const gap = side * x;
        if (gap >= s.distance) continue;
        const push = 0.5 * (s.distance - gap) * side;
        acc[4 * v] += push * nx; acc[4 * v + 1] += push * ny; acc[4 * v + 2] += push * nz;
        acc[4 * v + 3]++;
      }
    }
  }

  private edgeEdge(pos: Float32Array) {
    const { s, edgeHash: H, acc, near, snapshot: S, tangle: G } = this;
    const { canon, edges: E } = s;
    for (let e = 0; e < E.length / 2; e++) {
      const a = E[2 * e], b = E[2 * e + 1];
      if (!near[a] && !near[b]) continue;
      const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
      const dx = pos[3 * b] - ax, dy = pos[3 * b + 1] - ay, dz = pos[3 * b + 2] - az;
      const le = Math.hypot(dx, dy, dz);
      const bucket = H.bucketOf(ax + dx / 2, ay + dy / 2, az + dz / 2);
      const ca = canon[a], cb = canon[b];
      for (let k = H.starts[bucket], end = H.starts[bucket] + Math.min(H.counts[bucket], SELF_MAX_CANDIDATES); k < end; k++) {
        const f = H.entries[k];
        if (f === e) continue;
        const c = E[2 * f], d = E[2 * f + 1];
        const cc = canon[c], cd = canon[d];
        if (cc === ca || cc === cb || cd === ca || cd === cb) continue;
        if (G[4 * a + 3] < 0 || G[4 * b + 3] < 0 || G[4 * c + 3] < 0 || G[4 * d + 3] < 0) continue;
        const cx = pos[3 * c], cy = pos[3 * c + 1], cz = pos[3 * c + 2];
        const fx = pos[3 * d] - cx, fy = pos[3 * d + 1] - cy, fz = pos[3 * d + 2] - cz;
        // Quick reject: midpoints too far apart.
        const mx = ax + dx / 2 - cx - fx / 2, my = ay + dy / 2 - cy - fy / 2, mz = az + dz / 2 - cz - fz / 2;
        if (Math.hypot(mx, my, mz) > s.reach + (le + Math.hypot(fx, fy, fz)) / 2) continue;
        const [u, w] = closestSegments(ax, ay, az, dx, dy, dz, cx, cy, cz, fx, fy, fz);
        const sx = ax + u * dx - cx - w * fx, sy = ay + u * dy - cy - w * fy, sz = az + u * dz - cz - w * fz;
        const dist = Math.hypot(sx, sy, sz);
        if (dist >= s.reach || dist < 1e-9) continue;
        const nx = sx / dist, ny = sy / dist, nz = sz / dist;
        // Side at the previous pass, same edge parameters.
        const s0x = S[3 * a] + u * (S[3 * b] - S[3 * a]) - S[3 * c] - w * (S[3 * d] - S[3 * c]);
        const s0y = S[3 * a + 1] + u * (S[3 * b + 1] - S[3 * a + 1]) - S[3 * c + 1] - w * (S[3 * d + 1] - S[3 * c + 1]);
        const s0z = S[3 * a + 2] + u * (S[3 * b + 2] - S[3 * a + 2]) - S[3 * c + 2] - w * (S[3 * d + 2] - S[3 * c + 2]);
        const snap = s0x * nx + s0y * ny + s0z * nz >= 0 ? 1 : -1;
        const side = pairSide(G[4 * a + 3], G, 4 * a, G[4 * c + 3], G, 4 * c, nx, ny, nz, snap);
        const C = side * dist - s.distance;
        if (C >= 0) continue;
        // PBD: this edge's share; the other edge computes its own.
        const k0 = (-C * side) / ((1 - u) ** 2 + u * u + (1 - w) ** 2 + w * w);
        for (const [v, wt] of [[a, 1 - u], [b, u]] as const) {
          acc[4 * v] += k0 * wt * nx; acc[4 * v + 1] += k0 * wt * ny; acc[4 * v + 2] += k0 * wt * nz;
          acc[4 * v + 3]++;
        }
      }
    }
  }
}
