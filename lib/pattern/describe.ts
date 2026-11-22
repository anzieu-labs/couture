import { validBelts, BELT_STRETCH } from "./belt";
import { nearestEnds, validClasps } from "./clasp";
import { polylineLength, resample, spline, type P2 } from "./curves";
import { copyFree, draftFree, edgePoints, hoodPiece, isFlat, isHood, shapeOf, type FreeCurve, type FreePattern, type FreePiece, type FreeSeam } from "./free";
import { garmentDef } from "./garments";
import { NO_EDITS, type Belt, type BodyMeasures, type Clasp, type Zone } from "./types";
import { patternIssues } from "./validate";

/**
 * A pattern from a description: the user tells the garment in words, a language model draws it
 * (app/api/pattern/route.ts) and what it draws becomes a drawn pattern (free.ts) — pieces,
 * points, curves, seams — the user can go on editing.
 *
 * The model is not asked for a FreePattern as it is kept, but for a sketch: the same pieces
 * with nothing in them a model gets wrong for no reason — a curve is the points its edge goes
 * through (not a shape in the edge's frame), a seam is two edges (which way they are sewn is
 * worked out from where they are worn: seamDirection). It is shown what a sketch looks like on
 * two drafts of the catalogue, drawn on the very body the garment is for (describePrompt), and
 * told what is wrong with its answer when it cannot be sewn (readSketch's issues) to try again.
 *
 * Everything asked is drawn — a cape too: its pieces are laid flat on the shoulders and its hood
 * stands round the head (the zones of types.ts), a clasp closes it at the neck. The model is
 * shown the catalogue's cape drawn that way; left to wrap a cape's pieces round the trunk, it
 * sewed the hood on the chest.
 */

export interface SketchPoint {
  x: number;
  y: number;
}

export interface Sketch {
  name: string;
  /** A sentence or two for the user: what was drawn, what could not be. */
  note: string;
  pieces: {
    id: string;
    name: string;
    zone: Zone;
    /** Corners, counter-clockwise (cm). */
    points: SketchPoint[];
    /** As many as points: edge i goes from point i to the next; `via`, the points it bends through. */
    edges: { id: string; via: SketchPoint[] }[];
  }[];
  seams: { a: { piece: string; edge: string }; b: { piece: string; edge: string } }[];
  belts: { piece: string; edge: string; stretch: number }[];
  /** Two points fastened together once the garment is on, each told by how far along an edge it is (0 its start, 1 its end). */
  clasps: { a: { piece: string; edge: string; t: number }; b: { piece: string; edge: string; t: number } }[];
}

/** How long a description may be (characters): a garment, not a text to answer. */
export const DESCRIPTION_MAX = 600;

export const ZONE_IDS = ["front", "back", "armL", "armR", "hoodL", "hoodR", "capeFront", "capeBack"] as const satisfies readonly Zone[];
/** Sewn edges may differ by this much of their length (a sleeve cap's ease) before the pattern is said not to fit. */
const SEAM_FIT = 0.1;
/** How far from a parabola (cm) a draft's curve may be to be told by its middle point alone. */
const PARABOLA_FIT = 0.25;
/** The least room a hood leaves above and behind the head, and a cape's neckline round the neck (cm). */
const ROOM = { hoodHeight: 4, hoodDepth: 2, neck: 0 };
const round = (v: number) => Math.round(v * 10) / 10;
const toP2 = (p: SketchPoint): P2 => [p.x, p.y];
const toPoint = ([x, y]: P2): SketchPoint => ({ x: round(x), y: round(y) });

/** The curve of an edge from a to b through `via`. */
function curveOf(a: P2, b: P2, via: P2[]): FreeCurve | undefined {
  if (!via.length) return undefined;
  if (via.length === 1) return { mid: via[0] };
  return shapeOf(spline([a, ...via, b]));
}

/** The points a drawn edge is told by: none when straight, its middle when it bends once, three along it otherwise. */
function viaOf(pts: P2[]): P2[] {
  if (pts.length < 3) return [];
  const a = pts[0], b = pts[pts.length - 1];
  const [, q1, half, q3] = resample(pts, 4);
  const parabola = edgePoints(a, b, { mid: half });
  const n = parabola.length - 1;
  const along = resample(pts, n);
  const off = Math.max(...along.map((p, i) => Math.hypot(p[0] - parabola[i][0], p[1] - parabola[i][1])));
  return off <= PARABOLA_FIT ? [half] : [q1, half, q3];
}

