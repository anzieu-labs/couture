import type { P2 } from "./curves";

/**
 * Types shared by every garment pattern (t-shirt, cape…): pieces, seams,
 * editable points, and what the simulation and the interface need to know.
 * Units: cm, piece coordinates with y up, loops counter-clockwise.
 */

/** Body measurements used to draft (cm). */
export interface BodyMeasures {
  bust: number;
  waist: number;
  hips: number;
  neck: number;
  upperArm: number;
  /** Distance between shoulder points (garment shoulder width). */
  shoulderWidth: number;
  /** Vertical distance HPS → armpit. */
  hpsToArmpit: number;
  /** Vertical distance HPS → hip joint (sets the default length). */
  hpsToHip: number;
  /** Vertical distance HPS → floor. */
  hpsToFloor: number;
  /** Vertical distance HPS → top of the head. */
  headHeight: number;
  /** Head depth (forehead → back of the skull) and width (ears included). */
  headDepth: number;
  headWidth: number;
  /** Vertical distances from the natural waist (narrowest girth) to the fullest hip and to the knee. */
  waistToHip: number;
  waistToKnee: number;
}

/** Garment kinds (also selects the 3D placement before sewing). */
export type GarmentKind = "tshirt" | "cape" | "skirt";

export type PieceId = string;

/** Which allowance the cut line adds outside the edge (see `lib/pattern/markings.ts`). */
export type EdgeAllowance = "seam" | "hem" | "none";

export interface Edge {
  id: string;
  /** Points in loop (counter-clockwise) order. */
  pts: P2[];
  allowance: EdgeAllowance;
}

/** Match mark on an edge: `t` is the arc-length fraction in loop order. */
export interface Notch {
  edge: string;
  t: number;
  /** 1 = front / centre, 2 = back (sewing convention). */
  count: 1 | 2;
}

export interface Piece {
  id: PieceId;
  name: string;
  edges: Edge[];
  /** Grain line (warp direction). */
  grain: [P2, P2];
  notches: Notch[];
  /** How many to cut (a piece listed twice for the simulation — sleeves — is cut ×2). */
  quantity: number;
  /** Mirror-symmetric about x = 0: the "+" edges form a half piece that can be cut on the fold. */
  symmetric: boolean;
  /** Where the piece's name and cutting notes go. */
  label: P2;
  /** Grain line and label of the half piece cut on the fold (default: derived from the width). */
  foldGrain?: [P2, P2];
  foldLabel?: P2;
}

export interface SeamSide {
  piece: PieceId;
  edge: string;
  /** Traverse the edge against the loop order. */
  reverse: boolean;
}

export interface Seam {
  /** `<kind><side>`: the kind (id without its "+" / "-" side) sets the colour and legend. */
  id: string;
  a: SeamSide;
  b: SeamSide;
}

/**
 * A band sewn along edges that keeps their total length — a waistband: the fabric may
 * gather along it, but the garment cannot open up there (a skirt's waist does not stretch
 * over the hips). Simulated as one constraint on the summed length of the edges.
 */
export interface Band {
  edges: { piece: PieceId; edge: string }[];
  /** Elasticity: how far the band may stretch beyond the edges' length (0.1: 10 %; 0: rigid). */
  stretch: number;
}

/**
 * Pattern edits: displacement (cm) of named draft points, keyed `group.point`.
 * Relative to the drafted position, so edits survive a change of morphology.
 */
export type PatternEdits = Readonly<Record<string, P2>>;

export const NO_EDITS: PatternEdits = {};

/** Point the editor can drag (the mirrored half / twin piece follows). */
export interface Handle {
  key: string;
  /** Piece it is drawn on. */
  piece: PieceId;
  label: string;
  /** Current position, piece coordinates. */
  pos: P2;
  /** Curve control point: the anchor it is tied to (moves with it). */
  anchor: P2 | null;
  /** Allowed movement: points on a centre line only move vertically, the control
   *  points next to it only horizontally (the mirrored curve stays smooth). */
  axis: "free" | "vertical" | "horizontal";
}

