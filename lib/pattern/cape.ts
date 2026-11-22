import { cubic, polylineLength, type P2 } from "./curves";
import { KAPPA, mirror, mirrorEdges, NO_EDITS, PointSet, type BodyMeasures, type Clasp, type Edge, type Pattern, type PatternEdits, type Piece, type Seam, type SeamSide } from "./types";

/**
 * Magician's cape: a full circle open at the front, with a two-piece hood.
 *
 * The circle is cut in three panels — a back half circle (can be cut on the fold
 * at the centre back) and two front quarters, 5° short of the centre front so the
 * fronts hang apart — joined by shoulder seams. All three are drawn around the
 * same origin (the centre of the circle): radius r1 = neckline, r2 = hem. Back:
 * centre back along −y, shoulders along ±x. Fronts: shoulder along ±x, centre
 * front near −y. A full circle being flat, it is laid horizontally at the base
 * of the neck before sewing (lib/garment/place.ts) and falls into its drape. A clasp at
 * the neck (CAPE_CLASPS) holds the two fronts together: friction alone lets the cape slip
 * off the shoulders as soon as the body walks.
 *
 * Hood: u from the face edge towards the back, v up from the neck edge. Its neck
 * edge is sewn to the cape's neckline and split at the shoulder seam (front /
 * back arcs); the back seam runs from the nape over the crown to the forehead,
 * optionally drawn up into a point.
 */

export interface CapeParams {
  /** Neckline → hem (cm); 0 = automatic (mid-calf). */
  length: number;
  /** Added to the neck girth for the neckline (cm). */
  neckEase: number;
  /** Hood room above the head and behind it (cm). */
  hoodHeight: number;
  hoodDepth: number;
  /** How far the top of the hood is drawn up into a point (cm); 0 = round hood. */
  hoodPoint: number;
}

export const DEFAULT_CAPE: CapeParams = { length: 0, neckEase: 6, hoodHeight: 8, hoodDepth: 10, hoodPoint: 8 };

/**
 * The clasp the cape comes with: the two fronts fastened at the neck, by their neckline
 * corners at the centre front (the end of the left front's neck edge; the right front being
 * its mirror image, the start of its own). Like any clasp, the user may remove it.
 */
export const CAPE_CLASPS: readonly Clasp[] = [
  { a: { piece: "front+", edge: "neck", t: 1, offset: [0, 0] }, b: { piece: "front-", edge: "neck", t: 0, offset: [0, 0] } },
];

/** Automatic length: to mid-calf. */
export const capeAutoLength = (m: BodyMeasures) => Math.round(m.hpsToFloor - 34);

/** Front panel angle (rad): a quarter less half the gap left open at the centre front. */
const FRONT = ((90 - 5) * Math.PI) / 180;

const renameSide = (edges: Edge[]): Edge[] => edges.map((e) => ({ ...e, id: e.id.replace(/\+$/, "-") }));

/** What makes a garment of this block: its name, whether it has a hood, and its length when left automatic. */
export interface CapeStyle {
  name: string;
  hood: boolean;
  autoLength: (b: BodyMeasures) => number;
}

export const CAPE: CapeStyle = { name: "Cape à capuche", hood: true, autoLength: capeAutoLength };

/** A capelet's automatic length: to the elbow. */
export const capeletAutoLength = (b: BodyMeasures) => Math.round(0.55 * b.armLength + 8);

