import { polylineLength, resample, type P2 } from "./curves";
import { PointSet, type BodyMeasures, type Edge, type Pattern, type PatternEdits, type Piece, type Seam, type Zone } from "./types";

/**
 * A pattern the user draws: pieces made of points, joined by edges that are straight or bent,
 * sewn edge to edge. Nothing of it is worked out from the body — a draft (t-shirt, skirt…) is;
 * what the body gives is where each piece is put on before sewing, its zone: the pieces of
 * the front and of the back are wrapped round the trunk, those of an arm round that arm, each
 * where its own coordinates say (x across, from the middle of the body or the top of the arm;
 * y up, from the shoulder line) — a piece is drawn where it is worn.
 *
 * Kept as it is drawn (FreePattern) and turned into a Pattern for everything else: the editor
 * drags its points as it does a draft's (their moves are edits, taken in once done: bakeFree),
 * the mesh, the simulation and the exports know no difference.
 */

export const ZONES: Record<Zone, string> = { front: "Devant", back: "Dos", armL: "Bras gauche", armR: "Bras droit" };

/**
 * How an edge goes from its first point to its second: through `mid` half-way (a parabola), or
 * along `shape` — a curve copied from a draft, told in the edge's own frame (along it from 0
 * to 1, and across it, in lengths of the edge) so that it follows its two points. Straight
 * when left out.
 */
export type FreeCurve = { mid: P2 } | { shape: P2[] };

export interface FreeEdge {
  id: string;
  curve?: FreeCurve;
}

export interface FreePiece {
  id: string;
  name: string;
  zone: Zone;
  /** Corners, counter-clockwise; edge i goes from point i to the next. */
  points: P2[];
  edges: FreeEdge[];
}

export interface FreeSeam {
  a: { piece: string; edge: string };
  b: { piece: string; edge: string };
  /** The second edge is sewn against its direction round its piece. */
  reverse: boolean;
}

export interface FreePattern {
  pieces: FreePiece[];
  seams: FreeSeam[];
  /** Next number for the id of a new piece or edge. */
  next: number;
}

const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const SAMPLES = 16;

/** The points of an edge from a to b. */
export function edgePoints(a: P2, b: P2, curve?: FreeCurve): P2[] {
  if (!curve) return [a, b];
  if ("mid" in curve) {
    // The parabola through a, mid (at half-way) and b: a quadratic Bézier, its control point 2·mid − (a + b) / 2.
    const c: P2 = [2 * curve.mid[0] - (a[0] + b[0]) / 2, 2 * curve.mid[1] - (a[1] + b[1]) / 2];
    return Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const t = i / SAMPLES, u = 1 - t;
      return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]] as P2;
    });
  }
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return curve.shape.map(([u, v]) => [a[0] + u * dx - v * dy, a[1] + u * dy + v * dx] as P2);
}

/** A polyline told in the frame of the edge from its first point to its last (FreeCurve shape); none when it is straight. */
export function shapeOf(pts: P2[]): FreeCurve | undefined {
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (pts.length < 3 || !l2) return undefined;
  const shape = pts.map(([x, y]) => [((x - a[0]) * dx + (y - a[1]) * dy) / l2, ((y - a[1]) * dx - (x - a[0]) * dy) / l2] as P2);
  // Straight, to within a thousandth of its length: no curve to keep.
  return shape.some(([, v]) => Math.abs(v) > 1e-3) ? { shape } : undefined;
}

/** The point half-way along a polyline. */
const halfWay = (pts: P2[]): P2 => resample(pts, 2)[1];

const pointKey = (i: number) => `p${i}`;
const curveKey = (edge: string) => `c:${edge}`;

/** The points of a piece and of its edges' bends with the edits of a drag under way; the handles the editor draws. */
function resolve(piece: FreePiece, edits: PatternEdits) {
  const set = new PointSet(piece.id, piece.id, edits);
  const n = piece.points.length;
  const points = piece.points.map((p, i) => set.anchor(pointKey(i), "Point", p));
  const curves = piece.edges.map((edge, i): FreeCurve | undefined => {
    const a0 = piece.points[i], b0 = piece.points[(i + 1) % n], a = points[i], b = points[(i + 1) % n];
    const base = halfWay(edgePoints(a0, b0, edge.curve));
    const at = set.control(curveKey(edge.id), "Courbe du bord", base, mid(a0, b0), mid(a, b));
    // A copied curve keeps its shape until its handle is pulled; then it goes through the handle.
    if (!edge.curve) return edits[`${piece.id}.${curveKey(edge.id)}`] ? { mid: at } : undefined;
    return "shape" in edge.curve && !edits[`${piece.id}.${curveKey(edge.id)}`] ? edge.curve : { mid: at };
  });
  return { points, curves, handles: set.handles };
}