/** Seam whose two sides are compared in the editor ("match": same length; "ease": b − a). */
export interface SeamCheck {
  seam: string;
  label: string;
  kind: "match" | "ease";
}

export interface Pattern {
  kind: GarmentKind;
  name: string;
  pieces: Piece[];
  seams: Seam[];
  /** Edges held to their length by a band (waistband). */
  bands?: Band[];
  /** Editable points (all pieces). */
  handles: Handle[];
  /** Key dimensions, for display (cm). */
  dims: { label: string; value: number }[];
  /** Short size description (exports). */
  sizeNote: string;
  checks: SeamCheck[];
  /** Simulation hints. */
  sim?: {
    /** Mesh spacing multiplier (large garments use a coarser mesh). */
    spacingScale?: number;
    /** How far below its starting position the garment may fall (m): sizes the collision field. */
    fallRoom?: number;
    /** Velocity damping (1/s) and maximum simulated time (s), when the default does not suit. */
    damping?: number;
    duration?: number;
    /** Time to fall into the drape after sewing, before the body may move (s). */
    settleTime?: number;
  };
}

export const mirror = (pts: P2[]): P2[] => pts.map(([x, y]) => [-x, y] as P2).reverse();

/** Mirror image of a loop of edges about x = 0 (still counter-clockwise, same ids). */
export const mirrorEdges = (edges: Edge[]): Edge[] => edges.map((e) => ({ ...e, pts: mirror(e.pts) })).reverse();

/** Cubic Bézier handle length for a quarter ellipse. */
export const KAPPA = 0.5523;

/** Resolves the named points of a piece: drafted position + edit, recording the handles. */
export class PointSet {
  readonly handles: Handle[] = [];
  private readonly group: string;
  private readonly piece: PieceId;
  private readonly edits: PatternEdits;

  /** `group`: prefix of the edit keys; `piece`: the piece the handles are drawn on. */
  constructor(group: string, piece: PieceId, edits: PatternEdits) {
    this.group = group;
    this.piece = piece;
    this.edits = edits;
  }

  private delta(id: string, axis: Handle["axis"]): P2 {
    const d = this.edits[`${this.group}.${id}`] ?? [0, 0];
    return axis === "vertical" ? [0, d[1]] : axis === "horizontal" ? [d[0], 0] : d;
  }

  anchor(id: string, label: string, base: P2, axis: Handle["axis"] = "free"): P2 {
    const d = this.delta(id, axis);
    const pos: P2 = [base[0] + d[0], base[1] + d[1]];
    this.handles.push({ key: `${this.group}.${id}`, piece: this.piece, label, pos, anchor: null, axis });
    return pos;
  }

  /** Curve control point: follows its anchor's displacement, plus its own edit. */
  control(id: string, label: string, base: P2, anchorBase: P2, anchorPos: P2, axis: Handle["axis"] = "free"): P2 {
    const d = this.delta(id, axis);
    const pos: P2 = [base[0] + anchorPos[0] - anchorBase[0] + d[0], base[1] + anchorPos[1] - anchorBase[1] + d[1]];
    this.handles.push({ key: `${this.group}.${id}`, piece: this.piece, label, pos, anchor: anchorPos, axis });
    return pos;
  }
}

/** Arc length of an edge of a piece. */
export function seamSideLength(pattern: Pattern, side: SeamSide): number {
  const pts = pattern.pieces.find((p) => p.id === side.piece)!.edges.find((e) => e.id === side.edge)!.pts;
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** `${piece}/${edge}` → seam kind (seam id without its side), for colouring. */
export function seamKinds(pattern: Pattern): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of pattern.seams) {
    const kind = s.id.replace(/[+-]$/, "");
    out.set(`${s.a.piece}/${s.a.edge}`, kind);
    out.set(`${s.b.piece}/${s.b.edge}`, kind);
  }
  return out;
}
