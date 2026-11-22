import { cubic, polylineLength, type P2 } from "./curves";
import { mirror, NO_EDITS, PointSet, type Belt, type BodyMeasures, type Edge, type Pattern, type PatternEdits, type Piece, type Seam } from "./types";

/**
 * A-line skirt: a front and a back, each symmetric (can be cut on the fold),
 * joined by two side seams. No darts: the waist-to-hip difference is taken in the
 * side seam, which curves in from the fullest hip to the waist; below the hip it
 * flares out to the hem. The hem rises towards the side so that it meets the
 * flared side seam at a right angle (an even hem once sewn).
 *
 * Coordinates (cm): x across (the wearer's left is +x), y up, origin at the
 * centre of the waist. Placed around the body row by row (lib/garment/place.ts).
 */

export interface SkirtParams {
  /** Waist → hem at the centre (cm); 0 = automatic (just below the knee). */
  length: number;
  /** Total ease at the waist and at the hips (cm). */
  waistEase: number;
  hipEase: number;
  /** Extra width at the hem, each side of each panel (cm). */
  flare: number;
}

/**
 * The belt a skirt comes with (types.ts Belt): a rigid waistband along its waist. Without it
 * nothing but the stretch of the fabric keeps the waist from opening, and the skirt slides
 * over the hips; the more elastic, the lower it sits. Like any belt, it is changed or taken
 * off in the 2D editor.
 */
export const SKIRT_BELTS: readonly Belt[] = [{ piece: "front", edge: "waist+", stretch: 0 }];

export const DEFAULT_SKIRT: SkirtParams = { length: 0, waistEase: 2, hipEase: 4, flare: 9 };

export const skirtAutoLength = (m: BodyMeasures) => Math.round(m.waistToKnee + 4);
/**
 * A long skirt's automatic length: above the ankle. Not lower: the skirt sits some 6 cm under
 * the natural waist once worn, and a hem that reaches the floor is trodden on at the first
 * step (10 cm above the floor as drafted: 875 crossings and the cloth stretched by 60 to 95 %).
 */
export const longSkirtAutoLength = (m: BodyMeasures) => Math.round(m.waistToFloor - 26);

/** What makes a garment of this block: its name and its length when left automatic. */
export interface SkirtStyle {
  name: string;
  autoLength: (m: BodyMeasures) => number;
}

export const SKIRT: SkirtStyle = { name: "Jupe trapèze", autoLength: skirtAutoLength };

