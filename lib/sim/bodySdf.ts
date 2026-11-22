import type { SkinWeights } from "../avatar/anny";

/**
 * Signed distance field of the mannequin on a regular grid, used for cloth /
 * body collisions. Near the surface (narrow band) the distance is the
 * point-to-plane distance to the closest vertex (vertex normal); deeper cells are
 * classified inside/outside by a flood fill from the grid border.
 *
 * Given the body's triangles, the cells closest to the skin (EXACT_BAND: where the cloth is
 * kept) get the exact distance to them instead. The plane of the closest vertex is off where
 * the body curves between two vertices: by up to 2.5 mm at the base of the neck — most of the
 * 3 mm of clearance — and the skin showed in the fold of a hood after a walk.
 *
 * Sharp parts are inflated for the cloth's mesh (`chord`): the solvers keep the cloth's
 * vertices off the field, and a triangle laid across a ridge of the body dips under its own
 * vertices by its size squared times the ridge's curvature, over 8 — over 6 once stretched by
 * the weight it carries there. The clearance covers that for parts as round as a limb
 * (garment/prepare.ts skinGapFor); the sharper ones — the top of a thin shoulder under the
 * largest triangles of a cape, along its shoulder seam — showed through (2 mm of skin above a
 * 3.9 cm triangle, its vertices all where the solver wanted them). So the distance is reduced
 * there by that dip, the curvature being read off the field itself (the Laplacian of a
 * distance is the sum of the principal curvatures of its level surface).
 *
 * The field is built in one pose, the body's as it stands (the "rest" pose of the collisions:
 * avatar/motion.ts standingBody). With skin weights, each cell also gets the skin influences
 * of its closest body vertex, so that an animated body can be collided with in that pose
 * (see lib/sim/posedBody.ts).
 *
 * Thin parts (the hands) can be inflated: the distance is reduced by an offset
 * weighted by the skin weight of the given joints, so the cloth meets a "mitten"
 * rather than fingers. Collisions are tested at the cloth vertices only: with
 * triangles wider than a finger (a cape's 2.2 cm mesh), fingertips poke through
 * between vertices, and the gaps between fingers catch the fabric.
 */

/** Joints whose skin is inflated, and by how much (m). */
export interface Inflation {
  joints: number[];
  offset: number;
}
/** Regular grid of signed distances (x fastest), as uploaded to the GPU. */
export interface SdfGrid {
  readonly data: Float32Array;
  /**
   * Skin influences of the closest body vertex, 2 words per cell: 4 joint
   * indices (one byte each), 4 weights (bytes summing to 255).
   */
  readonly skin: Uint32Array | null;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly min: [number, number, number];
  readonly h: number;
  /**
   * Limbs tested on their own (lib/sim/posedBody.ts), 8 floats each: a capsule around the
   * limb's skin in the field's pose — one end of its axis and its radius, then the other end
   * and the limb's bone index.
   */
  readonly limbs: Float32Array;
}

/** Floats per limb in SdfGrid.limbs. */
export const LIMB_STRIDE = 8;

/**
 * Cells closer than this to a body vertex get the exact distance to the body's triangles (m):
 * beyond the largest clearance the cloth is kept at, plus the cell or two the interpolation reaches.
 */
const EXACT_BAND = 0.03;
/**
 * Inflation of the sharp parts (see the header): curvature (1/m) up to which the uniform
 * clearance is enough (a 5 cm radius: an arm), and the most the field is inflated by (m).
 */
const ROUND = 1 / 0.05;
const MAX_CHORD_INFLATION = 0.009;

export class BodySdf implements SdfGrid {
  /** Distances, x fastest. */
  readonly data: Float32Array;
  readonly skin: Uint32Array | null = null;
  readonly limbs: Float32Array;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;

