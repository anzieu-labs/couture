import { polylineLength, type P2 } from "./curves";
import type { Edge, EdgeAllowance, Pattern, Piece } from "./tshirt";

/**
 * Turns the net pattern (stitching lines, as simulated) into cutting pieces:
 * seam allowances outside every edge, match notches cut into the allowance,
 * grain line, fold line, name and cutting notes. All in cm, piece coordinates
 * (y up), loops counter-clockwise (outside = right of the direction of travel).
 */

export interface Allowances {
  /** Seams and neckline (cm). */
  seam: number;
  /** Hems: body and sleeves (cm). */
  hem: number;
}

export const DEFAULT_ALLOWANCES: Allowances = { seam: 1, hem: 2.5 };

/** Depth of a notch cut into the allowance, and spacing of a double notch (cm). */
const NOTCH_DEPTH = 0.5;
const NOTCH_GAP = 0.5;
/** Beyond this many allowances, a sharp corner is bevelled instead of mitred. */
const MITER_LIMIT = 4;

export interface CutPiece {
  id: string;
  name: string;
  quantity: number;
  onFold: boolean;
  /** Stitching line per edge (for colouring) — loop order. */
  seamEdges: { id: string; pts: P2[] }[];
  /** Stitching line, closed loop. */
  seamLine: P2[];
  /** Cutting line, closed loop. */
  cutLine: P2[];
  /** Indices of the corners (turn points) in `cutLine`; the rest are curve points. */
  turns: number[];
  /** Notch ticks, from the cutting line into the allowance. */
  notches: [P2, P2][];
  grain: [P2, P2];
  /** Fold line (centre front / back) when cut on the fold, over the cut line's whole height. */
  fold: [P2, P2] | null;
  /** Index in `cutLine` of the segment lying on the fold (not to be cut), or -1. */
  foldSegment: number;
  label: P2;
  /** Cutting notes, under the name. */
  notes: string[];
}

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2, s = 1): P2 => [a[0] + s * b[0], a[1] + s * b[1]];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const unit = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
/** Outward normal of a segment of a counter-clockwise loop. */
const outward = (a: P2, b: P2): P2 => unit([b[1] - a[1], a[0] - b[0]]);
const near = (a: P2, b: P2, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

/** Intersection of the lines (p, p + r) and (q, q + s); null when parallel. */
function intersect(p: P2, r: P2, q: P2, s: P2): P2 | null {
  const d = cross(r, s);
  if (Math.abs(d) < 1e-9 * Math.hypot(...r) * Math.hypot(...s)) return null;
  return add(p, r, cross(sub(q, p), s) / d);
}

/** Mirror of point p about the line (o, o + u). */
function reflect(p: P2, o: P2, u: P2): P2 {
  const n = unit(u);
  const v = sub(p, o);
  const along = dot(v, n);
  return [o[0] + 2 * along * n[0] - v[0], o[1] + 2 * along * n[1] - v[1]];
}

/** Polyline offset by d to the outside (mitred joints between its own segments). */
function offsetPolyline(pts: P2[], d: number): P2[] {
  if (d === 0) return pts.map((p) => [p[0], p[1]] as P2);
  return pts.map((p, i) => {
    const nPrev = i > 0 ? outward(pts[i - 1], p) : null;
    const nNext = i < pts.length - 1 ? outward(p, pts[i + 1]) : null;
    if (!nPrev || !nNext) return add(p, (nPrev ?? nNext)!, d);
    const m = unit(add(nPrev, nNext));
    const c = Math.max(dot(m, nPrev), 1 / MITER_LIMIT);
    return add(p, m, d / c);
  });
}

/** Point, unit tangent at an arc-length fraction t of a polyline. */
function pointAt(pts: P2[], t: number): { p: P2; tangent: P2 } {
  const target = Math.min(Math.max(t, 0), 1) * polylineLength(pts);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (run + l >= target || i === pts.length - 1) {
      const f = l > 0 ? Math.min(1, (target - run) / l) : 0;
      return { p: add(pts[i - 1], sub(pts[i], pts[i - 1]), f), tangent: unit(sub(pts[i], pts[i - 1])) };
    }
    run += l;
  }
  return { p: pts[0], tangent: [1, 0] };
}

interface OffsetEdge {
  edge: Edge;
  d: number;
  pts: P2[];
}

/**
 * Joins the offset edges into the cutting line. Ordinary corners are mitred (the two
 * offset lines extended until they meet). At a hem corner the seam allowance is mirrored
 * about the hem line: once the hem is folded up, its edges lie exactly on the seam
 * allowance of the piece above (otherwise a tapered seam gives a hem too narrow).
 */