function panel(kind: "front" | "back", m: { W: number; Hh: number; hd: number; L: number; flare: number; cw: number }, edits: PatternEdits) {
  const { W, Hh, hd, L, flare, cw } = m;
  const P = new PointSet(kind, kind, edits);
  // Side seam: waist corner raised a little (hip curve), straight from the hip to the hem.
  const CW = P.anchor("CW", "Milieu taille", [0, -cw], "vertical");
  const WS0: P2 = [W, 0.8], HS0: P2 = [Hh, -hd], HE0: P2 = [Hh + flare, -L + (flare * flare) / (2 * L) + flare * 0.15];
  const WS = P.anchor("WS", "Taille · côté", WS0);
  const HS = P.anchor("HS", "Hanche", HS0);
  const HE = P.anchor("HE", "Côté · bas", HE0);
  const CH = P.anchor("CH", "Milieu bas", [0, -L], "vertical");
  // Hip curve: vertical at the hip, leaning in towards the waist.
  const s1b: P2 = [Hh, -hd + 0.45 * hd], s2b: P2 = [W + 0.35 * (Hh - W), 0.8 - 0.25 * hd];
  const s1 = P.control("s1", "Courbe de hanche", s1b, HS0, HS);
  const s2 = P.control("s2", "Courbe de hanche", s2b, WS0, WS);
  // Unit vector turned a quarter turn counter-clockwise.
  const perp = (a: P2, b2: P2): P2 => {
    const dx = b2[0] - a[0], dy = b2[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  // Waist: horizontal at the centre, leaving the side seam square to it.
  const wd = perp(s2b, WS0); // side seam arriving at the waist corner, turned: towards the centre
  const w1 = P.control("w1", "Courbe de taille", [WS0[0] + 0.3 * W * wd[0], WS0[1] + 0.3 * W * wd[1]], WS0, WS);
  const w2 = P.control("w2", "Courbe de taille", [0.5 * W, -cw], [0, -cw], CW, "horizontal");
  // Hem: horizontal at the centre, square to the flared side seam at the side.
  const hd2 = perp(HS0, HE0); // side seam going down, turned: the hem's direction arriving at the side
  const k = 0.3 * (Hh + flare);
  const h1 = P.control("h1", "Courbe du bas", [0.5 * (Hh + flare), -L], [0, -L], CH, "horizontal");
  const h2 = P.control("h2", "Courbe du bas", [HE0[0] - k * hd2[0], HE0[1] - k * hd2[1]], HE0, HE);
  const hem = cubic(CH, h1, h2, HE);
  const side = [HE, ...cubic(HS, s1, s2, WS)];
  const waist = cubic(WS, w1, w2, CW);
  const plus: Edge[] = [
    { id: "hem+", pts: hem, allowance: "hem" },
    { id: "side+", pts: side, allowance: "seam" },
    { id: "waist+", pts: waist, allowance: "seam" },
  ];
  const minus: Edge[] = plus.map((e) => ({ ...e, id: e.id.replace("+", "-"), pts: mirror(e.pts) })).reverse();
  const hipT = polylineLength([HE, HS]) / polylineLength(side);
  return { edges: [...plus, ...minus], handles: P.handles, WS, HS, HE, CH, CW, side, hipT, waist };
}

export function draftSkirt(b: BodyMeasures, p: SkirtParams = DEFAULT_SKIRT, edits: PatternEdits = NO_EDITS, style: SkirtStyle = SKIRT): Pattern {
  const L = p.length > 0 ? p.length : style.autoLength(b);
  const W = (b.waist + p.waistEase) / 4;
  const Hh = Math.max(W, (b.hips + p.hipEase) / 4);
  const hd = Math.min(b.waistToHip, L - 5);
  // The back waist dips a little at the centre (over the small of the back), the front not.
  const front = panel("front", { W, Hh, hd, L, flare: p.flare, cw: 0 }, edits);
  const back = panel("back", { W, Hh, hd, L, flare: p.flare, cw: 1 }, edits);

  const piece = (id: "front" | "back", name: string, d: ReturnType<typeof panel>): Piece => ({
    id,
    name,
    edges: d.edges,
    grain: [[0, -4], [0, -L + 6]],
    notches: [
      { edge: "waist+", t: 1, count: 1 },
      { edge: "hem+", t: 0, count: 1 },
      { edge: "side+", t: d.hipT, count: id === "front" ? 1 : 2 },
      { edge: "side-", t: 1 - d.hipT, count: id === "front" ? 1 : 2 },
    ],
    quantity: 1,
    symmetric: true,
    label: [-Hh / 2, -(hd + L) / 2],
  });
  const pieces = [piece("front", "Devant", front), piece("back", "Dos", back)];
  const seams: Seam[] = (["+", "-"] as const).map((s) => ({
    id: `side${s}`,
    a: { piece: "front", edge: `side${s}`, reverse: false },
    b: { piece: "back", edge: `side${s}`, reverse: false },
  }));

  const waist = 2 * (polylineLength(front.waist) + polylineLength(back.waist));
  const hem = 2 * (polylineLength(pieces[0].edges[0].pts) + polylineLength(pieces[1].edges[0].pts));
  const length = -front.CH[1] + front.CW[1];
  return {
    kind: "skirt",
    name: style.name,
    pieces,
    seams,
    handles: [...front.handles, ...back.handles],
    dims: [
      { label: "Tour de taille", value: waist },
      { label: "Tour de hanches", value: 2 * (front.HS[0] + back.HS[0]) },
      { label: "Tour du bas", value: hem },
      { label: "Longueur", value: length },
      { label: "Taille → hanche", value: hd },
      { label: "Évasement", value: front.HE[0] - front.HS[0] },
    ],
    sizeNote: `taille ${waist.toFixed(0)} cm · longueur ${length.toFixed(0)} cm`,
    checks: [{ seam: "side+", label: "Côté", kind: "match" }],
  };
}
