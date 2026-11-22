import type { GarmentMesh } from "../pattern/mesh";
import { buildSelfCollision, type SelfCollisionModel } from "./selfCollision";

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
 *  - sewing: seam vertex pairs pulled together, rest length ramping to 0;
 *  - clasps: vertex pairs fastened once the garment is on (see CLASP);
 *  - self-collisions: see selfCollision.ts.
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
  /**
   * Seconds left to the garment to fall into its drape before the body may move.
   * A cape falls 1.2 m: if the arms start swinging mid-fall, it lands inside them
   * and gets crushed between arm and torso.
   */
  settleTime: number;
  /** Maximum simulated time (s). */
  duration: number;
  /** Velocity damping (1/s). */
  damping: number;
  /** Substeps between two self-collision passes (0: off). */
  selfInterval: number;
  /**
   * The same while the cloth is held by hand and just after (lib/sim/grab.ts): the hand
   * accelerates the cloth more than passes that far apart can catch.
   */
  selfIntervalHeld: number;
  /**
   * Gauss-Seidel sweeps per substep over the stretch constraints and the seams (alternately
   * forward and backward), and how many of them also sweep the bending constraints.
   */
  stretchSweeps: number;
  bendSweeps: number;
  /** Height of the floor under the feet (m, body frame): the top of the plinth. −Infinity: no floor. */
  floorY: number;
}

/**
 * The plinth the mannequin stands on (a cylinder centred on the body's vertical axis): its top
 * is the floor under the feet; around it the ground lies `height` lower. A garment that falls
 * lands on them instead of going through (contacts of both solvers).
 */
export const PLINTH = { radius: 0.42, height: 0.04 };

/** Height of the ground under the point (x, z) for a floor at `floorY` under the feet. */
export const floorAt = (floorY: number, x: number, z: number) => (x * x + z * z > PLINTH.radius * PLINTH.radius ? floorY - PLINTH.height : floorY);

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
  settleTime: 0,
  duration: 5,
  damping: 1.5,
  selfInterval: 2,
  selfIntervalHeld: 1,
  stretchSweeps: 4,
  bendSweeps: 1,
  floorY: -Infinity,
};

/** Light load used to turn "elongation under light load" into a tensile modulus (N/m). */
const REFERENCE_LOAD = 20;
const MAX_TENSILE = 2e4;

/** Tensile moduli (N/m) along the warp (pattern y) and the weft (pattern x). */
export function tensileModuli(p: ClothParams): { warp: number; weft: number } {
  return {
    warp: Math.min(MAX_TENSILE, REFERENCE_LOAD / (p.stretchWarp / 100)),
    weft: Math.min(MAX_TENSILE, REFERENCE_LOAD / (p.stretchWeft / 100)),
  };
}

/**
 * Clasps (pattern/types.ts Clasp) are fastened as one does: the garment is put on first — sewn,
 * left to fall for `delay` s — then the two points are brought together and held: they may
 * not be further apart than a distance that comes down from `reach` (m) to 0 at `speed` (m/s),
 * so that wherever they are, they are met without a jolt. Closed with the seams instead, a
 * cape's neckline was already a ring when it came down from where it is laid, at the height
 * of the chin: one time in two it closed over the chin and stayed hooked on it, the whole
 * cape hanging from the head.
 *
 * Until then the two points are neither free nor held together: they may part by `slack` (m),
 * or by what they were put on with when that is more (ClothModel.seamStart). Free, a slippery
 * cape (satin) with no hood to hold it slid off the shoulders and was on the floor before its
 * clasp closed — a hand's breadth is less than a neck, it cannot pass. Held together from the
 * start (the corners of a cape's fronts are laid a centimetre apart), the neckline was a ring
 * again while the hood's seams drew it up to the chin, and the clasp ended in the mouth: a
 * hand's breadth lets the chin through.
 */
export const CLASP = { delay: 1.5, reach: 0.6, speed: 0.5, slack: 0.1 };

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
  /** Stitched pairs: the seams' and the clasps'. */
  seams: Uint32Array;
  /** Distance of each pair before sewing (m); negative: a clasp — as far apart as it may ever be, fastened later (CLASP). */
  seamStart: Float32Array;
  seamColors: ColorRanges;
  /** Simulated time from which the garment is all put together: its seams closed, its clasps fastened (s). */
  fastenedAt: number;
  /** 1 for vertices on a seam (they may cross the body while sewing). */
  onSeam: Uint32Array;
  triangles: Uint32Array;
  /** Self-collisions (null: off). */
  self: SelfCollisionModel | null;
  /** Bands: see BandModel. */
  bands: BandModel;
}

/**
 * Bands (pattern/types.ts Band): the summed length of a band's segments stays below its
 * length on the pattern (plus its elasticity). A waistband resting on the hips is held by hoop tension, which edge by edge
 * Gauss-Seidel builds up far too slowly (a ring of N edges passes on a fraction ~1/N² of a
 * radial load per sweep): without the band a skirt's waist opens by 20 % and slides down.
 *
 * A band longer than its rest length is scaled down about its centre of mass: every
 * segment shortens by the same ratio whatever the band's shape, and neither linear nor
 * angular momentum changes. (Moving the vertices along the gradient of the length
 * instead concentrates the correction on the kinks of the polyline, and tears it.)
 */
