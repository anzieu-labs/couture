import type { GarmentMesh } from "../pattern/mesh";

/**
 * Cloth constraint model shared by the CPU and GPU XPBD solvers.
 *
 *  - stretch: distance constraints on every mesh edge; stiffness from the 2D
 *    tensile modulus of the fabric, interpolated between warp (pattern y) and
 *    weft (pattern x) for each edge direction;
 *  - bending: isometric quadratic bending (Bergou et al. 2006) — for a flat rest
 *    state the bending energy of the two triangles around an edge is
 *    (3B / (A0 + A1)) · |Σ Kᵢ xᵢ|², with constant cotangent weights Kᵢ: a
 *    linear, singularity-free constraint driven by the bending rigidity B (N·m);
 *  - hems / neck band: double layer → twice the mass, four times the rigidity;
 *  - sewing: seam vertex pairs pulled together, rest length ramping to 0.
 *
 * Each constraint family is graph-coloured (no two constraints of a colour share
 * a vertex) and stored sorted by colour, so a colour can be solved in parallel.
 */

export interface ClothParams {
  /** Surface density (kg/m²). */
  density: number;
  /** Bending rigidity (N·m). */
  bending: number;
  /** Elongation under a light load (%), along the warp (pattern y) and weft (pattern x). */
  stretchWarp: number;
  stretchWeft: number;
  /** Fabric thickness (m). */
  thickness: number;
  friction: number;
  /** Clearance kept between the skin and the fabric mid-surface, on top of half the thickness (m). */
  skinGap: number;
  substeps: number;
  /** Seconds to close the seams; gravity starts afterwards. */
  sewTime: number;
  /** Maximum simulated time (s). */
  duration: number;
  /** Velocity damping (1/s). */
  damping: number;
}

export const DEFAULT_CLOTH: ClothParams = {
  density: 0.16,
  bending: 5e-6,
  stretchWarp: 8,
  stretchWeft: 25,
  thickness: 0.0006,
  friction: 0.4,
  skinGap: 0.003,
  substeps: 20,
  sewTime: 1.2,
  duration: 5,
  damping: 1.5,
};

/** Light load used to turn "elongation under light load" into a tensile modulus (N/m). */
const REFERENCE_LOAD = 20;
const MAX_TENSILE = 2e4;
const HEM_BENDING_FACTOR = 4;

/** Tensile moduli (N/m) along the warp (pattern y) and the weft (pattern x). */
export function tensileModuli(p: ClothParams): { warp: number; weft: number } {
  return {
    warp: Math.min(MAX_TENSILE, REFERENCE_LOAD / (p.stretchWarp / 100)),
    weft: Math.min(MAX_TENSILE, REFERENCE_LOAD / (p.stretchWeft / 100)),
  };
}

/** [start, count] of each colour in a colour-sorted constraint array. */
export type ColorRanges = [number, number][];

export interface ClothModel {
  params: ClothParams;
  vertexCount: number;
  invMass: Float32Array;
  edges: Uint32Array;
  edgeRest: Float32Array;
  edgeCompliance: Float32Array;
  edgeColors: ColorRanges;
  /** 4 vertices + 4 weights per inner edge. */
  bendIdx: Uint32Array;
  bendK: Float32Array;
  bendCompliance: Float32Array;
  bendColors: ColorRanges;
  seams: Uint32Array;
  seamStart: Float32Array;
  seamColors: ColorRanges;
  /** 1 for vertices on a seam (they may cross the body while sewing). */
  onSeam: Uint32Array;
}

/**
 * Greedy graph colouring of constraints given as fixed-size vertex tuples.
 * Returns the permutation sorting constraints by colour and the colour ranges.
 */
