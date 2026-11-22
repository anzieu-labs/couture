import type { SkinWeights } from "../avatar/anny";

/**
 * Signed distance field of the mannequin on a regular grid, used for cloth /
 * body collisions. Near the surface (narrow band) the distance is the
 * point-to-plane distance to the closest vertex (vertex normal); deeper cells are
 * classified inside/outside by a flood fill from the grid border.
 *
 * The field is built in the rest pose. With skin weights, each cell also gets
 * the skin influences of its closest body vertex, so that an animated body can
 * be collided with in rest space (see lib/sim/posedBody.ts).
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
   * Limbs tested on their own (lib/sim/posedBody.ts), 8 floats each: centre and radius of a
   * sphere around the limb's skin in the rest pose, then its bone index (and 3 unused).
   */
  readonly limbs: Float32Array;
}

/** Floats per limb in SdfGrid.limbs. */
export const LIMB_STRIDE = 8;

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

    // Bounding sphere of each limb's skin (the vertices mostly driven by its bone), with room
    // for the contact offset and the inflation.
    this.limbs = new Float32Array(LIMB_STRIDE * (skin ? limbs.length : 0));
    if (skin)
      limbs.forEach((bone, l) => {
        const own: number[] = [];
        for (let v = 0; v < positions.length / 3; v++)
          for (let k = 0; k < 4; k++) if (skin.index[4 * v + k] === bone && skin.weight[4 * v + k] >= 128) own.push(v);
        const c = [0, 0, 0];
        for (const v of own) for (let a = 0; a < 3; a++) c[a] += positions[3 * v + a] / own.length;
        let radius = 0;
        for (const v of own) radius = Math.max(radius, Math.hypot(positions[3 * v] - c[0], positions[3 * v + 1] - c[1], positions[3 * v + 2] - c[2]));
        this.limbs.set([c[0], c[1], c[2], own.length ? radius + 0.03 : 0, bone], LIMB_STRIDE * l);
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
