import { cubic, polylineLength, type P2 } from "./curves";
import { KAPPA, mirror, NO_EDITS, PointSet, type BodyMeasures, type Edge, type Handle, type Pattern, type PatternEdits, type Piece, type PieceId, type Seam, type SeamSide } from "./types";

/**
 * Parametric crew-neck t-shirt block drafted from body measurements (cm).
 * Pieces are full (not half) and drawn as seen from the front of the wearer:
 * x = world x (the wearer's left is +x), y up, origin at the high point of the
 * shoulder (HPS) level on the centre line. Sleeves: x across the width
 * (x > 0 = front half), y down the arm from the top of the cap.
 */

export interface TShirtParams {
  /** Total chest ease (cm); negative for close-fitting knits. */
  chestEase: number;
  /** Total length HPS → hem (cm); 0 = automatic (just below the hip joint). */
  length: number;
  /** Sleeve length from the top of the cap (cm); 0 = automatic (to the wrist). */
  sleeveLength: number;
  /** Total ease around the biceps (cm). */
  sleeveEase: number;
  /** Taken in at the waist, on each side seam (cm); 0: straight side seams. */
  waist?: number;
  /** How far the front neckline is lowered (cm); it widens, and the back one comes down, in proportion. */
  neckDrop?: number;
  /**
   * Added at the hem on each side, beyond the hip line (cm), for a garment longer than the
   * hips (a dress): the side seam then goes through the fullest hip. Left out: a t-shirt's
   * side seam, straight from the underarm to a hem as wide as the hips.
   */
  flare?: number;
  /** Sleeveless: width of the shoulder strap, and how far the armhole comes down (cm). */
  strap?: number;
  armDrop?: number;
}

export const DEFAULT_TSHIRT: TShirtParams = { chestEase: 10, length: 0, sleeveLength: 21, sleeveEase: 8 };

/** What makes a garment of this block: its name, whether it has sleeves, and its length when left automatic. */
export interface TShirtStyle {
  name: string;
  sleeves: boolean;
  autoLength: (b: BodyMeasures) => number;
}

/** A t-shirt's automatic length: just below the hip joint. */
export const tshirtAutoLength = (b: BodyMeasures) => Math.round(b.hpsToHip + 10);
/** A t-shirt dress's: above the knee. */
export const dressAutoLength = (b: BodyMeasures) => Math.round(b.hpsToWaist + b.waistToKnee - 6);
/** A long sleeve's: to the wrist (the cap starts at the shoulder point, outside the joint). */
export const sleeveAutoLength = (b: BodyMeasures) => Math.round(b.armLength + 3);

export const TSHIRT: TShirtStyle = { name: "T-shirt col rond", sleeves: true, autoLength: tshirtAutoLength };