/** A drawn pattern as a sketch (what the model is shown). */
export function sketchOf(free: FreePattern, belts: readonly Belt[], clasps: readonly Clasp[], name: string, note: string): Sketch {
  return {
    name,
    note,
    pieces: free.pieces.map((piece) => {
      const n = piece.points.length;
      return {
        id: piece.id,
        name: piece.name,
        zone: piece.zone,
        points: piece.points.map(toPoint),
        edges: piece.edges.map((e, i) => ({ id: e.id, via: viaOf(edgePoints(piece.points[i], piece.points[(i + 1) % n], e.curve)).map(toPoint) })),
      };
    }),
    seams: free.seams.map((s) => ({ a: s.a, b: s.b })),
    belts: belts.map((b) => ({ ...b })),
    clasps: clasps.map(({ a, b }) => ({ a: { piece: a.piece, edge: a.edge, t: a.t }, b: { piece: b.piece, edge: b.edge, t: b.t } })),
  };
}

const area = (pts: P2[]) => pts.reduce((s, a, i) => s + a[0] * pts[(i + 1) % pts.length][1] - a[1] * pts[(i + 1) % pts.length][0], 0) / 2;

/**
 * Whether the second edge of a seam is sewn against its direction: both edges are drawn where
 * they are worn (the front and the back as seen from the front, a sleeve from its top down),
 * so the ends that meet are those at the same height — or, for edges that lie flat (a
 * shoulder, a waist), on the same side. A hood's neck edge on a neckline is drawn in another
 * frame (from the face to the nape): its end nearer the face goes to the middle of the front,
 * its end nearer the nape to the middle of the back.
 */
function seamDirection(a: [P2, P2], b: [P2, P2], zoneA: Zone, zoneB: Zone): boolean {
  if (isHood(zoneA) !== isHood(zoneB)) {
    const [hood, trunk, zone] = isHood(zoneA) ? [a, b, zoneB] : [b, a, zoneA];
    const faceFirst = Math.abs(hood[0][0]) < Math.abs(hood[1][0]);
    const middleFirst = Math.abs(trunk[0][0]) < Math.abs(trunk[1][0]);
    return zone === "back" || zone === "capeBack" ? faceFirst === middleFirst : faceFirst !== middleFirst;
  }
  const steep = ([p, q]: [P2, P2]) => Math.abs(q[1] - p[1]) > 0.3 * Math.hypot(q[0] - p[0], q[1] - p[1]);
  const axis = steep(a) && steep(b) ? 1 : 0;
  return (a[1][axis] - a[0][axis]) * (b[1][axis] - b[0][axis]) < 0;
}

export interface SketchReading {
  free: FreePattern;
  belts: Belt[];
  clasps: Clasp[];
  /** What is wrong with the sketch, in words the model (and the user) can act on; empty when it can be sewn as it is. */
  issues: string[];
  /** Whether it can be worn at all despite its issues: its pieces have a shape. */
  usable: boolean;
}