export interface BandModel {
  /**
   * Per band: first segment, segment count, first vertex, vertex count. A band shorter than its
   * edges has no segment: what is held is the way round its vertices, not the length of cloth
   * between them (BELT).
   */
  ranges: Uint32Array;
  /** Longest each band may get (m): its length on the pattern, plus its elasticity (less, when it gathers the cloth). */
  rest: Float32Array;
  /** Length each band has on the pattern (m): where one that gathers starts from as it is drawn in (bandLimit); `rest` for the others. */
  from: Float32Array;
  /** Segments, as pairs of vertices. */
  segments: Uint32Array;
  /** Vertices of each band. */
  vertices: Uint32Array;
}

function buildBands(mesh: GarmentMesh): BandModel {
  const ranges: number[] = [], rest: number[] = [], from: number[] = [], segments: number[] = [], vertices: number[] = [];
  for (const { segments: pairs, stretch } of mesh.bands ?? []) {
    const own = [...new Set(pairs)];
    const gathers = stretch < 0;
    ranges.push(segments.length / 2, gathers ? 0 : pairs.length / 2, vertices.length, own.length);
    let length = 0;
    for (let i = 0; i < pairs.length; i += 2)
      length += Math.hypot(mesh.rest[2 * pairs[i]] - mesh.rest[2 * pairs[i + 1]], mesh.rest[2 * pairs[i] + 1] - mesh.rest[2 * pairs[i + 1] + 1]);
    if (!gathers) segments.push(...pairs);
    vertices.push(...own);
    rest.push(length * (1 + stretch));
    from.push(gathers ? length : rest[rest.length - 1]);
  }
  return { ranges: Uint32Array.from(ranges), rest: Float32Array.from(rest), from: Float32Array.from(from), segments: Uint32Array.from(segments), vertices: Uint32Array.from(vertices) };
}

/**
 * A band shorter than the edges it is sewn along — an elastic that gathers them (a belt with a
 * negative elasticity, pattern/types.ts Belt) — is drawn in as a clasp is fastened (CLASP), once
 * the garment is on: sewn, left to fall for `delay` s, then from the length of its edges to its
 * own at `speed` (m of band per second). Drawn in at once, one 25 cm shorter than a t-shirt is
 * wide moves its cloth by 4 cm in the first substep.
 *
 * It holds the way round the cloth, not the cloth: on it the cloth gathers, and the length of
 * cloth along the edge stays what it was (held to the band's length as a waistband's is, the
 * edge was crushed against the stretch constraints — 150 % of strain, and no shorter round).
 * The way round is measured on the outermost vertex of each of `sectors` directions about the
 * centre of the band's vertices, seen from above (the body stands, and a waist or a hem lies
 * level: a sleeve's hem, on a hanging arm, nearly so); longer than the band, they are drawn
 * towards their centre, level, by the ratio.
 */
export const BELT = { delay: 1.5, speed: 0.25, sectors: 32 };

/**
 * Longest a band may be at a time (m): its rest length; for one that gathers, the length of
 * its edges until it is drawn in (it holds from the start: a skirt whose waist held nothing
 * for a second and a half was on the knees by then), then on its way to its own (BELT).
 */
export function bandLimit(bands: BandModel, b: number, p: ClothParams, time: number): number {
  return Math.max(bands.rest[b], bands.from[b] - BELT.speed * Math.max(0, time - p.sewTime - BELT.delay));
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

  // Masses.
  const mass = new Float32Array(n);
  for (let t = 0; t < tri.length; t += 3) {
    const m = (area(tri[t], tri[t + 1], tri[t + 2]) * p.density) / 3;
    for (let k = 0; k < 3; k++) mass[tri[t + k]] += m;
  }
  const invMass = mass.map((m) => (m > 0 ? 1 / m : 0));

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
    bComp.push(A / (3 * p.bending));
  }

  const seamStart = new Float32Array(mesh.seams.length / 2);
  // The clasps are the last pairs (pattern/mesh.ts).
  const sewn = seamStart.length - (mesh.clasps?.length ?? 0) / 2;
  const onSeam = new Uint32Array(n);
  for (let s = 0; s < seamStart.length; s++) {
    const a = mesh.seams[2 * s], b = mesh.seams[2 * s + 1];
    const apart = Math.hypot(initial[3 * a] - initial[3 * b], initial[3 * a + 1] - initial[3 * b + 1], initial[3 * a + 2] - initial[3 * b + 2]);
    if (s >= sewn) {
      // A clasp: told by the sign, with how far apart its points may be until it is fastened (CLASP).
      seamStart[s] = -Math.max(apart, CLASP.slack);
      continue;
    }
    seamStart[s] = apart;
    onSeam[a] = onSeam[b] = 1;
  }

  const E = Uint32Array.from(edges), B = Uint32Array.from(bIdx);
  const maxEdge = rest.reduce((m, l) => Math.max(m, l), 0);
  const self = p.selfInterval > 0 ? buildSelfCollision(tri, E, mesh.seams, n, maxEdge, p.thickness, p.selfInterval) : null;

  const ec = colorConstraints(E, 2, n);
  const bc = colorConstraints(B, 4, n);
  const sc = colorConstraints(mesh.seams, 2, n);
  const bands = buildBands(mesh);
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
    fastenedAt: p.sewTime + Math.max(sewn < seamStart.length ? CLASP.delay + CLASP.reach / CLASP.speed : 0, ...Array.from(bands.rest, (r, b) => (bands.from[b] > r ? BELT.delay + (bands.from[b] - r) / BELT.speed : 0))),
    onSeam,
    triangles: tri,
    self,
    bands,
  };
}