  constructor(
    positions: Float32Array,
    normals: Float32Array,
    readonly min: [number, number, number],
    max: [number, number, number],
    readonly h = 0.01,
    band = 0.05,
    skin?: SkinWeights,
    inflate?: Inflation,
    /** Bones of the limbs tested on their own (SdfGrid.limbs). */
    limbs: number[] = [],
    /** The body's triangles (3 vertex indices each): exact distances near the skin. */
    triangles?: ArrayLike<number>,
    /** Size of the cloth's largest triangles (m): the body's sharp parts are inflated for them (0: not). */
    chord = 0,
  ) {
    const nx = (this.nx = Math.ceil((max[0] - min[0]) / h) + 1);
    const ny = (this.ny = Math.ceil((max[1] - min[1]) / h) + 1);
    const nz = (this.nz = Math.ceil((max[2] - min[2]) / h) + 1);
    const n = nx * ny * nz;
    const sdf = (this.data = new Float32Array(n).fill(NaN));
    const best = new Float32Array(n).fill(Infinity);
    const nearest = skin ? new Int32Array(n).fill(-1) : null;
    const r = Math.ceil(band / h);

    for (let v = 0; v < positions.length; v += 3) {
      const px = positions[v], py = positions[v + 1], pz = positions[v + 2];
      const ci = Math.round((px - min[0]) / h), cj = Math.round((py - min[1]) / h), ck = Math.round((pz - min[2]) / h);
      if (ci < -r || cj < -r || ck < -r || ci > nx + r || cj > ny + r || ck > nz + r) continue;
      const nxv = normals[v], nyv = normals[v + 1], nzv = normals[v + 2];
      for (let k = Math.max(0, ck - r); k <= Math.min(nz - 1, ck + r); k++)
        for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j++)
          for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i++) {
            const gx = min[0] + i * h - px, gy = min[1] + j * h - py, gz = min[2] + k * h - pz;
            const d2 = gx * gx + gy * gy + gz * gz;
            const c = i + nx * (j + ny * k);
            if (d2 < best[c]) {
              best[c] = d2;
              sdf[c] = gx * nxv + gy * nyv + gz * nzv;
              if (nearest) nearest[c] = v / 3;
            }
          }
    }

    if (triangles) {
      const exact = exactBand(positions, triangles, min, h, nx, ny, nz, best, sdf, nearest);
      if (chord > 0) inflateSharp(sdf, exact, nx, ny, nz, h, chord);
    }

    // Flood fill unknown cells from the border: reachable = outside.
    const outside = new Uint8Array(n);
    const stack: number[] = [];
    const push = (c: number) => {
      if (!outside[c] && Number.isNaN(sdf[c])) {
        outside[c] = 1;
        stack.push(c);
      }
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++)
          if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      if (i > 0) push(c - 1);
      if (i < nx - 1) push(c + 1);
      if (j > 0) push(c - nx);
      if (j < ny - 1) push(c + nx);
      if (k > 0) push(c - nx * ny);
      if (k < nz - 1) push(c + nx * ny);
    }
    for (let c = 0; c < n; c++) if (Number.isNaN(sdf[c]) && outside[c]) sdf[c] = band;

    // Deep inside: distance transform (breadth-first, one cell per layer) from
    // the band, so the field keeps pointing outwards. A constant value there
    // would have no gradient, and a vertex pushed deep inside would never come out.
    const layer: number[] = [];
    for (let c = 0; c < n; c++) if (Number.isNaN(sdf[c])) layer.push(c);
    const inside = new Set(layer);
    let frontier = layer.filter((c) => {
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      const near = (d: number) => !inside.has(c + d);
      return (i > 0 && near(-1)) || (i < nx - 1 && near(1)) || (j > 0 && near(-nx)) || (j < ny - 1 && near(nx)) ||
        (k > 0 && near(-nx * ny)) || (k < nz - 1 && near(nx * ny));
    });
    for (let depth = 1; frontier.length; depth++) {
      for (const c of frontier) {
        sdf[c] = -band - (depth - 1) * h;
        inside.delete(c);
      }
      const next = new Set<number>();
      for (const c of frontier) {
        const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
        for (const [ok, d] of [[i > 0, -1], [i < nx - 1, 1], [j > 0, -nx], [j < ny - 1, nx], [k > 0, -nx * ny], [k < nz - 1, nx * ny]] as const)
          if (ok && inside.has(c + d)) next.add(c + d);
      }
      frontier = [...next];
    }

    // Inflation of thin parts, in the band (where the closest vertex is known), before
    // the skin grid spreads `nearest` to every cell. Weighted by skinning, so the offset
    // fades in along the wrist instead of making a step in the field.
    if (inflate && skin && nearest && inflate.offset > 0) {
      const share = new Float32Array(positions.length / 3);
      for (let v = 0; v < share.length; v++)
        for (let k = 0; k < 4; k++) if (inflate.joints.includes(skin.index[4 * v + k])) share[v] += skin.weight[4 * v + k] / 255;
      for (let c = 0; c < n; c++) if (nearest[c] >= 0 && share[nearest[c]] > 0) sdf[c] -= inflate.offset * share[nearest[c]];
    }

    if (skin && nearest) this.skin = skinGrid(nearest, skin, nx, ny, nz);

    // Bounding capsule of each limb's skin (the vertices mostly driven by its bone), along its
    // longest direction, with room for the contact offset and the inflation. A capsule and
    // not a sphere: a forearm's sphere is 21 cm in radius, and with the arms along the body it
    // takes in the hip and the thigh — whose cloth then got the treatment meant for the cloth
    // a swinging forearm hits (posedBody.ts: pushed 3 cm off the skin, a skirt stretched by 180 %).
    this.limbs = new Float32Array(LIMB_STRIDE * (skin ? limbs.length : 0));
    if (skin)
      limbs.forEach((bone, l) => {
        const own: number[] = [];
        for (let v = 0; v < positions.length / 3; v++)
          for (let k = 0; k < 4; k++) if (skin.index[4 * v + k] === bone && skin.weight[4 * v + k] >= 128) own.push(v);
        this.limbs[LIMB_STRIDE * l + 7] = bone;
        if (!own.length) return;
        const c = [0, 0, 0];
        for (const v of own) for (let a = 0; a < 3; a++) c[a] += positions[3 * v + a] / own.length;
        // Longest direction: dominant eigenvector of the covariance (power iteration).
        const cov = new Float64Array(9);
        for (const v of own)
          for (let a = 0; a < 3; a++)
            for (let e = 0; e < 3; e++) cov[3 * a + e] += (positions[3 * v + a] - c[a]) * (positions[3 * v + e] - c[e]);
        let u = [1, 1, 1];
        for (let it = 0; it < 50; it++) {
          const w = [0, 1, 2].map((a) => cov[3 * a] * u[0] + cov[3 * a + 1] * u[1] + cov[3 * a + 2] * u[2]);
          const len = Math.hypot(w[0], w[1], w[2]);
          if (!len) break;
          u = [w[0] / len, w[1] / len, w[2] / len];
        }
        const ul = Math.hypot(u[0], u[1], u[2]);
        u = [u[0] / ul, u[1] / ul, u[2] / ul];
        let lo = Infinity, hi = -Infinity, radius = 0;
        for (const v of own) {
          const d = [positions[3 * v] - c[0], positions[3 * v + 1] - c[1], positions[3 * v + 2] - c[2]];
          const t = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
          lo = Math.min(lo, t);
          hi = Math.max(hi, t);
          radius = Math.max(radius, Math.sqrt(Math.max(0, d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - t * t)));
        }
        this.limbs.set([c[0] + u[0] * lo, c[1] + u[1] * lo, c[2] + u[2] * lo, radius + 0.03, c[0] + u[0] * hi, c[1] + u[1] * hi, c[2] + u[2] * hi], LIMB_STRIDE * l);
      });
  }

  /** Trilinear distance; large positive outside the grid. */
  sample(x: number, y: number, z: number): number {
    const fx = (x - this.min[0]) / this.h, fy = (y - this.min[1]) / this.h, fz = (z - this.min[2]) / this.h;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const { nx, ny, nz, data } = this;
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 1;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const c00 = data[c] * (1 - tx) + data[c + 1] * tx;
    const c10 = data[c + sy] * (1 - tx) + data[c + sy + 1] * tx;
    const c01 = data[c + sz] * (1 - tx) + data[c + sz + 1] * tx;
    const c11 = data[c + sy + sz] * (1 - tx) + data[c + sy + sz + 1] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }

  /** Unit outward direction (normalized gradient) written into `out`. */
  gradient(x: number, y: number, z: number, out: Float32Array | number[]): void {
    const e = this.h * 0.5;
    const gx = this.sample(x + e, y, z) - this.sample(x - e, y, z);
    const gy = this.sample(x, y + e, z) - this.sample(x, y - e, z);
    const gz = this.sample(x, y, z + e) - this.sample(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
  }
}