/** A sketch as a drawn pattern, put right where it can be (ids, the way round, the seams' direction), and what is wrong with it. */
export function readSketch(sketch: Sketch, m: BodyMeasures): SketchReading {
  const issues: string[] = [];
  const pieceIds = new Set<string>();
  const pieces: FreePiece[] = [];
  // Pieces told clockwise, turned round: what is told along their edges (a clasp) is turned with them.
  const turned = new Set<string>();
  for (const [k, piece] of sketch.pieces.entries()) {
    let id = piece.id.trim() || `piece${k + 1}`;
    while (pieceIds.has(id)) id += "'";
    pieceIds.add(id);
    if (piece.points.length < 3) {
      issues.push(`Pièce « ${id} » : il faut au moins 3 points.`);
      continue;
    }
    if (piece.edges.length !== piece.points.length) issues.push(`Pièce « ${id} » : ${piece.points.length} points mais ${piece.edges.length} bords (il en faut autant).`);
    let points = piece.points.map(toP2);
    const n = points.length;
    const edgeIds = new Set<string>();
    let edges = points.map((_, i) => {
      let edge = piece.edges[i]?.id.trim() || `bord${i + 1}`;
      while (edgeIds.has(edge)) edge += "'";
      edgeIds.add(edge);
      return { id: edge, via: (piece.edges[i]?.via ?? []).map(toP2) };
    });
    // Drawn clockwise: the same outline, told the other way round.
    if (area(points) < 0) {
      turned.add(id);
      points = points.slice().reverse();
      edges = edges.map((_, j) => {
        const e = edges[(2 * n - 2 - j) % n];
        return { id: e.id, via: e.via.slice().reverse() };
      });
    }
    if (points.some(([x, y]) => !(Math.abs(x) <= 150) || !(y <= 60) || !(y >= -m.hpsToFloor - 20)))
      issues.push(`Pièce « ${id} » : des points sont hors du corps (x de −150 à 150 cm, y de ${Math.round(-m.hpsToFloor)} à 60 cm).`);
    pieces.push({
      id,
      name: piece.name.trim() || id,
      zone: ZONE_IDS.includes(piece.zone) ? piece.zone : "front",
      points,
      edges: edges.map((e, i) => {
        const curve = curveOf(points[i], points[(i + 1) % n], e.via);
        return { id: e.id, ...(curve && { curve }) };
      }),
    });
  }

  const ends = (side: { piece: string; edge: string }): { at: [P2, P2]; zone: Zone } | null => {
    const piece = pieces.find((p) => p.id === side.piece);
    const i = piece?.edges.findIndex((e) => e.id === side.edge) ?? -1;
    return piece && i >= 0 ? { at: [piece.points[i], piece.points[(i + 1) % piece.points.length]], zone: piece.zone } : null;
  };
  const sewn = new Set<string>();
  const seams: FreeSeam[] = [];
  for (const s of sketch.seams) {
    const a = ends(s.a), b = ends(s.b);
    const told = `${s.a.piece}/${s.a.edge} ↔ ${s.b.piece}/${s.b.edge}`;
    if (!a || !b) {
      issues.push(`Couture ${told} : ce bord n'existe pas.`);
      continue;
    }
    const ka = `${s.a.piece}/${s.a.edge}`, kb = `${s.b.piece}/${s.b.edge}`;
    if (ka === kb || sewn.has(ka) || sewn.has(kb)) {
      issues.push(`Couture ${told} : un bord ne peut être cousu qu'une fois, et pas à lui-même.`);
      continue;
    }
    sewn.add(ka).add(kb);
    seams.push({ a: s.a, b: s.b, reverse: seamDirection(a.at, b.at, a.zone, b.zone) });
  }

  const free: FreePattern = { pieces, seams, next: 1 };
  const usable = pieces.length > 0;
  if (!usable) return { free, belts: [], clasps: [], issues: issues.length ? issues : ["Aucune pièce."], usable };

  const pattern = draftFree(free, NO_EDITS);
  const outlines = patternIssues(pattern);
  issues.push(...outlines.map((i) => i.message));
  const lengthOf = (side: { piece: string; edge: string }) => polylineLength(pattern.pieces.find((p) => p.id === side.piece)!.edges.find((e) => e.id === side.edge)!.pts);
  for (const s of seams) {
    const la = lengthOf(s.a), lb = lengthOf(s.b);
    if (Math.abs(la - lb) > SEAM_FIT * Math.max(la, lb))
      issues.push(`Couture ${s.a.piece}/${s.a.edge} ↔ ${s.b.piece}/${s.b.edge} : ${la.toFixed(1)} cm contre ${lb.toFixed(1)} cm — deux bords cousus doivent avoir la même longueur.`);
  }
  // What is worn on the head or round the neck must go round it.
  for (const piece of pattern.pieces.filter((p) => p.zone && isHood(p.zone))) {
    const pts = piece.edges.flatMap((e) => e.pts);
    // Its height, and its depth where the head is deepest: half-way up the head.
    const high = Math.max(...pts.map((q) => q[1])), level = m.headHeight / 2;
    const across: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if ((a[1] - level) * (b[1] - level) < 0) across.push(Math.abs(a[0] + ((level - a[1]) / (b[1] - a[1])) * (b[0] - a[0])));
    }
    const deep = across.length ? Math.max(...across) - Math.min(...across) : 0;
    // One free edge, round the face: a second one is a seam forgotten (the top left open).
    const free = piece.edges.filter((e) => e.allowance !== "seam").map((e) => `« ${e.id} »`);
    if (free.length > 1)
      issues.push(`Pièce « ${piece.id} » : les bords ${free.join(", ")} ne sont cousus à rien — une moitié de capuche n'a qu'un bord libre, celui du visage ; les autres se cousent à l'encolure ou à l'autre moitié.`);
    if (high < m.headHeight + ROOM.hoodHeight || deep < m.headDepth + ROOM.hoodDepth)
      issues.push(
        `Pièce « ${piece.id} » : la capuche (${high.toFixed(0)} cm de haut, ${deep.toFixed(0)} cm de profondeur à mi-hauteur de la tête, y = ${level.toFixed(0)}) est trop petite pour la tête — au moins ${Math.ceil(m.headHeight + ROOM.hoodHeight)} cm de haut, et ${Math.ceil(m.headDepth + ROOM.hoodDepth)} cm de profondeur à cette hauteur : gardez la forme ronde de l'exemple jusqu'au sommet de la tête, la pointe vient au-dessus.`,
      );
  }
  const flat = pattern.pieces.filter((p) => p.zone && isFlat(p.zone)).flatMap((p) => p.edges.flatMap((e) => e.pts));
  if (flat.length) {
    const inner = Math.min(...flat.map((q) => Math.hypot(q[0], q[1]))), least = (m.neck + ROOM.neck) / (2 * Math.PI);
    if (inner < least) issues.push(`Cape : son encolure (rayon ${inner.toFixed(1)} cm autour de l'origine) est trop serrée pour le cou — au moins ${least.toFixed(1)} cm de rayon.`);
  }
  const asked = sketch.belts.map((b): Belt => ({ piece: b.piece, edge: b.edge, stretch: Math.min(BELT_STRETCH.max, Math.max(BELT_STRETCH.min, b.stretch)) }));
  const belts = validBelts(pattern, asked).map((v) => v.belt);
  if (belts.length < asked.length) issues.push("Une ceinture doit suivre un bord libre (non cousu) qui fait le tour du vêtement.");
  const at = (p: Sketch["clasps"][number]["a"]) => {
    const t = Math.min(1, Math.max(0, p.t));
    return { piece: p.piece, edge: p.edge, t: turned.has(p.piece) ? 1 - t : t, offset: [0, 0] as P2 };
  };
  const fastened = sketch.clasps.map((c) => nearestEnds(pattern, { a: at(c.a), b: at(c.b) }));
  const clasps = validClasps(pattern, fastened);
  if (clasps.length < fastened.length) issues.push("Un fermoir relie deux points de bords qui existent, à deux endroits différents.");
  return { free, belts, clasps, issues, usable: usable && outlines.length === 0 };
}