/** The pattern as drawn, with the points moved by `edits` taken in. */
export function bakeFree(free: FreePattern, edits: PatternEdits): FreePattern {
  if (!Object.keys(edits).length) return free;
  return {
    ...free,
    pieces: free.pieces.map((piece) => {
      const { points, curves } = resolve(piece, edits);
      return { ...piece, points, edges: piece.edges.map((e, i) => ({ id: e.id, ...(curves[i] && { curve: curves[i] }) })) };
    }),
  };
}

/** The seams that still join two edges of the pattern. */
function liveSeams(free: FreePattern): FreeSeam[] {
  const has = (s: { piece: string; edge: string }) => free.pieces.find((p) => p.id === s.piece)?.edges.some((e) => e.id === s.edge);
  return free.seams.filter((s) => has(s.a) && has(s.b) && !(s.a.piece === s.b.piece && s.a.edge === s.b.edge));
}

/** A seam's id on the pattern: named after its first edge (shoulder, side…: the colours of a draft's seams), numbered. */
const seamId = (s: FreeSeam, k: number) => `${s.a.edge.replace(/[+-]$/, "")}·${k + 1}`;

/** The Pattern of a drawn pattern (see the header). */
export function draftFree(free: FreePattern, edits: PatternEdits, name = "Patron libre"): Pattern {
  const seams = liveSeams(free);
  const sewn = new Set(seams.flatMap((s) => [`${s.a.piece}/${s.a.edge}`, `${s.b.piece}/${s.b.edge}`]));
  const handles: Pattern["handles"] = [];
  const pieces = free.pieces.map((piece): Piece => {
    const { points, curves, handles: own } = resolve(piece, edits);
    handles.push(...own);
    const n = points.length;
    const edges: Edge[] = piece.edges.map((e, i) => ({
      id: e.id,
      pts: edgePoints(points[i], points[(i + 1) % n], curves[i]),
      allowance: sewn.has(`${piece.id}/${e.id}`) ? "seam" : "hem",
    }));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of edges)
      for (const [x, y] of e.pts) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    const cx = (x0 + x1) / 2, pad = Math.min(4, (y1 - y0) / 4);
    return { id: piece.id, name: piece.name, edges, grain: [[cx, y1 - pad], [cx, y0 + pad]], notches: [], quantity: 1, symmetric: false, label: [cx, (y0 + y1) / 2], zone: piece.zone };
  });
  const nameOf = (id: string) => free.pieces.find((p) => p.id === id)?.name ?? "?";
  return {
    kind: "tshirt",
    name,
    pieces,
    seams: seams.map((s, k): Seam => ({ id: seamId(s, k), a: { ...s.a, reverse: false }, b: { ...s.b, reverse: s.reverse } })),
    handles,
    dims: pieces.slice(0, 6).map((p) => ({ label: `${p.name} · contour`, value: polylineLength(p.edges.flatMap((e) => e.pts)) })),
    sizeNote: `${pieces.length} pièce${pieces.length > 1 ? "s" : ""}, ${seams.length} couture${seams.length > 1 ? "s" : ""}`,
    checks: seams.map((s, k) => ({ seam: seamId(s, k), label: `${nameOf(s.a.piece)} ↔ ${nameOf(s.b.piece)}`, kind: "match" as const })),
  };
}

// --- Changes to the drawing ---------------------------------------------------------------

const withPiece = (free: FreePattern, id: string, change: (p: FreePiece) => FreePiece): FreePattern => ({
  ...free,
  pieces: free.pieces.map((p) => (p.id === id ? change(p) : p)),
});

