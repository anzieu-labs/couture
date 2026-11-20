/**
 * Signed distance field of the mannequin on a regular grid, used for cloth /
 * body collisions. Near the surface (narrow band) the distance is the
 * point-to-plane distance to the closest vertex (vertex normal); deeper cells are
 * classified inside/outside by a flood fill from the grid border.
 */
export class BodySdf {
  private readonly data: Float32Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;

  constructor(
    positions: Float32Array,
    normals: Float32Array,
    readonly min: [number, number, number],
    max: [number, number, number],
    readonly h = 0.01,
    band = 0.05,
  ) {
    const nx = (this.nx = Math.ceil((max[0] - min[0]) / h) + 1);
    const ny = (this.ny = Math.ceil((max[1] - min[1]) / h) + 1);
    const nz = (this.nz = Math.ceil((max[2] - min[2]) / h) + 1);
    const n = nx * ny * nz;
    const sdf = (this.data = new Float32Array(n).fill(NaN));
    const best = new Float32Array(n).fill(Infinity);
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
    for (let c = 0; c < n; c++) if (Number.isNaN(sdf[c])) sdf[c] = outside[c] ? band : -band;
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
