/**
 * Planar cross-sections of a triangle mesh, split into connected loops.
 * Horizontal cuts use a y-bucketed face index so that a cut only visits the
 * few hundred triangles it can intersect.
 */

export type Vec3 = [number, number, number];
export type P2 = [number, number];

export interface Loop {
  /** In-plane coordinates: (x, z) for horizontal cuts, (u, v) otherwise. */
  pts: P2[];
  /** Mean 3D distance of the loop points to the cut origin. */
  meanDist: number;
}

export class MeshSlicer {
  private readonly nv: number;
  private readonly y0: number;
  private readonly bins: Uint32Array[];
  private static readonly BIN = 0.02;

  constructor(private readonly pos: Float32Array, private readonly idx: ArrayLike<number>) {
    this.nv = pos.length / 3;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      lo = Math.min(lo, pos[i]);
      hi = Math.max(hi, pos[i]);
    }
    this.y0 = lo;
    const nb = Math.ceil((hi - lo) / MeshSlicer.BIN) + 1;
    const lists: number[][] = Array.from({ length: nb }, () => []);
    for (let f = 0; f < idx.length; f += 3) {
      const ya = pos[3 * idx[f] + 1], yb = pos[3 * idx[f + 1] + 1], yc = pos[3 * idx[f + 2] + 1];
      const b0 = Math.floor((Math.min(ya, yb, yc) - lo) / MeshSlicer.BIN);
      const b1 = Math.floor((Math.max(ya, yb, yc) - lo) / MeshSlicer.BIN);
      for (let b = b0; b <= b1; b++) lists[b].push(f);
    }
    this.bins = lists.map((l) => Uint32Array.from(l));
  }

  /** Loops of the cut by the horizontal plane at height y. */
  horizontal(y: number): Loop[] {
    const b = Math.floor((y - this.y0) / MeshSlicer.BIN);
    if (b < 0 || b >= this.bins.length) return [];
    const { pos } = this;
    return this.cut(
      this.bins[b],
      (v) => pos[3 * v + 1] - y,
      (x, _y, z) => [x, z],
      [0, y, 0],
    );
  }

  /** Loops of the cut by an arbitrary plane (visits every face). */
  plane(origin: Vec3, normal: Vec3): Loop[] {
    const a: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(a, normal));
    const v = cross(normal, u);
    const { pos } = this;
    const all = new Uint32Array(this.idx.length / 3).map((_, i) => 3 * i);
    return this.cut(
      all,
      (i) => (pos[3 * i] - origin[0]) * normal[0] + (pos[3 * i + 1] - origin[1]) * normal[1] + (pos[3 * i + 2] - origin[2]) * normal[2],
      (x, y, z) => {
        const dx = x - origin[0], dy = y - origin[1], dz = z - origin[2];
        return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
      },
      origin,
    );
  }

  private cut(
    faces: ArrayLike<number>,
    side: (v: number) => number,
    project: (x: number, y: number, z: number) => P2,
    origin: Vec3,
  ): Loop[] {
    const { pos, idx, nv } = this;
    const parent = new Map<number, number>();
    const find = (k: number): number => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(k, r);
      return r;
    };
    const points = new Map<number, { p: P2; d: number }>();
    const edgePoint = (a: number, b: number, da: number, db: number): number => {
      const key = a < b ? a * nv + b : b * nv + a;
      if (!points.has(key)) {
        const t = da / (da - db);
        const x = pos[3 * a] + t * (pos[3 * b] - pos[3 * a]);
        const y = pos[3 * a + 1] + t * (pos[3 * b + 1] - pos[3 * a + 1]);
        const z = pos[3 * a + 2] + t * (pos[3 * b + 2] - pos[3 * a + 2]);
        points.set(key, { p: project(x, y, z), d: Math.hypot(x - origin[0], y - origin[1], z - origin[2]) });
        parent.set(key, key);
      }
      return key;
    };

    const v = [0, 0, 0], d = [0, 0, 0];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      v[0] = idx[f]; v[1] = idx[f + 1]; v[2] = idx[f + 2];
      d[0] = side(v[0]); d[1] = side(v[1]); d[2] = side(v[2]);
      let first = -1, second = -1;
      for (let e = 0; e < 3; e++) {
        const e1 = (e + 1) % 3;
        if (d[e] < 0 === d[e1] < 0) continue;
        const k = edgePoint(v[e], v[e1], d[e], d[e1]);
        if (first < 0) first = k;
        else second = k;
      }
      if (second >= 0) {
        const ra = find(first), rb = find(second);
        if (ra !== rb) parent.set(ra, rb);
      }
    }

    const groups = new Map<number, { pts: P2[]; dist: number }>();
    for (const [key, { p, d: dist }] of points) {
      const r = find(key);
      let g = groups.get(r);
      if (!g) groups.set(r, (g = { pts: [], dist: 0 }));
      g.pts.push(p);
      g.dist += dist;
    }
    return [...groups.values()].map((g) => ({ pts: g.pts, meanDist: g.dist / g.pts.length }));
  }
}

export function convexHullPerimeter(points: P2[]): number {
  if (points.length < 3) return 0;
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: P2[]) => {
    const h: P2[] = [];
    for (const p of list) {
      while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = half(pts).concat(half(pts.slice().reverse()));
  let per = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return per;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
