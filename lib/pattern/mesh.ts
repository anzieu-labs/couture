import Constrainautor from "@kninnug/constrainautor";
import Delaunator from "delaunator";
import { piecePointPosition } from "./clasp";
import { polylineLength, resample, type P2 } from "./curves";
import type { Pattern, PieceId } from "./types";

/**
 * Turns a pattern into a simulation mesh: every piece is sampled at ~`spacing`
 * cm (seam edges get the same count on both sides so they can be stitched
 * vertex to vertex), filled with a hexagonal point grid and triangulated with
 * a constrained Delaunay triangulation (Delaunator + Constrainautor). A clasp
 * (Pattern.clasps) is one more stitch, between the vertices nearest to its two ends.
 */

export interface GarmentMesh {
  /** Rest (flat) coordinates in meters, 2 per vertex — also the UVs. */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Piece index of each vertex. */
  piece: Uint8Array;
  pieceIds: PieceId[];
  /** Mesh vertices along each pattern edge, in loop order (both end points included). */
  edges: { piece: PieceId; edge: string; vertices: Uint32Array }[];
  /** Stitched vertex pairs: the seams, then the clasps. */
  seams: Uint32Array;
  /** The clasps' vertex pairs (the last ones of `seams`). */
  clasps: Uint32Array;
  /** Bands (Pattern.bands): the mesh edges along each, as vertex pairs, and its elasticity. */
  bands: { segments: Uint32Array; stretch: number }[];
}

function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const key = (piece: string, edge: string) => `${piece}/${edge}`;

/** Inside test and distance to the boundary, both answered from row / cell indices. */
class PolygonIndex {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly poly: P2[], private readonly cell: number) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
      const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const k = cx * 100003 + cy;
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }

  /** Sorted x where the horizontal line at y crosses the boundary (even-odd intervals). */
  crossings(y: number): number[] {
    const xs: number[] = [];
    const { poly } = this;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    return xs.sort((a, b) => a - b);
  }

  /** True when the boundary is closer than `cell` to p. */
  near(p: P2, radius: number): boolean {
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of this.cells.get((cx + dx) * 100003 + cy + dy) ?? [])
          if (distToSegment(p, this.poly[i], this.poly[(i + 1) % this.poly.length]) <= radius) return true;
    return false;
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
      const seamCount = counts.get(key(piece.id, e.id));
      const n = seamCount ?? Math.max(1, Math.round(polylineLength(e.pts) / spacing));
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
    const index = new PolygonIndex(boundary, spacing);
    const dy = (spacing * Math.sqrt(3)) / 2;
    for (let row = 0, y = minY + dy / 2; y < maxY; y += dy, row++) {
      const xs = index.crossings(y);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = minX + (row % 2 ? spacing / 2 : 0); x < xs[k + 1]; x += spacing) {
          const p: P2 = [x, y];
          if (x > xs[k] && !index.near(p, spacing * 0.6)) points.push(p);
        }
    }

    // 3. Constrained Delaunay triangulation; drop the triangles outside the piece.
    // A frame of 4 far points around the piece keeps every boundary edge off the convex
    // hull: with nearly collinear boundary points (resampled straight edges), a constraint
    // lying on the hull can make Constrainautor fail ("Constraining edge exited the hull").
    // Triangles touching the frame are outside the piece and dropped below.
    const pad = Math.max(maxX - minX, maxY - minY);
    const frame: P2[] = [[minX - pad, minY - pad], [maxX + pad, minY - pad], [maxX + pad, maxY + pad], [minX - pad, maxY + pad]];
    const coords = new Float64Array((points.length + frame.length) * 2);
    [...points, ...frame].forEach((p, i) => coords.set(p, 2 * i));
    const del = new Delaunator(coords);
    new Constrainautor(del, boundary.map((_, i) => [i, (i + 1) % boundary.length] as [number, number]));
    const t = del.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
      if (a >= points.length || b >= points.length || c >= points.length) continue; // frame
      const area = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[c][0] - points[a][0]) * (points[b][1] - points[a][1]);
      if (Math.abs(area) < 1e-6 * spacing * spacing) continue; // flat triangle along a straight boundary
      const cx = (points[a][0] + points[b][0] + points[c][0]) / 3, cy = (points[a][1] + points[b][1] + points[c][1]) / 3;
      const xs = index.crossings(cy);
      let inside = false;
      for (const x of xs) if (x < cx) inside = !inside;
      if (!inside) continue;
      // Store triangles counter-clockwise (Delaunator's orientation depends on the axes).
      if (area > 0) tris.push(a + base, b + base, c + base);
      else tris.push(a + base, c + base, b + base);
    }
    for (const p of points) {
      rest.push(p[0] / 100, p[1] / 100);
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

  // 5. Clasps: one more stitch each, between the mesh vertices nearest to their ends (a corner
  // of a piece is a vertex; elsewhere the end is off by half the mesh spacing at most).
  const clasps: number[] = [];
  for (const clasp of pattern.clasps ?? []) {
    const ends = [clasp.a, clasp.b].map((end) => {
      const at = piecePointPosition(pattern, end);
      const piece = pattern.pieces.findIndex((p) => p.id === end.piece);
      let best = -1, bestD = Infinity;
      if (at)
        for (let v = 0; v < pieceOf.length; v++) {
          if (pieceOf[v] !== piece) continue;
          const d = Math.hypot(rest[2 * v] * 100 - at[0], rest[2 * v + 1] * 100 - at[1]);
          if (d < bestD) [bestD, best] = [d, v];
        }
      return best;
    });
    if (ends[0] >= 0 && ends[1] >= 0 && ends[0] !== ends[1]) clasps.push(ends[0], ends[1]);
  }

  // 6. Bands: the boundary edges along their pattern edges.
  const bands = (pattern.bands ?? []).map((band) => {
    const pairs: number[] = [];
    for (const { piece, edge } of band.edges) {
      const verts = edgeVerts.get(key(piece, edge)) ?? [];
      for (let i = 1; i < verts.length; i++) pairs.push(verts[i - 1], verts[i]);
    }
    return { segments: Uint32Array.from(pairs), stretch: band.stretch };
  });

  return {
    rest: new Float32Array(rest),
    triangles: new Uint32Array(tris),
    piece: Uint8Array.from(pieceOf),
    pieceIds: pattern.pieces.map((p) => p.id),
    edges: pattern.pieces.flatMap((p) => p.edges.map((e) => ({ piece: p.id, edge: e.id, vertices: Uint32Array.from(edgeVerts.get(key(p.id, e.id))!) }))),
    seams: new Uint32Array([...seams, ...clasps]),
    clasps: new Uint32Array(clasps),
    bands,
  };
}