/**
 * Exact signed distance to the body's triangles for the cells within EXACT_BAND of a vertex
 * (`best`: squared distance to the closest one), written over the point-to-plane estimate in
 * `sdf`; `nearest` becomes the corner of the closest triangle the closest point is nearest to.
 *
 * Each triangle is tested against the cells of its box grown by the band — every cell meets
 * every triangle that could be its closest. The sign is that of the side of the closest
 * point's normal, interpolated from angle-weighted vertex normals: on an edge or at a vertex
 * of the mesh, where a face's own normal says nothing, that is the pseudo-normal (Bærentzen &
 * Aanæs 2005), which does tell inside from outside. Returns the squared exact distance of
 * each cell (Infinity where it was not computed).
 */
function exactBand(
  positions: Float32Array,
  triangles: ArrayLike<number>,
  min: [number, number, number],
  h: number,
  nx: number,
  ny: number,
  nz: number,
  best: Float32Array,
  sdf: Float32Array,
  nearest: Int32Array | null,
): Float32Array {
  const P = positions;
  const band2 = EXACT_BAND * EXACT_BAND;
  // Angle-weighted vertex normals of the mesh itself.
  const vn = new Float64Array(P.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [3 * triangles[t], 3 * triangles[t + 1], 3 * triangles[t + 2]];
    const e1 = [P[v[1]] - P[v[0]], P[v[1] + 1] - P[v[0] + 1], P[v[1] + 2] - P[v[0] + 2]];
    const e2 = [P[v[2]] - P[v[0]], P[v[2] + 1] - P[v[0] + 1], P[v[2] + 2] - P[v[0] + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (!nl) continue;
    for (let k = 0; k < 3; k++) {
      const o = v[k], a = v[(k + 1) % 3], b = v[(k + 2) % 3];
      const ux = P[a] - P[o], uy = P[a + 1] - P[o + 1], uz = P[a + 2] - P[o + 2];
      const wx = P[b] - P[o], wy = P[b + 1] - P[o + 1], wz = P[b + 2] - P[o + 2];
      const angle = Math.acos(Math.min(1, Math.max(-1, (ux * wx + uy * wy + uz * wz) / (Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz) || 1))));
      for (let a3 = 0; a3 < 3; a3++) vn[o + a3] += (angle * n[a3]) / nl;
    }
  }

  const exact2 = new Float32Array(sdf.length).fill(Infinity);
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = 3 * triangles[t], ib = 3 * triangles[t + 1], ic = 3 * triangles[t + 2];
    const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
    const abx = P[ib] - ax, aby = P[ib + 1] - ay, abz = P[ib + 2] - az;
    const acx = P[ic] - ax, acy = P[ic + 1] - ay, acz = P[ic + 2] - az;
    // Unit normal of the face: the distance to its plane bounds the distance to the triangle from below.
    let fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx;
    const fl = Math.hypot(fx, fy, fz);
    if (!fl) continue;
    fx /= fl; fy /= fl; fz /= fl;
    const lo = (a: number, b: number, c: number, o: number) => Math.max(0, Math.ceil((Math.min(a, b, c) - EXACT_BAND - o) / h));
    const hi = (a: number, b: number, c: number, o: number, n: number) => Math.min(n - 1, Math.floor((Math.max(a, b, c) + EXACT_BAND - o) / h));
    const i0 = lo(ax, P[ib], P[ic], min[0]), i1 = hi(ax, P[ib], P[ic], min[0], nx);
    const j0 = lo(ay, P[ib + 1], P[ic + 1], min[1]), j1 = hi(ay, P[ib + 1], P[ic + 1], min[1], ny);
    const k0 = lo(az, P[ib + 2], P[ic + 2], min[2]), k1 = hi(az, P[ib + 2], P[ic + 2], min[2], nz);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cell = i + nx * (j + ny * k);
          if (!(best[cell] <= band2)) continue; // far from every vertex: the estimate will do
          const apx = min[0] + i * h - ax, apy = min[1] + j * h - ay, apz = min[2] + k * h - az;
          const off = apx * fx + apy * fy + apz * fz;
          if (off * off >= exact2[cell]) continue;
          // Closest point of the triangle, a + u·ab + v·ac (Ericson, Real-Time Collision Detection, 5.1.5).
          let u = 0, v = 0;
          const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
          if (!(d1 <= 0 && d2 <= 0)) {
            const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
            const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
            if (d3 >= 0 && d4 <= d3) u = 1;
            else if (d1 * d4 - d3 * d2 <= 0 && d1 >= 0 && d3 <= 0) u = d1 / (d1 - d3);
            else {
              const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
              const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
              if (d6 >= 0 && d5 <= d6) v = 1;
              else if (d5 * d2 - d1 * d6 <= 0 && d2 >= 0 && d6 <= 0) v = d2 / (d2 - d6);
              else {
                const va = d3 * d6 - d5 * d4;
                if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                  v = (d4 - d3) / (d4 - d3 + (d5 - d6));
                  u = 1 - v;
                } else {
                  const vb = d5 * d2 - d1 * d6, vc = d1 * d4 - d3 * d2;
                  u = vb / (va + vb + vc);
                  v = vc / (va + vb + vc);
                }
              }
            }
          }
          // From the closest point to the cell.
          const rx = apx - u * abx - v * acx, ry = apy - u * aby - v * acy, rz = apz - u * abz - v * acz;
          const d = rx * rx + ry * ry + rz * rz;
          if (d >= exact2[cell]) continue;
          exact2[cell] = d;
          const w = 1 - u - v;
          const side =
            rx * (w * vn[ia] + u * vn[ib] + v * vn[ic]) + ry * (w * vn[ia + 1] + u * vn[ib + 1] + v * vn[ic + 1]) + rz * (w * vn[ia + 2] + u * vn[ib + 2] + v * vn[ic + 2]);
          sdf[cell] = side < 0 ? -Math.sqrt(d) : Math.sqrt(d);
          if (nearest) nearest[cell] = (w >= u && w >= v ? ia : u >= v ? ib : ic) / 3;
        }
  }
  return exact2;
}