const lerp = (a: P2, b: P2, t: number): P2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function bodice(
  kind: "front" | "back",
  m: {
    nw: number; nd: number; sw: number; sd: number; wc: number; wh: number; ad: number; len: number;
    /** Half width and level of the waist the side seam goes through; null: none. */
    waist: P2 | null;
    /** Half width and level of the fullest hip, when the hem (wh + flare) is lower. */
    hip: P2 | null;
    flare: number;
    /** No sleeve sewn in the armhole: a free edge. */
    sleeveless: boolean;
  },
  edits: PatternEdits,
): { edges: Edge[]; armhole: number; handles: Handle[]; U: P2; H: P2; CH: P2; W: P2 | null } {
  const { nw, nd, sw, sd, wc, wh, ad, len } = m;
  const P = new PointSet(kind, kind, edits);
  const N0: P2 = [nw, 0], CN0: P2 = [0, -nd], S0: P2 = [sw, -sd], U0: P2 = [wc, -ad];
  const N = P.anchor("N", "Encolure · épaule", N0);
  const CN = P.anchor("CN", "Milieu d'encolure", CN0, "vertical");
  // Neckline: a quarter ellipse (as a cubic), vertical at the shoulder, horizontal at the centre.
  const n1 = P.control("n1", "Courbe d'encolure", [nw, -KAPPA * nd], N0, N);
  const n2 = P.control("n2", "Courbe d'encolure", [KAPPA * nw, -nd], CN0, CN, "horizontal");
  const S = P.anchor("S", "Point d'épaule", S0);
  const U = P.anchor("U", "Dessous de bras", U0);
  // Armhole: drops almost vertically from the shoulder (cross-chest / cross-back
  // point slightly inside), then turns out to the underarm.
  const scoop = kind === "front" ? 1.8 : 1.0;
  const a1 = P.control("a1", "Courbe d'emmanchure", [sw - scoop, -sd - 0.5 * (ad - sd)], S0, S);
  const a2 = P.control("a2", "Courbe d'emmanchure", [sw - scoop + 0.15 * (wc - sw + scoop), -ad], U0, U);
  const H = P.anchor("H", "Côté · bas", [wh + m.flare, -len]);
  const CH = P.anchor("CH", "Milieu bas", [0, -len], "vertical");
  const neck = cubic(N, n1, n2, CN);
  const arm = cubic(S, a1, a2, U);
  const armUp = arm.slice().reverse(); // U → S
  // Side seam, from the underarm down: in to the waist, out to the fullest hip (vertical at
  // both), then straight to the hem; a t-shirt's is one straight line.
  const W = m.waist && P.anchor("W", "Côté · taille", [m.waist[0], -m.waist[1]]);
  const HP = m.hip && P.anchor("HP", "Côté · hanche", [m.hip[0], -m.hip[1]]);
  const upright = (a: P2, b: P2, from: boolean) => cubic(a, from ? [a[0], a[1] - (a[1] - b[1]) / 3] : lerp(a, b, 1 / 3), [b[0], b[1] + (a[1] - b[1]) / 3], b);
  const sideDown: P2[] = [U];
  let at = U;
  for (const next of [W, HP]) {
    if (!next) continue;
    sideDown.push(...upright(at, next, at !== U).slice(1));
    at = next;
  }
  if (at === U || HP) sideDown.push(H);
  else sideDown.push(...upright(at, H, true).slice(1));
  const edges: Edge[] = [
    { id: "hem+", pts: [CH, H], allowance: "hem" },
    { id: "side+", pts: sideDown.slice().reverse(), allowance: "seam" },
    { id: "arm+", pts: armUp, allowance: m.sleeveless ? "hem" : "seam" },
    { id: "shoulder+", pts: [S, N], allowance: "seam" },
    { id: "neck+", pts: neck, allowance: "seam" },
    { id: "neck-", pts: mirror(neck), allowance: "seam" },
    { id: "shoulder-", pts: mirror([S, N]), allowance: "seam" },
    { id: "arm-", pts: mirror(armUp), allowance: m.sleeveless ? "hem" : "seam" },
    { id: "side-", pts: mirror(sideDown.slice().reverse()), allowance: "seam" },
    { id: "hem-", pts: mirror([CH, H]), allowance: "hem" },
  ];
  return { edges, armhole: polylineLength(arm), handles: P.handles, U, H, CH, W: W || null };
}

function sleeveCap(bw: number, ch: number): P2[] {
  // Top of the cap → front underarm corner (half cap).
  const h = bw / 2;
  return cubic([0, 0], [0.34 * h, 0], [0.55 * h, -ch], [h, -ch]);
}