/** A point more on an edge, at the place of the edge nearest to `at`: the edge becomes two. */
export function insertPoint(free: FreePattern, pieceId: string, edgeId: string, at: P2): FreePattern {
  const id = `e${free.next}`;
  const next = withPiece(free, pieceId, (piece) => {
    const i = piece.edges.findIndex((e) => e.id === edgeId), n = piece.points.length;
    if (i < 0) return piece;
    const a = piece.points[i], b = piece.points[(i + 1) % n];
    const pts = resample(edgePoints(a, b, piece.edges[i].curve), 64);
    let k = 1;
    for (let j = 1; j < pts.length - 1; j++) if (Math.hypot(pts[j][0] - at[0], pts[j][1] - at[1]) < Math.hypot(pts[k][0] - at[0], pts[k][1] - at[1])) k = j;
    // Each half keeps the bend of its part of the edge.
    const bent = (part: P2[]): FreeCurve | undefined => (piece.edges[i].curve ? { mid: halfWay(part) } : undefined);
    const first = bent(pts.slice(0, k + 1)), second = bent(pts.slice(k));
    const points = [...piece.points.slice(0, i + 1), pts[k], ...piece.points.slice(i + 1)];
    const edges = [...piece.edges.slice(0, i), { id: edgeId, ...(first && { curve: first }) }, { id, ...(second && { curve: second }) }, ...piece.edges.slice(i + 1)];
    return { ...piece, points, edges };
  });
  return { ...next, next: free.next + 1 };
}

/** A point less: its two edges become one, straight (a piece keeps three points at least). */
export function removePoint(free: FreePattern, pieceId: string, index: number): FreePattern {
  const piece = free.pieces.find((p) => p.id === pieceId);
  if (!piece || piece.points.length <= 3 || index < 0 || index >= piece.points.length) return free;
  const n = piece.points.length, before = (index + n - 1) % n;
  const gone = piece.edges[index].id;
  const next = withPiece(free, pieceId, (p) => ({
    ...p,
    points: p.points.filter((_, i) => i !== index),
    edges: p.edges.map((e, i) => (i === before ? { id: e.id } : e)).filter((_, i) => i !== index),
  }));
  return { ...next, seams: next.seams.filter((s) => !(s.a.piece === pieceId && s.a.edge === gone) && !(s.b.piece === pieceId && s.b.edge === gone)) };
}

/** An edge made straight again. */
export const straighten = (free: FreePattern, pieceId: string, edgeId: string): FreePattern =>
  withPiece(free, pieceId, (p) => ({ ...p, edges: p.edges.map((e) => (e.id === edgeId ? { id: e.id } : e)) }));

/** Two edges sewn together (each edge is sewn once: their other seams go). The second one against its direction when the two run opposite ways on the sheet — the two sides of a sleeve. */
export function addSeam(free: FreePattern, a: FreeSeam["a"], b: FreeSeam["b"]): FreePattern {
  if (a.piece === b.piece && a.edge === b.edge) return free;
  const direction = (s: { piece: string; edge: string }): P2 => {
    const piece = free.pieces.find((p) => p.id === s.piece)!, i = piece.edges.findIndex((e) => e.id === s.edge), n = piece.points.length;
    return [piece.points[(i + 1) % n][0] - piece.points[i][0], piece.points[(i + 1) % n][1] - piece.points[i][1]];
  };
  const da = direction(a), db = direction(b);
  const same = (s: FreeSeam["a"], t: FreeSeam["a"]) => s.piece === t.piece && s.edge === t.edge;
  const kept = free.seams.filter((s) => ![s.a, s.b].some((side) => same(side, a) || same(side, b)));
  return { ...free, seams: [...kept, { a, b, reverse: da[0] * db[0] + da[1] * db[1] < 0 }] };
}

export const flipSeam = (free: FreePattern, seam: FreeSeam): FreePattern => ({ ...free, seams: free.seams.map((s) => (s === seam ? { ...s, reverse: !s.reverse } : s)) });
export const removeSeam = (free: FreePattern, seam: FreeSeam): FreePattern => ({ ...free, seams: free.seams.filter((s) => s !== seam) });

/** The seams of the pattern as its Pattern numbers them (draftFree), for the editor's list. */
export const freeSeams = (free: FreePattern) => liveSeams(free).map((seam, k) => ({ seam, id: seamId(seam, k) }));

const rectangle = (x0: number, x1: number, y0: number, y1: number): P2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A piece more: a rectangle of the size of the zone it is worn on. */
export function addPiece(free: FreePattern, zone: Zone, m: BodyMeasures): FreePattern {
  const arm = zone === "armL" || zone === "armR";
  const w = arm ? (m.upperArm + 8) / 2 : (m.bust + 10) / 4;
  const points = arm ? rectangle(-w, w, -22, -2) : rectangle(-w, w, -(m.hpsToHip + 8), -(m.hpsToArmpit + 6));
  const count = free.pieces.filter((p) => p.zone === zone).length;
  const piece: FreePiece = {
    id: `piece${free.next}`,
    name: count ? `${ZONES[zone]} ${count + 1}` : ZONES[zone],
    zone,
    points,
    edges: points.map((_, i) => ({ id: `e${free.next + 1 + i}` })),
  };
  return { ...free, pieces: [...free.pieces, piece], next: free.next + 1 + points.length };
}

