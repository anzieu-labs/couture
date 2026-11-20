import { cubic, polylineLength, type P2 } from "./curves";

/**
 * Parametric crew-neck t-shirt block drafted from body measurements (cm).
 * Pieces are full (not half) and drawn as seen from the front of the wearer:
 * x = world x (the wearer's left is +x), y up, origin at the high point of the
 * shoulder (HPS) level on the centre line. Sleeves: x across the width
 * (x > 0 = front half), y down the arm from the top of the cap.
 */

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
}

export interface TShirtParams {
  /** Total chest ease (cm); negative for close-fitting knits. */
  chestEase: number;
  /** Total length HPS → hem (cm); 0 = automatic (just below the hip joint). */
  length: number;
  /** Sleeve length from the top of the cap (cm). */
  sleeveLength: number;
  /** Total ease around the biceps (cm). */
  sleeveEase: number;
}

export const DEFAULT_TSHIRT: TShirtParams = { chestEase: 10, length: 0, sleeveLength: 21, sleeveEase: 8 };

export type PieceId = "front" | "back" | "sleeve+" | "sleeve-";

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
  /** Grain line (warp direction), for display. */
  grain: [P2, P2];
  notches: Notch[];
  /** How many to cut (the sleeve piece is listed twice for the simulation, cut ×2). */
  quantity: number;
  /** Mirror-symmetric about x = 0: the "+" edges form a half piece that can be cut on the fold. */
  symmetric: boolean;
  /** Where the piece's name and cutting notes go. */
  label: P2;
}

export interface SeamSide {
  piece: PieceId;
  edge: string;
  /** Traverse the edge against the loop order. */
  reverse: boolean;
}

export interface Seam {
  id: string;
  a: SeamSide;
  b: SeamSide;
}

export interface Pattern {
  name: string;
  pieces: Piece[];
  seams: Seam[];
  /** Key dimensions, for display. */
  dims: { chestWidth: number; hemWidth: number; length: number; armhole: number; capHeight: number; bicep: number };
}

const mirror = (pts: P2[]): P2[] => pts.map(([x, y]) => [-x, y] as P2).reverse();

function bodice(
  kind: "front" | "back",
  m: { nw: number; nd: number; sw: number; sd: number; wc: number; wh: number; ad: number; len: number },
): { edges: Edge[]; armhole: number } {
  const { nw, nd, sw, sd, wc, wh, ad, len } = m;
  const N: P2 = [nw, 0], S: P2 = [sw, -sd], U: P2 = [wc, -ad], H: P2 = [wh, -len];
  // Neckline: quarter ellipse, vertical at the shoulder, horizontal at the centre.
  const neck: P2[] = [];
  for (let i = 0; i <= 24; i++) {
    const phi = (i / 24) * (Math.PI / 2);
    neck.push([nw * Math.cos(phi), -nd * Math.sin(phi)]);
  }
  // Armhole: drops almost vertically from the shoulder (cross-chest / cross-back
  // point slightly inside), then turns out to the underarm.
  const scoop = kind === "front" ? 1.8 : 1.0;
  const arm = cubic(S, [sw - scoop, -sd - 0.5 * (ad - sd)], [sw - scoop + 0.15 * (wc - sw + scoop), -ad], U);
  const armUp = arm.slice().reverse(); // U → S
  const edges: Edge[] = [
    { id: "hem+", pts: [[0, -len], H], allowance: "hem" },
    { id: "side+", pts: [H, U], allowance: "seam" },
    { id: "arm+", pts: armUp, allowance: "seam" },
    { id: "shoulder+", pts: [S, N], allowance: "seam" },
    { id: "neck+", pts: neck, allowance: "seam" },
    { id: "neck-", pts: mirror(neck), allowance: "seam" },
    { id: "shoulder-", pts: mirror([S, N]), allowance: "seam" },
    { id: "arm-", pts: mirror(armUp), allowance: "seam" },
    { id: "side-", pts: mirror([H, U]), allowance: "seam" },
    { id: "hem-", pts: mirror([[0, -len], H]), allowance: "hem" },
  ];
  return { edges, armhole: polylineLength(arm) };
}

function sleeveCap(bw: number, ch: number): P2[] {
  // Top of the cap → front underarm corner (half cap).
  const h = bw / 2;
  return cubic([0, 0], [0.34 * h, 0], [0.55 * h, -ch], [h, -ch]);
}