/**
 * Self-collisions start this long after the seams are closed (s): pieces may
 * cross while being sewn, and the passes keep each vertex on the side it was
 * on — the garment first untangles under gravity. Before the body moves
 * (avatar/motion.ts MOTION_DELAY).
 */
export const SELF_DELAY = 0.4;

/** Whether the garment is still being put together at `time`: seams closing, then untangling (sweepPlan). */
export const assembling = (p: ClothParams, time: number) => time <= p.sewTime + SELF_DELAY;

/** Per-substep scalars (same formulas on CPU and GPU). */
export function substepState(p: ClothParams, time: number) {
  return {
    selfActive: time > p.sewTime + SELF_DELAY,
    gravity: time > p.sewTime ? -9.81 : 0,
    /** Seam rest length factor: 1 → 0 while sewing. */
    sewK: Math.max(0, 1 - time / p.sewTime),
    sewing: time < p.sewTime,
    /** Largest distance left between the two points of a clasp (m; CLASP): Infinity until they are fastened, then down to 0. */
    claspGoal: time >= p.sewTime + CLASP.delay ? Math.max(0, CLASP.reach - CLASP.speed * (time - p.sewTime - CLASP.delay)) : Infinity,
  };
}

/** One Gauss-Seidel sweep of a substep: its direction, and whether it includes the bending constraints. */
export interface Sweep {
  reverse: boolean;
  bending: boolean;
}

/**
 * Sweeps of a substep (same on CPU and GPU). Stretch and seams are swept `stretchSweeps`
 * times, alternately forward and backward; the first `bendSweeps` sweeps also solve the
 * bending constraints. Odd substeps run the mirrored sequence, so that a single bending
 * sweep per substep still alternates its direction.
 *
 * Stretch is what converges slowly (a load carried along N edges is corrected by ~1/N² per
 * sweep) while bending, a soft constraint, is solved in one sweep: 4 + 1 sweeps cost what
 * 2 + 2 did and halve the spurious elongation (hanging denim strip: 1.49 % → 0.75 %; the
 * tip of a 12 cm cantilever comes down 1.5 % more).
 *
 * Until self-collisions start (`assembling`, see assembling(): decided once per frame),
 * 2 + 2 sweeps: the pieces cross each other as they are sewn together, and the softer cloth
 * of fewer stretch sweeps lets them slip apart again in time; with 4 sweeps some crossings
 * were still there when self-collisions started, and stayed locked in for good.
 */
export function sweepPlan(p: ClothParams, substep: number, assembling: boolean): Sweep[] {
  const stretch = assembling ? 2 : p.stretchSweeps, bend = assembling ? 2 : p.bendSweeps;
  return Array.from({ length: stretch }, (_, i) => ({ reverse: (i + (bend % 2 ? substep : 0)) % 2 === 1, bending: i < bend }));
}

/**
 * When the cloth is at rest, and the simulation stops: when none of its points goes anywhere
 * any more — the fastest one under `speed` (m/s; 4 mm/s is a pixel in several seconds on the
 * screen) over `windows` stretches of `window` s in a row on the GPU, or over as many frames
 * on the CPU (RestDetector). Counted from where the points get to, not from the solver's
 * velocities, which never go to zero. A fold that keeps creeping never passes: `patience` s
 * after the body or the hand last moved, or half as long again as the garment's own duration
 * while it is put on, the simulation stops anyway.
 */
export const REST = { speed: 0.004, window: 0.25, windows: 2, patience: 8, overtime: 1.5 };

/** Simulated time at which a garment stops whether at rest or not (REST). */
export const restDeadline = (duration: number, movedAt: number) => Math.max(REST.overtime * duration, movedAt + REST.patience);

/** Stops the simulation once the cloth has come to rest after sewing. */
export class RestDetector {
  private still = 0;
  private last: Float32Array | null = null;

  constructor(private readonly speed = REST.speed, private readonly frames = Math.round(REST.windows * REST.window * 60)) {}

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

  /** Starts counting again (the body moved). */
  reset() {
    this.still = 0;
  }
}