export function draftCape(b: BodyMeasures, p: CapeParams = DEFAULT_CAPE, edits: PatternEdits = NO_EDITS, style: CapeStyle = CAPE): Pattern {
  const L = p.length > 0 ? p.length : style.autoLength(b);
  const neckline = b.neck + p.neckEase;
  const r1 = neckline / (Math.PI + 2 * FRONT);
  const r2 = r1 + L;
  const rm = (r1 + r2) / 2;

  // The panels are arcs of circles, drawn as cubic Béziers between named points so that they
  // can be edited (a quarter circle by a cubic is off by 0.03 % of its radius: 0.4 mm on the
  // hem). The points on the shoulder line belong to the back and to the front alike — one
  // edit moves both, the shoulder seam keeps matching.
  const bp = new PointSet("cape", "back", edits);
  const fp = new PointSet("cape", "front+", edits);
  const shoulder = (set: PointSet) => ({
    SH: set.anchor("SH", "Bas · épaule", [r2, 0]),
    SN: set.anchor("SN", "Encolure · épaule", [r1, 0]),
  });

  // ---- Back: half annulus, symmetric about the centre back (x = 0).
  const CH = bp.anchor("CH", "Milieu bas", [0, -r2], "vertical");
  const CN = bp.anchor("CN", "Milieu encolure", [0, -r1], "vertical");
  const B = shoulder(bp);
  const bh1 = bp.control("bh1", "Courbe du bas", [KAPPA * r2, -r2], [0, -r2], CH, "horizontal");
  const bh2 = bp.control("bh2", "Courbe du bas", [r2, -KAPPA * r2], [r2, 0], B.SH);
  const bn1 = bp.control("bn1", "Courbe d'encolure", [r1, -KAPPA * r1], [r1, 0], B.SN);
  const bn2 = bp.control("bn2", "Courbe d'encolure", [KAPPA * r1, -r1], [0, -r1], CN, "horizontal");
  const backNeck = cubic(B.SN, bn1, bn2, CN, 24);
  const backPlus: Edge[] = [
    { id: "hem+", pts: cubic(CH, bh1, bh2, B.SH, 64), allowance: "hem" },
    { id: "shoulder+", pts: [B.SH, B.SN], allowance: "seam" },
    { id: "neck+", pts: backNeck, allowance: "seam" },
  ];
  // Grain line off the centre line when cut on the fold, where the panel is tall enough.
  const gx = 0.3 * r2;
  const grainAt = (x: number): [P2, P2] => [[x, (x < r1 ? -Math.sqrt(r1 * r1 - x * x) : 0) - 5], [x, -Math.sqrt(r2 * r2 - x * x) + 5]];
  const back: Piece = {
    id: "back",
    name: "Dos",
    edges: [...backPlus, ...renameSide(mirrorEdges(backPlus))],
    grain: [[0, -r1 - 6], [0, -r2 + 6]],
    notches: [{ edge: "neck+", t: 1, count: 1 }, { edge: "hem+", t: 0, count: 1 }],
    quantity: 1,
    symmetric: true,
    label: [rm * Math.sin(0.7), -rm * Math.cos(0.7)],
    foldGrain: grainAt(gx),
    foldLabel: [rm * Math.sin(1.0), -rm * Math.cos(1.0)],
  };

  // ---- Fronts: quarter annulus less the centre-front gap; the left one (+x), and its mirror.
  // Angle ψ below the +x axis: point (r cos ψ, −r sin ψ), from the shoulder (0) to the centre front.
  const cs = Math.cos(FRONT), sn = Math.sin(FRONT);
  const kf = (4 / 3) * Math.tan(FRONT / 4); // Bézier handle length of an arc of that angle
  const cf0b: P2 = [r1 * cs, -r1 * sn], cf1b: P2 = [r2 * cs, -r2 * sn];
  const F = shoulder(fp);
  const cf0 = fp.anchor("FN", "Encolure · devant", cf0b);
  const cf1 = fp.anchor("FH", "Bas · devant", cf1b);
  const fh1 = fp.control("fh1", "Courbe du bas", [cf1b[0] + kf * r2 * sn, cf1b[1] + kf * r2 * cs], cf1b, cf1);
  const fh2 = fp.control("fh2", "Courbe du bas", [r2, -kf * r2], [r2, 0], F.SH);
  const fn1 = fp.control("fn1", "Courbe d'encolure", [r1, -kf * r1], [r1, 0], F.SN);
  const fn2 = fp.control("fn2", "Courbe d'encolure", [cf0b[0] + kf * r1 * sn, cf0b[1] + kf * r1 * cs], cf0b, cf0);
  const frontNeck = cubic(F.SN, fn1, fn2, cf0, 24);
  const frontEdges: Edge[] = [
    { id: "hem", pts: cubic(cf1, fh1, fh2, F.SH, 64), allowance: "hem" },
    { id: "shoulder", pts: [F.SH, F.SN], allowance: "seam" },
    { id: "neck", pts: frontNeck, allowance: "seam" },
    { id: "cf", pts: [cf0, cf1], allowance: "hem" },
  ];
  const frontLabel: P2 = [rm * Math.cos(Math.PI / 4), -rm * Math.sin(Math.PI / 4)];
  const front = (side: "+" | "-"): Piece => {
    const m = side === "-";
    const grain = grainAt(gx);
    return {
      id: `front${side}`,
      name: "Devant",
      edges: m ? mirrorEdges(frontEdges) : frontEdges,
      grain: m ? (mirror(grain).reverse() as [P2, P2]) : grain,
      notches: [],
      quantity: 2,
      symmetric: false,
      label: m ? [-frontLabel[0], frontLabel[1]] : frontLabel,
    };
  };

  // ---- Hood: neck edge = front arc + back arc of the neckline (as drawn, edits included),
  // split at the shoulder.
  const nf = polylineLength(frontNeck), nb = polylineLength(backNeck);
  const H = b.headHeight + p.hoodHeight;
  const D = b.headDepth + p.hoodDepth;
  const hp = new PointSet("hood", "hood+", edits);
  const A: P2 = [0, 0], S: P2 = [nf, 0], N: P2 = [nf + nb, 0];
  const K0: P2 = [D, 0.45 * H], T0: P2 = [0, H];
  const K = hp.anchor("K", "Arrière de capuche", K0);
  const T = hp.anchor("T", "Haut du visage", T0);
  // Crown point: on the round crown for hoodPoint = 0, drawn up and back for a pointed hood.
  const k = Math.min(1, p.hoodPoint / 15);
  const P0: P2 = [0.72 * D + 0.55 * p.hoodPoint, 0.97 * H + 0.75 * p.hoodPoint];
  const P = hp.anchor("P", "Pointe", P0);
  const lin = (a: P2, b2: P2, t: number): P2 => [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t];
  // Tangents at the crown point turn from "smooth" (round) to a corner (point).
  const hIn = 0.22 * H * (1 - 0.6 * k), hOut = 0.3 * D * (1 - 0.6 * k);
  const dirIn = lin([-0.55, 0.83], [-0.15, 0.99], k), dirOut = lin([-0.55, 0.83], [-0.98, -0.2], k);
  const c1 = hp.control("c1", "Courbe arrière", [N[0] + 0.85 * (D - N[0]), 0.08 * H], N, N);
  const c2 = hp.control("c2", "Courbe arrière", [D, 0.25 * H], K0, K);
  const c3 = hp.control("c3", "Courbe arrière", [D, 0.7 * H], K0, K);
  const c4 = hp.control("c4", "Courbe de pointe", [P0[0] - dirIn[0] * hIn, P0[1] - dirIn[1] * hIn], P0, P);
  const c5 = hp.control("c5", "Courbe de pointe", [P0[0] + dirOut[0] * hOut, P0[1] + dirOut[1] * hOut], P0, P);
  const c6 = hp.control("c6", "Courbe du dessus", [0.3 * D, H], T0, T, "free");
  const backSeam = [...cubic(N, c1, c2, K), ...cubic(K, c3, c4, P).slice(1), ...cubic(P, c5, c6, T).slice(1)];
  const hoodEdges: Edge[] = [
    { id: "neckFront", pts: [A, S], allowance: "seam" },
    { id: "neckBack", pts: [S, N], allowance: "seam" },
    { id: "back", pts: backSeam, allowance: "seam" },
    { id: "face", pts: [T, A], allowance: "hem" },
  ];
  const hood = (side: "+" | "-"): Piece => {
    const m = side === "-";
    const grain: [P2, P2] = [[0.3 * D, 3], [0.3 * D, Math.min(H, T[1]) - 4]];
    const label: P2 = [0.58 * D, 0.42 * H];
    return {
      id: `hood${side}`,
      name: "Capuche",
      edges: m ? mirrorEdges(hoodEdges) : hoodEdges,
      grain: m ? (mirror(grain).reverse() as [P2, P2]) : grain,
      notches: [{ edge: "neckBack", t: 0, count: 1 }],
      quantity: 2,
      symmetric: false,
      label: m ? [-label[0], label[1]] : label,
    };
  };

  const pieces = style.hood ? [back, front("+"), front("-"), hood("+"), hood("-")] : [back, front("+"), front("-")];
  const side = (piece: string, edge: string, reverse = false): SeamSide => ({ piece, edge, reverse });
  const seams: Seam[] = [];
  for (const s of ["+", "-"] as const) {
    seams.push({ id: `shoulder${s}`, a: side("back", `shoulder${s}`), b: side(`front${s}`, "shoulder") });
    if (!style.hood) continue;
    seams.push(
      // hood neck (centre front → shoulder) ↔ front neckline (shoulder → centre front)
      { id: `neckFront${s}`, a: side(`hood${s}`, "neckFront"), b: side(`front${s}`, "neck", true) },
      // hood neck (shoulder → nape) ↔ back neckline (shoulder → centre back), same direction
      // on both sides: mirroring reverses both edges.
      { id: `neckBack${s}`, a: side(`hood${s}`, "neckBack"), b: side("back", `neck${s}`) },
    );
  }
  if (style.hood) {
    seams.push({ id: "hood", a: side("hood+", "back"), b: side("hood-", "back", true) });
    // Match mark half-way up the hood seam, on both halves.
    pieces[3].notches.push({ edge: "back", t: 0.5, count: 1 });
    pieces[4].notches.push({ edge: "back", t: 0.5, count: 1 });
  }

  return {
    kind: "cape",
    name: style.name,
    pieces,
    seams,
    handles: [...bp.handles, ...fp.handles, ...(style.hood ? hp.handles : [])],
    dims: [
      { label: "Longueur", value: L },
      { label: "Encolure", value: 2 * (nf + nb) },
      { label: "Tour du bas", value: 2 * (polylineLength(backPlus[0].pts) + polylineLength(frontEdges[0].pts)) },
      ...(style.hood
        ? [
            { label: "Hauteur capuche", value: Math.max(T[1], P[1]) },
            { label: "Profondeur capuche", value: Math.max(K[0], P[0]) },
            { label: "Couture capuche", value: polylineLength(backSeam) },
          ]
        : []),
    ],
    sizeNote: `longueur ${L.toFixed(0)} cm · encolure ${neckline.toFixed(0)} cm`,
    checks: [
      ...(style.hood
        ? ([
            { seam: "neckFront+", label: "Encolure devant", kind: "match" },
            { seam: "neckBack+", label: "Encolure dos", kind: "match" },
          ] as const)
        : []),
      { seam: "shoulder+", label: "Épaule", kind: "match" },
    ],
    sim: {
      // ~11 000 vertices on the GPU instead of ~58 000 at the t-shirt's resolution; a capelet
      // is a fifth of the cloth, and gets a finer mesh.
      spacingScale: L < 70 ? 1.4 : 2.2,
      fallRoom: 2,
      // The flat circle swings down from the shoulders like a pendulum: overdamped, it
      // reaches the vertical without overshooting, so the hem does not whip in under
      // the cape and get trapped (terminal speed g / damping ≈ 1.6 m/s).
      damping: 6,
      duration: 8,
      // Let it reach the floor-length drape (~2 s) before the arms move: walking mid-fall
      // traps it between the swinging arm and the hip, where it gets crushed.
      settleTime: 3,
    },
  };
}