function joinCorners(edges: OffsetEdge[]): { cut: P2[]; turns: number[] } {
  const n = edges.length;
  // Per edge: possibly replaced first / last points, plus points inserted after the edge.
  const starts: (P2 | null)[] = new Array(n).fill(null);
  const ends: (P2 | null)[] = new Array(n).fill(null);
  const extra: P2[][] = edges.map(() => []);

  for (let i = 0; i < n; i++) {
    const A = edges[i], B = edges[(i + 1) % n];
    const V = A.edge.pts[A.edge.pts.length - 1];
    const a0 = A.pts[A.pts.length - 2], a1 = A.pts[A.pts.length - 1];
    const b0 = B.pts[0], b1 = B.pts[1];
    const ra = sub(a1, a0), rb = sub(b1, b0);
    if (A.d === 0 && B.d === 0) continue;

    const hemA = A.edge.allowance === "hem", hemB = B.edge.allowance === "hem";
    if (hemA !== hemB) {
      // Mirrored hem corner. L = hem (stitching) line through V; S = seam allowance line.
      const hem = hemA ? A : B, seam = hemA ? B : A;
      const hemDir = hemA ? sub(V, A.edge.pts[A.edge.pts.length - 2]) : sub(B.edge.pts[1], V);
      const sOff = hemA ? b0 : a1;
      const sDir = hemA ? rb : ra;
      const hOff = hemA ? a1 : b0;
      const Q = intersect(sOff, sDir, V, hemDir); // seam allowance meets the fold of the hem
      const mirrored = Q && reflect(add(Q, sDir), V, hemDir); // seam allowance line, mirrored
      const R = Q && mirrored && intersect(Q, sub(mirrored, Q), hOff, hemDir); // ... meets the hem's cut edge
      if (Q && R && Math.hypot(...sub(Q, V)) < MITER_LIMIT * Math.max(hem.d, seam.d) + 1) {
        if (hemA) {
          ends[i] = R;
          extra[i].push(Q);
          starts[(i + 1) % n] = Q;
        } else {
          ends[i] = Q;
          extra[i].push(R);
          starts[(i + 1) % n] = R;
        }
        continue;
      }
    }

    const X = intersect(a0, ra, b0, rb);
    if (!X) {
      if (!near(a1, b0)) extra[i].push(b0); // parallel, different offsets: step
      continue;
    }
    if (Math.hypot(...sub(X, V)) > MITER_LIMIT * Math.max(A.d, B.d)) continue; // bevel: keep both ends
    ends[i] = X;
    starts[(i + 1) % n] = X;
  }

  const cut: P2[] = [];
  const turns: number[] = [];
  const push = (p: P2, turn: boolean) => {
    if (cut.length && near(cut[cut.length - 1], p, 1e-4)) {
      if (turn && turns[turns.length - 1] !== cut.length - 1) turns.push(cut.length - 1);
      return;
    }
    if (turn) turns.push(cut.length);
    cut.push(p);
  };
  // A junction is a corner unless the stitching line goes on smoothly there (centre front /
  // back between mirrored halves, top of the sleeve cap): under ~10° it is curve sampling.
  const smooth = edges.map((A, i) => {
    const B = edges[(i + 1) % n].edge.pts, a = A.edge.pts;
    const u = unit(sub(a[a.length - 1], a[a.length - 2])), v = unit(sub(B[1], B[0]));
    return Math.abs(cross(u, v)) < 0.17 && dot(u, v) > 0;
  });
  edges.forEach((e, i) => {
    const pts = e.pts.slice();
    if (starts[i]) pts[0] = starts[i]!;
    if (ends[i]) pts[pts.length - 1] = ends[i]!;
    pts.forEach((p, k) => {
      push(p, (k === 0 && !smooth[(i - 1 + n) % n]) || (k === pts.length - 1 && !smooth[i]));
    });
    for (const p of extra[i]) push(p, true);
  });
  if (cut.length > 1 && near(cut[0], cut[cut.length - 1], 1e-4)) {
    cut.pop();
    if (turns[turns.length - 1] === cut.length) turns.pop();
  }
  const untangled = removeLoops(cut, turns);
  cut.splice(0, cut.length, ...untangled.cut);
  turns.splice(0, turns.length, ...untangled.turns);
  return { cut, turns: [...new Set(turns)] };
}

/** Proper crossing point of the segments ab and cd, if any. */
function segmentsCross(a: P2, b: P2, c: P2, d: P2): P2 | null {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? add(a, r, t) : null;
}

/**
 * Cuts the small loops out of a closed outline. Offsetting a concave curve whose
 * radius is smaller than the allowance (back neckline near the shoulder) makes the
 * offset cross itself: the shorter side of each crossing is dropped, the crossing
 * point becomes a corner.
 */
function removeLoops(cut: P2[], turns: number[]): { cut: P2[]; turns: number[] } {
  let pts = cut.map((p, i) => ({ p, turn: turns.includes(i) }));
  for (let guard = 0; guard < 50; guard++) {
    const n = pts.length;
    let found = false;
    for (let i = 0; i < n && !found; i++)
      for (let j = i + 2; j < n && !found; j++) {
        if (i === 0 && j === n - 1) continue; // adjacent through the wrap
        const X = segmentsCross(pts[i].p, pts[i + 1].p, pts[j].p, pts[(j + 1) % n].p);
        if (!X) continue;
        found = true;
        const corner = { p: X, turn: true };
        // Points i+1..j form one side of the crossing, the rest the other: keep the longer.
        pts = j - i <= n / 2 ? [...pts.slice(0, i + 1), corner, ...pts.slice(j + 1)] : [corner, ...pts.slice(i + 1, j + 1)];
      }
    if (!found) break;
  }
  return { cut: pts.map((q) => q.p), turns: pts.flatMap((q, i) => (q.turn ? [i] : [])) };
}

