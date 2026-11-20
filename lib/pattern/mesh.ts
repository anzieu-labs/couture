import cdt2d from "cdt2d";
import { polylineLength, resample, type P2 } from "./curves";
import type { Pattern, PieceId } from "./tshirt";

/**
 * Turns a pattern into a simulation mesh: every piece is sampled at ~`spacing`
 * cm (seam edges get the same count on both sides so they can be stitched
 * vertex to vertex), filled with a hexagonal point grid and triangulated:
 * cdt2d builds a constrained triangulation, then Lawson edge flips (floating
 * point — much faster than cdt2d's exact-arithmetic pass) make it Delaunay.
 */

export interface GarmentMesh {
  /** Rest (flat) coordinates in meters, 2 per vertex — also the UVs. */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Piece index of each vertex. */
  piece: Uint8Array;
  pieceIds: PieceId[];
  /** Stitched vertex pairs. */
  seams: Uint32Array;
}

const key = (piece: string, edge: string) => `${piece}/${edge}`;

function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolygon(p: P2, poly: P2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** Lawson flips: makes a constrained triangulation Delaunay (in place). */
function delaunayFlips(pts: P2[], tris: [number, number, number][], constrained: Set<number>): void {
  const n = pts.length;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const edgeTris = new Map<number, number[]>();
  const link = (t: number) => {
    for (let e = 0; e < 3; e++) {
      const k = key(tris[t][e], tris[t][(e + 1) % 3]);
      const list = edgeTris.get(k);
      if (list) list.push(t);
      else edgeTris.set(k, [t]);
    }
  };
  const unlink = (t: number) => {
    for (let e = 0; e < 3; e++) {
      const list = edgeTris.get(key(tris[t][e], tris[t][(e + 1) % 3]))!;
      list.splice(list.indexOf(t), 1);
    }
  };
  tris.forEach((_, t) => link(t));
  const ccw = (a: number, b: number, c: number) =>
    (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]) > 0;
  // Is d strictly inside the circumcircle of the counter-clockwise triangle (a, b, c)?
  const inCircle = (a: P2, b: P2, c: P2, d: P2) => {
    const ax = a[0] - d[0], ay = a[1] - d[1], bx = b[0] - d[0], by = b[1] - d[1], cx = c[0] - d[0], cy = c[1] - d[1];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-9;
  };
  const queue = [...edgeTris.keys()];
  const queued = new Set(queue);
  let guard = queue.length * 20;
  while (queue.length && guard-- > 0) {
    const k = queue.pop()!;
    queued.delete(k);
    if (constrained.has(k)) continue;
    const pair = edgeTris.get(k);
    if (!pair || pair.length !== 2) continue;
    const [t0, t1] = pair;
    const a = Math.floor(k / n), b = k % n;
    const c = tris[t0].find((v) => v !== a && v !== b)!;
    const d = tris[t1].find((v) => v !== a && v !== b)!;
    const [p, q] = ccw(a, b, c) ? [a, b] : [b, a];
    if (!inCircle(pts[p], pts[q], pts[c], pts[d])) continue;
    unlink(t0);
    unlink(t1);
    tris[t0] = [c, p, d];
    tris[t1] = [d, q, c];
    link(t0);
    link(t1);
    for (const [u, v] of [[c, p], [p, d], [d, q], [q, c]]) {
      const ek = key(u, v);
      if (!queued.has(ek)) {
        queued.add(ek);
        queue.push(ek);
      }
    }
  }
}

export function meshPattern(pattern: Pattern, spacing = 2): GarmentMesh {
  // 1. Segment counts: shared by both sides of each seam.
  const counts = new Map<string, number>();
  const edgeLength = (piece: string, edge: string) =>
    polylineLength(pattern.pieces.find((p) => p.id === piece)!.edges.find((e) => e.id === edge)!.pts);
  for (const s of pattern.seams) {
    const n = Math.max(2, Math.round(Math.max(edgeLength(s.a.piece, s.a.edge), edgeLength(s.b.piece, s.b.edge)) / spacing));
    counts.set(key(s.a.piece, s.a.edge), n);
    counts.set(key(s.b.piece, s.b.edge), n);
  }

  const rest: number[] = [];
  const tris: number[] = [];
  const pieceOf: number[] = [];
  const edgeVerts = new Map<string, number[]>();

  pattern.pieces.forEach((piece, pi) => {
    const base = rest.length / 2;
    const boundary: P2[] = [];
    const local = new Map<string, number[]>();
    for (const e of piece.edges) {
      const n = counts.get(key(piece.id, e.id)) ?? Math.max(1, Math.round(polylineLength(e.pts) / spacing));
      const pts = resample(e.pts, n);
      const ids: number[] = [];
      pts.forEach((p, i) => {
        if (i === pts.length - 1) return; // shared with the next edge
        ids.push(boundary.length);
        boundary.push(p);
      });
      ids.push(-1); // placeholder for the end point (= start of next edge)
      local.set(e.id, ids);
    }
    // resolve end points (wrap around the loop)
    const order = piece.edges.map((e) => e.id);
    order.forEach((id, i) => {
      const ids = local.get(id)!;
      ids[ids.length - 1] = local.get(order[(i + 1) % order.length])![0];
      edgeVerts.set(key(piece.id, id), ids.map((v) => v + base));
    });

    // 2. Interior points on a hexagonal grid.
    const points: P2[] = boundary.slice();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of boundary) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const dy = spacing * Math.sqrt(3) / 2;
    for (let row = 0, y = minY + dy / 2; y < maxY; y += dy, row++)
      for (let x = minX + (row % 2 ? spacing / 2 : 0); x < maxX; x += spacing) {
        const p: P2 = [x, y];
        if (pointInPolygon(p, boundary) && distToPolygon(p, boundary) > spacing * 0.6) points.push(p);
      }

    // 3. Constrained Delaunay triangulation of the piece.
    const constraints = boundary.map((_, i) => [i, (i + 1) % boundary.length] as [number, number]);
    const cells = cdt2d(points, constraints, { exterior: false, delaunay: false });
    const np = points.length;
    delaunayFlips(points, cells, new Set(constraints.map(([a, b]) => (a < b ? a * np + b : b * np + a))));
    for (const [a, b, c] of cells) {
      const area = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[c][0] - points[a][0]) * (points[b][1] - points[a][1]);
      if (area > 0) tris.push(a + base, b + base, c + base);
      else tris.push(a + base, c + base, b + base);
    }
    for (const [x, y] of points) {
      rest.push(x / 100, y / 100);
      pieceOf.push(pi);
    }
  });

  // 4. Seam vertex pairs.
  const seams: number[] = [];
  for (const s of pattern.seams) {
    const a = edgeVerts.get(key(s.a.piece, s.a.edge))!;
    const b = edgeVerts.get(key(s.b.piece, s.b.edge))!;
    const va = s.a.reverse ? a.slice().reverse() : a;
    const vb = s.b.reverse ? b.slice().reverse() : b;
    for (let i = 0; i < va.length; i++) seams.push(va[i], vb[i]);
  }

  return {
    rest: new Float32Array(rest),
    triangles: new Uint32Array(tris),
    piece: Uint8Array.from(pieceOf),
    pieceIds: pattern.pieces.map((p) => p.id),
    seams: new Uint32Array(seams),
  };
}
