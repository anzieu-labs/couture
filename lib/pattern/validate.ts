import { polylineLength, type P2 } from "./curves";
import type { Pattern, Piece } from "./types";

/**
 * Checks that an (edited) pattern can still be meshed and sewn: every piece outline
 * must be a simple polygon (no crossing, no fold-over through the centre line) and no
 * edge may collapse. Returns readable problems; empty when the pattern is usable.
 */

const cross = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function outline(piece: Piece): P2[] {
  const pts = piece.edges.flatMap((e, i) => (i === 0 ? e.pts : e.pts.slice(1)));
  pts.pop(); // closing point
  return pts;
}

function selfCrosses(pts: P2[]): boolean {
  const n = pts.length;
  // Bounding boxes first: most pairs are far apart.
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ax0 = Math.min(a[0], b[0]), ax1 = Math.max(a[0], b[0]), ay0 = Math.min(a[1], b[1]), ay1 = Math.max(a[1], b[1]);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      if (Math.max(c[0], d[0]) < ax0 || Math.min(c[0], d[0]) > ax1 || Math.max(c[1], d[1]) < ay0 || Math.min(c[1], d[1]) > ay1) continue;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Signed area (> 0 counter-clockwise). */
function area(pts: P2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - a[1] * b[0];
  }
  return s / 2;
}

export interface PatternIssue {
  /** Piece name ("Devant", "Dos", "Manche"). */
  piece: string;
  message: string;
}

export function patternIssues(pattern: Pattern): PatternIssue[] {
  const issues: PatternIssue[] = [];
  const seen = new Set<string>();
  for (const piece of pattern.pieces) {
    if (seen.has(piece.name)) continue;
    seen.add(piece.name);
    const pts = outline(piece);
    const add = (message: string) => issues.push({ piece: piece.name, message: `${piece.name} : ${message}` });
    if (selfCrosses(pts)) add("le contour se recoupe.");
    else if (area(pts) <= 0) add("le contour est retourné.");
    if (piece.edges.some((e) => e.allowance !== "none" && polylineLength(e.pts) < 0.5)) add("un bord est réduit à moins de 5 mm.");
  }
  return issues;
}