const cm = (v: number) => v.toFixed(1);

/** What the model is told before the description: how a sketch is drawn, the body, two sketches of it. */
export function describePrompt(m: BodyMeasures): string {
  const drawn = (id: string) => {
    const def = garmentDef(id);
    return { def, drafted: def.draft(m, def.defaults, NO_EDITS) };
  };
  const example = (id: string, note: string) => {
    const { def, drafted } = drawn(id);
    return JSON.stringify(sketchOf(copyFree(drafted, m), def.belts ?? [], def.clasps ?? [], def.name, note));
  };
  // A hood for the t-shirt shown: its neck edges as long as the neckline's they are sewn to.
  const neckOf = (piece: string) => polylineLength(drawn("tshirt.homme").drafted.pieces.find((p) => p.id === piece)!.edges.find((e) => e.id === "neck+")!.pts);
  const halves = (["hoodL", "hoodR"] as const).map((zone) => hoodPiece(zone, zone === "hoodL" ? "Capuche gauche" : "Capuche droite", zone, m, neckOf("front"), neckOf("back")));
  const hood = sketchOf({ pieces: halves, seams: [], next: 1 }, [], [], "", "");
  const hoodExample = JSON.stringify({
    pieces: hood.pieces,
    seams: [
      ...(["L", "R"] as const).flatMap((side) => {
        const neck = side === "L" ? "neck+" : "neck-";
        return [
          { a: { piece: `hood${side}`, edge: "neckFront" }, b: { piece: "front", edge: neck } },
          { a: { piece: `hood${side}`, edge: "neckBack" }, b: { piece: "back", edge: neck } },
        ];
      }),
      { a: { piece: "hoodL", edge: "back" }, b: { piece: "hoodR", edge: "back" } },
    ],
  });
  return `You are a pattern maker. You draw the flat sewing pattern of the garment the user describes, for one body, as JSON. The pattern is then cut, sewn and draped on that body by a cloth simulation, so it must be a real pattern: pieces of the right size whose sewn edges match.

# How a pattern is drawn

Lengths are in centimetres. A pattern is a list of pieces. A piece is a closed outline: its corner points in counter-clockwise order, and as many edges as points — edge i goes from point i to point i+1 (the last one back to point 0). An edge is straight when "via" is empty; otherwise it is a smooth curve through the points of "via", given in order from its start to its end (one point for a simple bend, three for an S or an armhole). Edge ids are unique within a piece.

A piece is drawn where it is worn. Its "zone" says on what part of the body, and its coordinates where:
- "front" and "back": wrapped round the trunk. x runs across the body from its middle (x = 0 is the centre front or centre back), y runs up, and y = 0 is the shoulder line at the side of the neck — so the chest is at about y = -${cm(m.hpsToArmpit)}, the waist at y = -${cm(m.hpsToWaist)}, the hips at y = -${cm(m.hpsToWaist + m.waistToHip)}, the knees at y = -${cm(m.hpsToWaist + m.waistToKnee)}, the floor at y = -${cm(m.hpsToFloor)}. Both are drawn as seen from the front: x > 0 is the same side of the body on the front and on the back (the wearer's left), so a front and a back sewn together have the same outline where they meet. A piece usually spans both sides (from -x to +x).
- "armL" (the arm on the x > 0 side) and "armR": wrapped round that arm. x runs across the sleeve from the line on top of the arm, y runs up and y = 0 is the top of the shoulder — the elbow is at about y = -${cm(m.armLength * 0.52)}, the wrist at y = -${cm(m.armLength)}. On both sleeves the front half of the cap is on the x > 0 side.
- "hoodL" (on the x > 0 side) and "hoodR": the two halves of a hood, standing on either side of the head. x runs from the face opening (x = 0) towards the back of the head (only its distance from x = 0 counts: a half may be drawn mirrored), y runs up and y = 0 is the shoulder line — the top of the head is at y = ${cm(m.headHeight)}, and the head is ${cm(m.headDepth)} deep.
- "capeFront" and "capeBack": the pieces of a cape, laid flat on the shoulders round the neck, as a cape is cut — sectors of a ring. The origin is the neck's axis, x runs across the body, and the piece is drawn below the x axis (y < 0): on a "capeBack" piece that is towards the back, on a "capeFront" piece towards the front. The neckline is the inner arc, the hem the outer one, and the cape's length is the difference of their radii. The shoulder line is the x axis, where the back and the fronts are sewn together.
There is nothing for the legs: no trousers. A skirt or a dress covers the legs as one tube.

A seam joins two edges of about the same length (within 5 %): {"a": {"piece", "edge"}, "b": {"piece", "edge"}}. Which way the two edges are sewn is worked out for you from where they are drawn. An edge is sewn at most once; an edge in no seam is a free edge (a hem, a neckline).

The garment must hold on the body: it hangs from the shoulders (shoulder seams, straps), or it has a belt. A belt ({"piece", "edge", "stretch"}) runs along a free edge and on round the garment through the seams — a waist. "stretch" 0 is a waistband that does not give; a negative value gathers the cloth (-0.2: an elastic 20 % shorter than the edge), from ${BELT_STRETCH.min} to ${BELT_STRETCH.max}. A skirt needs one at its waist, drawn at the waist's size.

A clasp fastens two points of the garment together once it is on: {"a": {"piece", "edge", "t"}, "b": {"piece", "edge", "t"}}, each point told by how far along an edge it is ("t": 0 at the edge's start, 1 at its end). A cape open down the front needs one at the neck, or it slides off the shoulders.

Sizes: round the body, the front and back together must be the body's girth plus ease there (bust ${cm(m.bust)}, waist ${cm(m.waist)}, hips ${cm(m.hips)}): about 4 cm of ease for a close fit, 10 for a regular one, 20 or more for a loose one. Never smaller than the body unless the user asks for a tight stretch garment. A sleeve is the arm's girth (${cm(m.upperArm)} at the upper arm) plus ease; its cap edges are as long as the armhole edges they are sewn to. Nothing goes lower than y = -${cm(m.hpsToFloor - 22)}: a hem nearer the floor is trodden on.

# The body (cm)

${JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v as number)])))}
(hps: the high point of the shoulder, at the side of the neck; every "hpsTo…" is a height below it.)

# Three patterns drawn for this body

A t-shirt:
${example("tshirt.homme", "T-shirt droit à manches courtes.")}

A skirt, held by a belt at its waist:
${example("skirt.femme", "Jupe évasée tenue par une ceinture à la taille.")}

A hooded cape — a full circle open down the front (the two "capeFront" quarters stop short of the centre front), held by the shoulder seams, the hood sewn to its neckline, and a clasp at the neck:
${example("cape.homme", "Cape à capuche en cercle complet, fermée au cou par un fermoir.")}
For another cape, change the radii (the neckline's stays the same, it is the neck's; the hem's is the neckline's plus the length: ${cm(m.hpsToWaist)} reaches the waist, ${cm(m.hpsToWaist + m.waistToHip + 15)} mid-thigh, ${cm(m.hpsToWaist + m.waistToKnee)} the knees, ${cm(m.hpsToFloor - 34)} mid-calf) and the hood; without a hood, leave the hood pieces and their seams out (the neckline is then a free edge).

A hood, to add to a top: these two pieces and five seams go with the t-shirt above (its neckline is then sewn all round, to the hood):
${hoodExample}
Each half has two edges along its neck (y = 0) — "neckFront", from the face opening, as long as the front's neck edge on its side, and "neckBack", as long as the back's —, a "back" edge that goes up behind the head and over it, sewn to the other half's, and a free "face" edge. Change the neck edges' lengths with the neckline's; make it deeper or higher for a loose hood, and for a pointed one keep this round shape up to the top of the head and draw the point above it or behind it. A half has one free edge, round the face; every other edge is sewn — to the neckline, or to the other half's same edge (if you draw the top as an edge of its own, sew it too). A hood is never smaller than this one: at least ${cm(m.headHeight + 6)} high and ${cm(m.headDepth + 8)} deep, or the head does not fit.

# What to answer

The pattern of the garment described, in the same form: start from the nearest of those above, keep its edge names (hem+, side+, arm+, shoulder+, neck+, waist+…; "+" for the x > 0 half, "-" for the other) and change the sizes, the shapes, the pieces. A sleeveless garment has no sleeve pieces and its armhole edges are free. A dress is a t-shirt going down to the knees or lower, widening to pass the hips. Keep it simple: at most 8 pieces, no darts, no pockets, no lining.

"name": a short name for the garment, in French. "note": one or two sentences in French for the user, saying what you drew and, if something in the description cannot be drawn this way (trousers, a hood, buttons…), what you left out or drew instead.`;
}