function colorConstraints(verts: Uint32Array, arity: number, vertexCount: number): { order: Uint32Array; ranges: ColorRanges } {
  const count = verts.length / arity;
  const used = new Uint32Array(vertexCount * 2); // up to 64 colours per vertex
  const color = new Uint8Array(count);
  let maxColor = 0;
  for (let c = 0; c < count; c++) {
    let lo = 0, hi = 0;
    for (let k = 0; k < arity; k++) {
      const v = verts[c * arity + k];
      lo |= used[2 * v];
      hi |= used[2 * v + 1];
    }
    let col = 0;
    while (col < 64 && (col < 32 ? (lo >>> col) & 1 : (hi >>> (col - 32)) & 1)) col++;
    if (col >= 64) throw new Error("graph colouring: more than 64 colours");
    color[c] = col;
    maxColor = Math.max(maxColor, col);
    for (let k = 0; k < arity; k++) {
      const v = verts[c * arity + k];
      if (col < 32) used[2 * v] |= 1 << col;
      else used[2 * v + 1] |= 1 << (col - 32);
    }
  }
  const sizes = new Uint32Array(maxColor + 1);
  for (let c = 0; c < count; c++) sizes[color[c]]++;
  const ranges: ColorRanges = [];
  let start = 0;
  for (const s of sizes) {
    ranges.push([start, s]);
    start += s;
  }
  const cursor = ranges.map(([s]) => s);
  const order = new Uint32Array(count);
  for (let c = 0; c < count; c++) order[cursor[color[c]]++] = c;
  return { order, ranges };
}

function permute<T extends Float32Array | Uint32Array>(src: T, order: Uint32Array, stride: number): T {
  const out = new (src.constructor as { new (n: number): T })(src.length);
  for (let i = 0; i < order.length; i++)
    for (let k = 0; k < stride; k++) out[i * stride + k] = src[order[i] * stride + k];
  return out;
}