/**
 * Inflates the sharp convex parts of the body for cloth triangles of size `chord` (see the
 * header): where the field's curvature exceeds ROUND, the distance is reduced by
 * chord² · (curvature − ROUND) / 6, MAX_CHORD_INFLATION at most. Only where the distance is
 * exact (`exact2`, from exactBand) and so are its six neighbours; smoothed once, and faded
 * out towards the edge of the exact band so that the field stays continuous.
 */
function inflateSharp(sdf: Float32Array, exact2: Float32Array, nx: number, ny: number, nz: number, h: number, chord: number) {
  const sy = nx, sz = nx * ny;
  const raw = new Float32Array(sdf.length);
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + nx * (j + ny * k);
        if (exact2[c] === Infinity || exact2[c - 1] === Infinity || exact2[c + 1] === Infinity || exact2[c - sy] === Infinity || exact2[c + sy] === Infinity || exact2[c - sz] === Infinity || exact2[c + sz] === Infinity) continue;
        const curvature = (sdf[c - 1] + sdf[c + 1] + sdf[c - sy] + sdf[c + sy] + sdf[c - sz] + sdf[c + sz] - 6 * sdf[c]) / (h * h);
        if (curvature <= ROUND) continue;
        const fade = Math.min(1, Math.max(0, (EXACT_BAND - Math.sqrt(exact2[c])) / 0.01));
        raw[c] = fade * Math.min(MAX_CHORD_INFLATION, (chord * chord * (curvature - ROUND)) / 6);
      }
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + nx * (j + ny * k);
        if (exact2[c] === Infinity) continue;
        sdf[c] -= (2 * raw[c] + raw[c - 1] + raw[c + 1] + raw[c - sy] + raw[c + sy] + raw[c - sz] + raw[c + sz]) / 8;
      }
}