/** Half of a symmetric piece (the "+" edges, x ≥ 0), closed by its centre line as a fold. */
function halfPiece(piece: Piece): Piece {
  const kept = piece.edges.filter((e) => e.id.endsWith("+"));
  const top = kept[kept.length - 1].pts[kept[kept.length - 1].pts.length - 1];
  const bottom = kept[0].pts[0];
  const ids = new Set(kept.map((e) => e.id));
  const xMax = Math.max(...kept.flatMap((e) => e.pts.map((p) => p[0])));
  return {
    ...piece,
    edges: [...kept, { id: "fold", pts: [top, bottom], allowance: "none" }],
    notches: piece.notches.filter((n) => ids.has(n.edge)),
    // Fold on the left (centre), grain line towards the side seam, label in between.
    grain: [[0.78 * xMax, piece.grain[0][1]], [0.78 * xMax, piece.grain[1][1]]],
    label: [0.4 * xMax, piece.label[1]],
  };
}

const allowanceOf = (a: EdgeAllowance, al: Allowances) => (a === "seam" ? al.seam : a === "hem" ? al.hem : 0);

const fmt = (cm: number) => `${cm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} cm`;

export function allowanceNote(al: Allowances): string {
  if (al.seam === 0 && al.hem === 0) return "Sans marges de couture";
  return `Marges ${fmt(al.seam)} · ourlets ${fmt(al.hem)} incluses`;
}

/**
 * Cutting pieces of a pattern. The duplicate sleeve is dropped (quantity 2); with
 * `fold`, the symmetric body pieces are halved and cut on the fold.
 */
export function cutPieces(pattern: Pattern, al: Allowances, opts: { fold: boolean }): CutPiece[] {
  const seen = new Set<string>();
  const out: CutPiece[] = [];
  for (const original of pattern.pieces) {
    if (seen.has(original.name)) continue;
    seen.add(original.name);
    const onFold = opts.fold && original.symmetric && original.quantity === 1;
    const piece = onFold ? halfPiece(original) : original;

    const offs: OffsetEdge[] = piece.edges.map((edge) => {
      const d = allowanceOf(edge.allowance, al);
      return { edge, d, pts: offsetPolyline(edge.pts, d) };
    });
    const { cut, turns } = joinCorners(offs);
    const seamLine = piece.edges.flatMap((e, i) => (i === 0 ? e.pts : e.pts.slice(1)));
    seamLine.pop(); // closing point = first point

    const notches: [P2, P2][] = [];
    for (const nt of piece.notches) {
      const edge = piece.edges.find((e) => e.id === nt.edge)!;
      const d = allowanceOf(edge.allowance, al);
      const length = polylineLength(edge.pts);
      const ts = nt.count === 1 ? [nt.t] : [nt.t - NOTCH_GAP / 2 / length, nt.t + NOTCH_GAP / 2 / length];
      for (const t of ts) {
        const { p, tangent } = pointAt(edge.pts, t);
        const out: P2 = [tangent[1], -tangent[0]];
        const c = add(p, out, d);
        notches.push([c, add(c, out, -NOTCH_DEPTH)]);
      }
    }

    // On the fold, the centre line (allowance 0) is part of the cut loop: find that segment.
    let fold: [P2, P2] | null = null, foldSegment = -1;
    if (onFold) {
      const onCentre = (q: P2) => Math.abs(q[0]) < 1e-6;
      foldSegment = cut.findIndex((q, i) => onCentre(q) && onCentre(cut[(i + 1) % cut.length]));
      if (foldSegment >= 0) fold = [cut[foldSegment], cut[(foldSegment + 1) % cut.length]];
    }
    const cutNote = `Couper ×${piece.quantity}${onFold ? " au pli" : ""}`;
    out.push({
      id: piece.id,
      name: piece.name,
      quantity: piece.quantity,
      onFold,
      seamEdges: piece.edges.filter((e) => e.allowance !== "none").map((e) => ({ id: e.id, pts: e.pts })),
      seamLine,
      cutLine: cut,
      turns,
      notches,
      grain: piece.grain,
      fold,
      foldSegment,
      label: piece.label,
      notes: [pattern.name, cutNote, allowanceNote(al)],
    });
  }
  return out;
}

/** Bounding box of a cut piece (cut line and notches). */
export function pieceBounds(p: CutPiece): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = [...p.cutLine, ...p.seamLine];
  return {
    minX: Math.min(...pts.map((q) => q[0])), maxX: Math.max(...pts.map((q) => q[0])),
    minY: Math.min(...pts.map((q) => q[1])), maxY: Math.max(...pts.map((q) => q[1])),
  };
}
