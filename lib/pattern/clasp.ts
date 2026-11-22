import type { P2 } from "./curves";
import type { Clasp, Pattern, Piece, PieceId, PiecePoint } from "./types";

/**
 * Clasps (types.ts Clasp): where their ends are on the pieces. An end is told from the
 * outline (PiecePoint) so that it follows the pattern's edits; these turn a position of a
 * piece into such a point and back, and find the same point on a piece's twin (the other of
 * a pair cut twice: the second front of a cape, the second sleeve).
 */

/** Point and unit direction of travel at the fraction `t` of a polyline's length. */
function frameAt(pts: P2[], t: number): { p: P2; tangent: P2 } {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    lengths.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    total += lengths[i - 1];
  }
  let target = Math.min(1, Math.max(0, t)) * total, i = 0;
  // The segment the fraction falls in (zero-length ones skipped; the last one for t = 1).
  while (i < lengths.length - 1 && (target > lengths[i] || lengths[i] === 0)) target -= lengths[i++];
  const l = lengths[i] || 1, u = Math.min(1, target / l);
  const a = pts[i], b = pts[i + 1];
  return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], tangent: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
}

/**
 * Position (piece coordinates, cm) of a piece point; null when its piece or its edge is not
 * in the pattern (any more).
 */
export function piecePointPosition(pattern: Pattern, point: PiecePoint): P2 | null {
  const edge = pattern.pieces.find((p) => p.id === point.piece)?.edges.find((e) => e.id === point.edge);
  if (!edge || edge.pts.length < 2) return null;
  const { p, tangent } = frameAt(edge.pts, point.t);
  // Loops are counter-clockwise: the inside is on the left of the direction of travel.
  return [p[0] + point.offset[0] * tangent[0] - point.offset[1] * tangent[1], p[1] + point.offset[0] * tangent[1] + point.offset[1] * tangent[0]];
}

/** Closest point of a piece's outline to `pos`: its edge, the fraction of the edge's length, the distance. */
function closestOnOutline(piece: Piece, pos: P2): { edge: string; t: number; distance: number } {
  let best = { edge: piece.edges[0].id, t: 0, distance: Infinity };
  for (const e of piece.edges) {
    let total = 0;
    for (let i = 1; i < e.pts.length; i++) total += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    let before = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const u = l2 ? Math.min(1, Math.max(0, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy) / l2)) : 0;
      const distance = Math.hypot(pos[0] - a[0] - u * dx, pos[1] - a[1] - u * dy);
      const l = Math.sqrt(l2);
      if (distance < best.distance) best = { edge: e.id, t: total ? (before + u * l) / total : 0, distance };
      before += l;
    }
  }
  return best;
}

/** Whether a position lies inside a piece's outline. */
export function insidePiece(piece: Piece, pos: P2): boolean {
  let inside = false;
  for (const e of piece.edges)
    for (let i = 1; i < e.pts.length; i++) {
      const [xi, yi] = e.pts[i - 1], [xj, yj] = e.pts[i];
      if (yi > pos[1] !== yj > pos[1] && pos[0] < ((xj - xi) * (pos[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/** Distance from a position to a piece: 0 inside, else to its outline (cm). */
export const distanceToPiece = (piece: Piece, pos: P2) => (insidePiece(piece, pos) ? 0 : closestOnOutline(piece, pos).distance);

/**
 * The piece point at a position of a piece (piece coordinates, cm). Within `snap` of the
 * outline it is put on the outline, and within `snap` of an end of the edge, on that corner.
 */
export function piecePointAt(piece: Piece, pos: P2, snap = 0): PiecePoint {
  const near = closestOnOutline(piece, pos);
  const edge = piece.edges.find((e) => e.id === near.edge)!;
  let t = near.t;
  if (near.distance <= snap)
    for (const end of [0, 1]) {
      const c = edge.pts[end ? edge.pts.length - 1 : 0];
      if (Math.hypot(pos[0] - c[0], pos[1] - c[1]) <= snap) t = end;
    }
  const { p, tangent } = frameAt(edge.pts, t);
  if (near.distance <= snap) return { piece: piece.id, edge: edge.id, t, offset: [0, 0] };
  const rx = pos[0] - p[0], ry = pos[1] - p[1];
  return { piece: piece.id, edge: edge.id, t, offset: [rx * tangent[0] + ry * tangent[1], -rx * tangent[1] + ry * tangent[0]] };
}

/** The other piece of a pair cut twice (same name, another id), if any. */
export function twinPiece(pattern: Pattern, piece: PieceId): Piece | null {
  const name = pattern.pieces.find((p) => p.id === piece)?.name;
  return pattern.pieces.find((p) => p.name === name && p.id !== piece) ?? null;
}

/**
 * The same point on the piece's twin. A twin is either the same outline again (a t-shirt's
 * sleeves) or its mirror image (a cape's fronts), whose edges then run the other way.
 */
export function twinPoint(pattern: Pattern, point: PiecePoint): PiecePoint | null {
  const twin = twinPiece(pattern, point.piece);
  const own = pattern.pieces.find((p) => p.id === point.piece)?.edges.find((e) => e.id === point.edge);
  const other = twin?.edges.find((e) => e.id === point.edge);
  if (!twin || !own || !other) return null;
  const a = own.pts[0], b = other.pts[0];
  const same = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  return same ? { ...point, piece: twin.id } : { piece: twin.id, edge: point.edge, t: 1 - point.t, offset: [-point.offset[0], point.offset[1]] };
}

/** The clasps whose two ends are still on the pattern, and not on the same spot. */
export function validClasps(pattern: Pattern, clasps: readonly Clasp[]): Clasp[] {
  return clasps.filter((c) => {
    const a = piecePointPosition(pattern, c.a), b = piecePointPosition(pattern, c.b);
    return !!a && !!b && !(c.a.piece === c.b.piece && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.2);
  });
}