export function removePiece(free: FreePattern, pieceId: string): FreePattern {
  if (free.pieces.length <= 1) return free;
  return { ...free, pieces: free.pieces.filter((p) => p.id !== pieceId), seams: free.seams.filter((s) => s.a.piece !== pieceId && s.b.piece !== pieceId) };
}

export const setZone = (free: FreePattern, pieceId: string, zone: Zone): FreePattern => withPiece(free, pieceId, (p) => ({ ...p, zone }));

/** A piece moved up or down the body (cm): where it is drawn is where it is worn. */
export const movePiece = (free: FreePattern, pieceId: string, dy: number): FreePattern =>
  withPiece(free, pieceId, (p) => ({ ...p, points: p.points.map(([x, y]) => [x, y + dy] as P2) }));

/** Height of the top of a piece (cm; 0: the shoulder line, or the top of the arm). */
export const pieceTop = (piece: FreePiece): number => Math.max(...piece.points.map((p) => p[1]));

// --- Where a drawing starts from ----------------------------------------------------------

/**
 * A pattern of simple shapes to start from: a sleeveless tunic — a front and a back with a
 * neckline and armholes, sewn at the shoulders and down the sides — on the body's measurements.
 */
export function simpleFree(m: BodyMeasures): FreePattern {
  const w = (m.bust + 10) / 4, len = m.hpsToHip + 10, ad = m.hpsToArmpit + 6;
  const nw = m.neck / 6 + 2, sw = m.shoulderWidth / 2, sd = 4;
  const panel = (id: string, name: string, zone: Zone, nd: number): FreePiece => ({
    id,
    name,
    zone,
    points: [[-w, -len], [w, -len], [w, -ad], [sw, -sd], [nw, 0], [-nw, 0], [-sw, -sd], [-w, -ad]],
    edges: [
      { id: "hem" },
      { id: "side+" },
      { id: "arm+", curve: { mid: [sw + 0.3 * (w - sw) - 1.5, -(sd + ad) / 2 - 2] } },
      { id: "shoulder+" },
      { id: "neck", curve: { mid: [0, -nd] } },
      { id: "shoulder-" },
      { id: "arm-", curve: { mid: [-(sw + 0.3 * (w - sw) - 1.5), -(sd + ad) / 2 - 2] } },
      { id: "side-" },
    ],
  });
  const seam = (edge: string): FreeSeam => ({ a: { piece: "front", edge }, b: { piece: "back", edge }, reverse: false });
  return { pieces: [panel("front", "Devant", "front", nw + 3), panel("back", "Dos", "back", 2.5)], seams: ["shoulder+", "shoulder-", "side+", "side-"].map(seam), next: 1 };
}

/** Whether a drafted pattern can be redrawn freely: its pieces must be worn on the zones (a cape's flat circle is not). */
export const canCopy = (pattern: Pattern) => pattern.kind !== "cape";

/**
 * A drafted pattern as a drawing: the same pieces, edges (their ids kept: its clasps and belts
 * still hold) and seams, every piece on its own — a sleeve and its twin are two drawings from
 * then on. A skirt's heights, counted from the waist, are counted from the shoulder line.
 */
export function copyFree(pattern: Pattern, m: BodyMeasures): FreePattern {
  const down = pattern.kind === "skirt" ? m.hpsToWaist : 0;
  const names = new Map<string, number>();
  const zone = (id: string): Zone => (id === "back" ? "back" : id === "sleeve+" ? "armL" : id === "sleeve-" ? "armR" : "front");
  const pieces = pattern.pieces.map((piece): FreePiece => {
    const seen = (names.get(piece.name) ?? 0) + 1;
    names.set(piece.name, seen);
    const lower = (pts: P2[]) => pts.map(([x, y]) => [x, y - down] as P2);
    return {
      id: piece.id,
      name: seen > 1 ? `${piece.name} ${seen}` : piece.name,
      zone: piece.zone ?? zone(piece.id),
      points: lower(piece.edges.map((e) => e.pts[0])),
      edges: piece.edges.map((e) => {
        const curve = shapeOf(e.pts);
        return { id: e.id, ...(curve && { curve }) };
      }),
    };
  });
  const seams = pattern.seams.map((s): FreeSeam => ({ a: { piece: s.a.piece, edge: s.a.edge }, b: { piece: s.b.piece, edge: s.b.edge }, reverse: s.a.reverse !== s.b.reverse }));
  return { pieces, seams, next: 1 };
}