export function buildClothModel(mesh: GarmentMesh, initial: Float32Array, p: ClothParams): ClothModel {
  const n = initial.length / 3;
  const r = mesh.rest;
  const tri = mesh.triangles;
  const X = (i: number) => r[2 * i], Y = (i: number) => r[2 * i + 1];
  const area = (a: number, b: number, c: number) =>
    Math.abs((X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a))) / 2;

  // Masses (hem bands are a double layer).
  const mass = new Float32Array(n);
  for (let t = 0; t < tri.length; t += 3) {
    const m = (area(tri[t], tri[t + 1], tri[t + 2]) * p.density) / 3;
    for (let k = 0; k < 3; k++) mass[tri[t + k]] += m;
  }
  const invMass = mass.map((m, i) => (m > 0 ? 1 / (m * (1 + mesh.band[i])) : 0));

  // Edge → opposite vertices and adjacent area.
  const adj = new Map<number, { opp: number[]; area: number }>();
  for (let t = 0; t < tri.length; t += 3) {
    const A = area(tri[t], tri[t + 1], tri[t + 2]);
    for (let e = 0; e < 3; e++) {
      const a = tri[t + e], b = tri[t + ((e + 1) % 3)], c = tri[t + ((e + 2) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      let entry = adj.get(k);
      if (!entry) {
        entry = { opp: [], area: 0 };
        adj.set(k, entry);
      }
      entry.opp.push(c);
      entry.area += A;
    }
  }

  const { warp: yWarp, weft: yWeft } = tensileModuli(p);
  const edges: number[] = [], rest: number[] = [], comp: number[] = [];
  const bIdx: number[] = [], bK: number[] = [], bComp: number[] = [];
  // cotangent of the angle at o between oa and ob
  const cot = (o: number, a: number, b: number) => {
    const ux = X(a) - X(o), uy = Y(a) - Y(o), vx = X(b) - X(o), vy = Y(b) - Y(o);
    return (ux * vx + uy * vy) / Math.max(1e-12, Math.abs(ux * vy - uy * vx));
  };
  for (const [k, { opp, area: A }] of adj) {
    const a = Math.floor(k / n), b = k % n;
    const dx = X(b) - X(a), dy = Y(b) - Y(a);
    const l2 = dx * dx + dy * dy;
    // Anisotropic tensile modulus; edge spring ≈ Y · (area attributed to the edge) / l².
    const warpShare = (dy * dy) / l2;
    const tensile = yWarp * warpShare + yWeft * (1 - warpShare);
    edges.push(a, b);
    rest.push(Math.sqrt(l2));
    comp.push((3 * l2) / (2 * tensile * A));

    if (opp.length !== 2) continue;
    // Bergou: edge x0 = a, x1 = b, opposite vertices x2 = c, x3 = d.
    const [c, d] = opp;
    const c01 = cot(a, b, c), c02 = cot(a, b, d), c03 = cot(b, a, c), c04 = cot(b, a, d);
    bIdx.push(a, b, c, d);
    bK.push(c03 + c04, c01 + c02, -c01 - c03, -c02 - c04);
    const hem = (mesh.band[a] + mesh.band[b] + mesh.band[c] + mesh.band[d]) / 4;
    bComp.push(A / (3 * p.bending * (1 + (HEM_BENDING_FACTOR - 1) * hem)));
  }

  const seamStart = new Float32Array(mesh.seams.length / 2);
  for (let s = 0; s < seamStart.length; s++) {
    const a = mesh.seams[2 * s], b = mesh.seams[2 * s + 1];
    seamStart[s] = Math.hypot(initial[3 * a] - initial[3 * b], initial[3 * a + 1] - initial[3 * b + 1], initial[3 * a + 2] - initial[3 * b + 2]);
  }
  const onSeam = new Uint32Array(n);
  for (const v of mesh.seams) onSeam[v] = 1;

  const E = Uint32Array.from(edges), B = Uint32Array.from(bIdx);
  const ec = colorConstraints(E, 2, n);
  const bc = colorConstraints(B, 4, n);
  const sc = colorConstraints(mesh.seams, 2, n);
  return {
    params: p,
    vertexCount: n,
    invMass,
    edges: permute(E, ec.order, 2),
    edgeRest: permute(Float32Array.from(rest), ec.order, 1),
    edgeCompliance: permute(Float32Array.from(comp), ec.order, 1),
    edgeColors: ec.ranges,
    bendIdx: permute(B, bc.order, 4),
    bendK: permute(Float32Array.from(bK), bc.order, 4),
    bendCompliance: permute(Float32Array.from(bComp), bc.order, 1),
    bendColors: bc.ranges,
    seams: permute(Uint32Array.from(mesh.seams), sc.order, 2),
    seamStart: permute(seamStart, sc.order, 1),
    seamColors: sc.ranges,
    onSeam,
  };
}

/** Per-substep scalars (same formulas on CPU and GPU). */
export function substepState(p: ClothParams, time: number) {
  return {
    gravity: time > p.sewTime ? -9.81 : 0,
    /** Seam rest length factor: 1 → 0 while sewing. */
    sewK: Math.max(0, 1 - time / p.sewTime),
    sewing: time < p.sewTime,
  };
}

/** Stops the simulation once the cloth has come to rest after sewing. */
export class RestDetector {
  private still = 0;
  private last: Float32Array | null = null;

  constructor(private readonly speed = 0.004, private readonly frames = 20) {}

  /** Feed positions sampled `dt` seconds apart; returns true once at rest. */
  update(pos: Float32Array, dt: number, armed: boolean): boolean {
    if (this.last && armed) {
      let max = 0;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - this.last[i], dy = pos[i + 1] - this.last[i + 1], dz = pos[i + 2] - this.last[i + 2];
        max = Math.max(max, dx * dx + dy * dy + dz * dz);
      }
      this.still = Math.sqrt(max) / dt < this.speed ? this.still + 1 : 0;
    }
    if (this.last) this.last.set(pos);
    else this.last = Float32Array.from(pos);
    return this.still >= this.frames;
  }
}