export function draftTShirt(b: BodyMeasures, p: TShirtParams = DEFAULT_TSHIRT, edits: PatternEdits = NO_EDITS, style: TShirtStyle = TSHIRT): Pattern {
  const wc = (b.bust + p.chestEase) / 4;
  const wh = Math.max(wc, (b.hips + p.chestEase * 0.8) / 4);
  const len = p.length > 0 ? p.length : style.autoLength(b);
  const drop = p.neckDrop ?? 0;
  const nw = b.neck / 6 + 1.2 + 0.35 * drop;
  // Shoulder: out to the shoulder point, sloping 4.5 cm; a sleeveless top stops at its strap.
  const fullShoulder = b.shoulderWidth / 2 + 1, slope = 4.5 / (fullShoulder - (b.neck / 6 + 1.2));
  const sw = style.sleeves ? fullShoulder : Math.min(fullShoulder, nw + (p.strap ?? 6));
  const sd = style.sleeves ? 4.5 : slope * (sw - nw);
  const ad = b.hpsToArmpit + 4.5 + (style.sleeves ? 0 : (p.armDrop ?? 0));
  // Waist and hip the side seam goes through, when it is shaped (see TShirtParams).
  const shaped = (p.waist ?? 0) > 0 || p.flare !== undefined;
  const hipY = b.hpsToWaist + b.waistToHip;
  const waist: P2 | null =
    shaped && b.hpsToWaist > ad + 4 && b.hpsToWaist < len - 4
      ? [Math.min(wc, Math.max(wc - (p.waist ?? 0), (b.waist + Math.max(2, p.chestEase / 2)) / 4)), b.hpsToWaist]
      : null;
  const hip: P2 | null = p.flare !== undefined && len > hipY + 4 ? [wh, hipY] : null;
  const common = { nw, sw, sd, wc, wh, ad, len, waist, hip, flare: hip ? (p.flare ?? 0) : 0, sleeveless: !style.sleeves };
  const front = bodice("front", { ...common, nd: b.neck / 6 + 3 + drop }, edits);
  const back = bodice("back", { ...common, nd: 2 + 0.3 * drop }, edits);

  // Sleeve: solve the cap height so that the (drafted) cap matches the armhole, edited
  // or not, plus a little ease: editing the armhole re-fits the sleeve. The sleeve's
  // own edits then apply on top of the fitted cap.
  const bw = b.upperArm + p.sleeveEase;
  const target = (front.armhole + back.armhole) / 2 + 0.4;
  let lo = 2, hi = 25;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (polylineLength(sleeveCap(bw, mid)) < target) lo = mid;
    else hi = mid;
  }
  const ch = (lo + hi) / 2;
  const sl = Math.max(p.sleeveLength > 0 ? p.sleeveLength : sleeveAutoLength(b), ch + 4);
  // Narrower towards the wrist: a short sleeve's hem is nearly as wide as the biceps, a long one's 0.58 of it.
  const hw = bw * (0.92 - 0.34 * Math.min(1, Math.max(0, (sl - 25) / 30)));
  const h = bw / 2;
  const SP = new PointSet("sleeve", "sleeve+", edits);
  const T0: P2 = [0, 0], C0: P2 = [h, -ch];
  const T = SP.anchor("T", "Haut de tête", T0, "vertical");
  const Cf = SP.anchor("C", "Dessous de bras", C0);
  const c1 = SP.control("c1", "Courbe de tête", [0.34 * h, 0], T0, T, "horizontal");
  const c2 = SP.control("c2", "Courbe de tête", [0.55 * h, -ch], C0, Cf);
  const Hf = SP.anchor("H", "Bas de manche", [hw / 2, -sl]);
  const capFront = cubic(T, c1, c2, Cf); // top → front corner
  const capBack = mirror(capFront).reverse(); // top → back corner
  const Cb: P2 = [-Cf[0], Cf[1]], Hb: P2 = [-Hf[0], Hf[1]];
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
  const pieces: Piece[] = [bodicePiece("front", "Devant", front.edges), bodicePiece("back", "Dos", back.edges)];
  if (style.sleeves) pieces.push(sleevePiece("sleeve+"), sleevePiece("sleeve-"));
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
    );
    if (!style.sleeves) continue;
    seams.push(
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
  for (const s of style.sleeves ? ["+", "-"] : []) {
    notchSeam(`armFront${s}`, 0.5, 1); // single notch: front armhole
    notchSeam(`armBack${s}`, 0.5, 2); // double notch: back armhole
  }
  for (const id of ["front", "back"] as const)
    byId.get(id)!.notches.push({ edge: "neck+", t: 1, count: 1 }, { edge: "hem+", t: 0, count: 1 }); // centre front / back
  for (const id of style.sleeves ? (["sleeve+", "sleeve-"] as const) : []) byId.get(id)!.notches.push({ edge: "capBack", t: 0, count: 1 }); // top of cap ↔ shoulder seam

  const chest = 2 * (front.U[0] + back.U[0]), length = -front.CH[1];
  return {
    kind: "tshirt",
    name: style.name,
    pieces,
    seams,
    handles: [...front.handles, ...back.handles, ...(style.sleeves ? SP.handles : [])],
    dims: [
      { label: "Tour de poitrine", value: chest },
      ...(front.W && back.W ? [{ label: "Tour de taille", value: 2 * (front.W[0] + back.W[0]) }] : []),
      { label: "Tour de bas", value: 2 * (front.H[0] + back.H[0]) },
      { label: "Longueur", value: length },
      { label: "Emmanchure", value: front.armhole + back.armhole },
      ...(style.sleeves
        ? [
            { label: "Tête de manche", value: T[1] - Cf[1] },
            { label: "Tour de bras", value: 2 * Cf[0] },
            { label: "Longueur de manche", value: T[1] - Hf[1] },
          ]
        : []),
    ],
    sizeNote: `poitrine finie ${chest.toFixed(0)} cm · longueur ${length.toFixed(0)} cm`,
    checks: [
      { seam: "shoulder+", label: "Épaule", kind: "match" },
      { seam: "side+", label: "Côté", kind: "match" },
      ...(style.sleeves
        ? ([
            { seam: "armFront+", label: "Emmanchure devant", kind: "ease" },
            { seam: "armBack+", label: "Emmanchure dos", kind: "ease" },
          ] as const)
        : []),
    ],
  };
}