/**
 * What the model is asked when a garment is to be changed, not drawn anew: the pattern as it
 * is (a sketch of the drawing being worn) and the change wanted.
 */
export const changePrompt = (base: Sketch, change: string) =>
  `The garment as it is now:\n${JSON.stringify({ ...base, note: "" })}\n\nThe change asked: ${change}\n\nAnswer with the whole pattern, changed as asked and otherwise identical: every piece, point, "via" point, edge id, seam, belt and clasp the change does not touch is copied as it is — same ids, same numbers. If the change cannot be drawn, answer with the pattern unchanged and say why in the note. The note says in French what was changed.`;

/** The pieces of a sketch that are those of another, as they were: same zone, same points, same edges through the same points. */
export function unchangedPieces(base: Sketch, sketch: Sketch): string[] {
  const near = (a: SketchPoint, b: SketchPoint) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;
  const alike = (a: SketchPoint[], b: SketchPoint[]) => a.length === b.length && a.every((p, i) => near(p, b[i]));
  return sketch.pieces
    .filter((piece) => {
      const was = base.pieces.find((p) => p.id === piece.id);
      return !!was && was.zone === piece.zone && alike(was.points, piece.points) && was.edges.length === piece.edges.length && was.edges.every((e, i) => e.id === piece.edges[i].id && alike(e.via, piece.edges[i].via));
    })
    .map((piece) => piece.id);
}

/** What the model is told when its sketch cannot be sewn as it is. */
export const retryPrompt = (issues: string[]) =>
  `This pattern cannot be sewn as it is (lengths are measured along the curves as drawn):\n${issues.map((i) => `- ${i}`).join("\n")}\nAnswer with the whole pattern again, corrected: move the points or the "via" points of the edges named so that the lengths match, and change nothing else. The note is for the user: say what the garment is, not what you corrected.`;