export function draftTShirt(b: BodyMeasures, p: TShirtParams = DEFAULT_TSHIRT): Pattern {
  const wc = (b.bust + p.chestEase) / 4;
  const wh = Math.max(wc, (b.hips + p.chestEase * 0.8) / 4);
  const sw = b.shoulderWidth / 2 + 1;
  const len = p.length > 0 ? p.length : b.hpsToHip + 10;
  const nw = b.neck / 6 + 1.2;
  const common = { nw, sw, sd: 4.5, wc, wh, ad: b.hpsToArmpit + 4.5, len };
  const front = bodice("front", { ...common, nd: nw + 1.8 });
  const back = bodice("back", { ...common, nd: 2 });

  // Sleeve: solve the cap height so that the cap matches the armhole (+ a little ease).
  const bw = b.upperArm + p.sleeveEase;
  const target = (front.armhole + back.armhole) / 2 + 0.4;
  let lo = 2, hi = 25;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (polylineLength(sleeveCap(bw, mid)) < target) lo = mid;
    else hi = mid;
  }
  const ch = (lo + hi) / 2;
  const sl = Math.max(p.sleeveLength, ch + 4);
  const hw = bw * 0.92;
  const capFront = sleeveCap(bw, ch); // top → front corner
  const capBack = mirror(capFront).reverse(); // top → back corner
  const Cf: P2 = [bw / 2, -ch], Cb: P2 = [-bw / 2, -ch];
  const Hf: P2 = [hw / 2, -sl], Hb: P2 = [-hw / 2, -sl];
  const sleeveEdges = (): Edge[] => [
    { id: "capBack", pts: capBack, allowance: "seam" },
    { id: "underBack", pts: [Cb, Hb], allowance: "seam" },
    { id: "hem", pts: [Hb, Hf], allowance: "hem" },
    { id: "underFront", pts: [Hf, Cf], allowance: "seam" },
    { id: "capFront", pts: capFront.slice().reverse(), allowance: "seam" },
  ];

  // Labels sit between the grain line (centre) and the side seam, mid-way armpit → hem;
  // on the sleeve, in the band under the cap.
  const bodiceLabel: P2 = [-wc / 2, -(common.ad + len) / 2];
  const sleeveLabel: P2 = [-bw / 4, -(ch + sl) / 2];
  const bodicePiece = (id: "front" | "back", name: string, edges: Edge[]): Piece => ({
    id, name, edges, grain: [[0, -8], [0, -len + 8]], notches: [], quantity: 1, symmetric: true, label: bodiceLabel,
  });
  const sleevePiece = (id: "sleeve+" | "sleeve-"): Piece => ({
    id, name: "Manche", edges: sleeveEdges(), grain: [[0, -2], [0, -sl + 3]], notches: [], quantity: 2, symmetric: true, label: sleeveLabel,
  });
  const pieces: Piece[] = [bodicePiece("front", "Devant", front.edges), bodicePiece("back", "Dos", back.edges), sleevePiece("sleeve+"), sleevePiece("sleeve-")];
  const byId = new Map(pieces.map((p) => [p.id, p]));

  const side = (piece: PieceId, edge: string, reverse = false): SeamSide => ({ piece, edge, reverse });
  const seams: Seam[] = [];
  for (const s of ["+", "-"] as const) {
    const sleeve: PieceId = `sleeve${s}`;
    // Body edges on the "-" side run in the opposite direction (mirrored loop).
    const r = s === "-";
    seams.push(
      { id: `shoulder${s}`, a: side("front", `shoulder${s}`), b: side("back", `shoulder${s}`) },
      { id: `side${s}`, a: side("front", `side${s}`), b: side("back", `side${s}`) },
      // armhole U → S  ↔  sleeve cap corner → top
      { id: `armFront${s}`, a: side("front", `arm${s}`, r), b: side(sleeve, "capFront") },
      { id: `armBack${s}`, a: side("back", `arm${s}`, r), b: side(sleeve, "capBack", true) },
      // sleeve underarm: corner → hem on both sides
      { id: `underarm${s}`, a: side(sleeve, "underBack"), b: side(sleeve, "underFront", true) },
    );
  }

  // Match marks. A seam notch sits at the same fraction t of both sides, measured in the
  // stitching direction (the same proportional matching as the simulation mesh).
  const notchSeam = (id: string, t: number, count: 1 | 2) => {
    const seam = seams.find((x) => x.id === id)!;
    for (const sd of [seam.a, seam.b]) byId.get(sd.piece)!.notches.push({ edge: sd.edge, t: sd.reverse ? 1 - t : t, count });
  };
  for (const s of ["+", "-"]) {
    notchSeam(`armFront${s}`, 0.5, 1); // single notch: front armhole
    notchSeam(`armBack${s}`, 0.5, 2); // double notch: back armhole
  }
  for (const id of ["front", "back"] as const)
    byId.get(id)!.notches.push({ edge: "neck+", t: 1, count: 1 }, { edge: "hem+", t: 0, count: 1 }); // centre front / back
  for (const id of ["sleeve+", "sleeve-"] as const) byId.get(id)!.notches.push({ edge: "capBack", t: 0, count: 1 }); // top of cap ↔ shoulder seam

  return {
    name: "T-shirt col rond",
    pieces,
    seams,
    dims: { chestWidth: wc * 4, hemWidth: wh * 4, length: len, armhole: front.armhole + back.armhole, capHeight: ch, bicep: bw },
  };
}