/**
 * Skin influences of the closest vertex for every cell: the narrow band knows
 * it, the other cells inherit it breadth-first from their neighbours.
 */
function skinGrid(nearest: Int32Array, skin: SkinWeights, nx: number, ny: number, nz: number): Uint32Array {
  const n = nearest.length;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let c = 0; c < n; c++) if (nearest[c] >= 0) queue[tail++] = c;
  while (head < tail) {
    const c = queue[head++];
    const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
    const visit = (d: number) => {
      if (nearest[c + d] < 0) {
        nearest[c + d] = nearest[c];
        queue[tail++] = c + d;
      }
    };
    if (i > 0) visit(-1);
    if (i < nx - 1) visit(1);
    if (j > 0) visit(-nx);
    if (j < ny - 1) visit(nx);
    if (k > 0) visit(-nx * ny);
    if (k < nz - 1) visit(nx * ny);
  }
  const out = new Uint32Array(2 * n);
  const index = new Uint32Array(skin.index.buffer, skin.index.byteOffset, skin.index.length / 4);
  const weight = new Uint32Array(skin.weight.buffer, skin.weight.byteOffset, skin.weight.length / 4);
  for (let c = 0; c < n; c++) {
    const v = Math.max(0, nearest[c]);
    out[2 * c] = index[v];
    out[2 * c + 1] = weight[v];
  }
  return out;
}
