import type { P2 } from "../curves";
import { shapeOf, type FreePattern, type FreePiece } from "../free";
import type { BodyMeasures, Zone } from "../types";

/**
 * Reads the pieces of a pattern from an AAMA or ASTM D6673 DXF file (ASCII; what Gerber,
 * Lectra, Optitex, CLO… and lib/pattern/export/dxf.ts write) into a drawing (lib/pattern/
 * free.ts FreePattern).
 *
 * Such a file holds one BLOCK per piece — or the pieces loose in the ENTITIES section — on
 * numbered layers: 1 the cut line, 14 the sew line, 2 the turn points (corners), 3 the curve
 * points, 4 the notches, 7 the grain line, and texts ("Piece Name: …"). A piece is drawn from
 * its sew line when there is one (the pattern that is simulated is the net one), else from
 * its cut line; its corners are the turn points, or where its outline turns sharply.
 *
 * What a DXF does not say is how the pieces are sewn together and where each is worn: they
 * come in unsewn, each on the zone its name suggests, to be put right in the editor.
 */

export type DxfUnits = "auto" | "mm" | "cm" | "in";

export interface DxfImport {
  free: FreePattern;
  /** The unit the file was read in, and whether it was told by the file or guessed from the sizes. */
  units: Exclude<DxfUnits, "auto">;
  guessed: boolean;
  /** The outline the pieces were drawn from. */
  line: "sew" | "cut" | "other";
  pieces: { name: string; width: number; height: number; points: number }[];
}

const TO_CM = { mm: 0.1, cm: 1, in: 2.54 };

interface Entity {
  type: string;
  layer: string;
  /** Every value of every group code, in order. */
  codes: Map<number, string[]>;
  /** POLYLINE: its vertices. */
  vertices: Entity[];
}

const num = (e: Entity, code: number, k = 0) => Number(e.codes.get(code)?.[k] ?? 0);
const str = (e: Entity, code: number) => e.codes.get(code)?.[0] ?? "";

/** The groups of entities of a file: one per block, and the loose entities of model space (name ""). */
function parse(text: string): { groups: Map<string, Entity[]>; header: Map<string, number> } {
  const lines = text.split(/\r\n|\r|\n/);
  const groups = new Map<string, Entity[]>([["", []]]);
  const header = new Map<string, number>();
  let section = "", block = "", variable = "";
  let entity: Entity | null = null, polyline: Entity | null = null;
  const end = () => {
    if (!entity) return;
    if (entity.type === "VERTEX" && polyline) polyline.vertices.push(entity);
    else if (entity.type !== "SEQEND" && (section === "ENTITIES" || block)) groups.get(section === "ENTITIES" ? "" : block)!.push(entity);
    if (entity.type === "POLYLINE") polyline = entity;
    if (entity.type === "SEQEND") polyline = null;
    entity = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i], 10), value = lines[i + 1].trim();
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      end();
      if (value === "SECTION" || value === "ENDSEC" || value === "EOF") section = value === "SECTION" ? "?" : "";
      else if (value === "BLOCK") block = "?";
      else if (value === "ENDBLK") block = "";
      else if (section === "ENTITIES" || (section === "BLOCKS" && block)) entity = { type: value, layer: "0", codes: new Map(), vertices: [] };
      continue;
    }
    if (section === "?" && code === 2) section = value;
    else if (section === "HEADER") {
      if (code === 9) variable = value;
      else if (variable) header.set(variable, Number(value));
    } else if (block === "?" && code === 2) {
      block = value || "?";
      if (!groups.has(block)) groups.set(block, []);
    } else if (entity) {
      if (code === 8) entity.layer = value;
      const list = entity.codes.get(code);
      if (list) list.push(value);
      else entity.codes.set(code, [value]);
    }
  }
  end();
  return { groups, header };
}

/** The points of an arc from a to b told by its bulge (the tangent of a quarter of its angle), a left out. */
function bulged(a: P2, b: P2, bulge: number): P2[] {
  if (!bulge) return [b];
  const angle = 4 * Math.atan(bulge), chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!chord) return [b];
  const radius = chord / (2 * Math.sin(angle / 2));
  // Centre: from the middle of the chord, across it.
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, off = radius * Math.cos(angle / 2);
  const cx = mx - ((b[1] - a[1]) / chord) * off, cy = my + ((b[0] - a[0]) / chord) * off;
  const from = Math.atan2(a[1] - cy, a[0] - cx), steps = Math.max(2, Math.ceil(Math.abs(angle) / 0.2));
  return Array.from({ length: steps }, (_, k) => {
    const t = from + (angle * (k + 1)) / steps;
    return [cx + Math.abs(radius) * Math.cos(t), cy + Math.abs(radius) * Math.sin(t)] as P2;
  });
}

interface Path {
  layer: string;
  pts: P2[];
  closed: boolean;
}

const near = (a: P2, b: P2, tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** The outlines of a group of entities: its polylines, and its loose lines joined end to end. */
function paths(entities: Entity[], tol: number): Path[] {
  const out: Path[] = [];
  const loose = new Map<string, [P2, P2][]>();
  for (const e of entities) {
    if (e.type === "POLYLINE" || e.type === "LWPOLYLINE") {
      const raw: { p: P2; bulge: number }[] =
        e.type === "POLYLINE"
          ? e.vertices.map((v) => ({ p: [num(v, 10), num(v, 20)], bulge: num(v, 42) }))
          : (e.codes.get(10) ?? []).map((x, k) => ({ p: [Number(x), num(e, 20, k)], bulge: 0 }));
      if (raw.length < 2) continue;
      const closed = (num(e, 70) & 1) === 1 || near(raw[0].p, raw[raw.length - 1].p, tol);
      const pts: P2[] = [raw[0].p];
      for (let k = 1; k < raw.length; k++) pts.push(...bulged(raw[k - 1].p, raw[k].p, raw[k - 1].bulge));
      if ((num(e, 70) & 1) === 1) pts.push(...bulged(raw[raw.length - 1].p, raw[0].p, raw[raw.length - 1].bulge));
      out.push({ layer: e.layer, pts, closed });
    } else if (e.type === "LINE") {
      const list = loose.get(e.layer) ?? loose.set(e.layer, []).get(e.layer)!;
      list.push([[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]]);
    } else if (e.type === "SPLINE") {
      // Its fit points when it has some, else its control points: near enough for an outline.
      const xs = e.codes.get(11)?.length ? [11, 21] : [10, 20];
      const pts = (e.codes.get(xs[0]) ?? []).map((x, k) => [Number(x), num(e, xs[1], k)] as P2);
      if (pts.length > 1) out.push({ layer: e.layer, pts, closed: (num(e, 70) & 1) === 1 || near(pts[0], pts[pts.length - 1], tol) });
    }
  }
  // Lines drawn one by one (an outline exploded): joined where an end meets an end.
  for (const [layer, segments] of loose) {
    const left = segments.slice();
    while (left.length) {
      const pts = [...left.pop()!];
      for (let grew = true; grew; ) {
        grew = false;
        for (let k = 0; k < left.length; k++) {
          const [a, b] = left[k], last = pts[pts.length - 1];
          if (near(a, last, tol)) pts.push(b);
          else if (near(b, last, tol)) pts.push(a);
          else continue;
          left.splice(k, 1);
          grew = true;
          break;
        }
      }
      if (pts.length > 2) out.push({ layer, pts, closed: near(pts[0], pts[pts.length - 1], tol) });
    }
  }
  return out;
}

const area = (pts: P2[]) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - a[1] * b[0];
  }
  return s / 2;
};

/** The angle an outline turns by at its vertex i (rad, 0: straight on). */
function turn(pts: P2[], i: number): number {
  const n = pts.length, a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]), v = Math.atan2(c[1] - b[1], c[0] - b[0]);
  return Math.abs(Math.atan2(Math.sin(v - u), Math.cos(v - u)));
}

/** Most corners a piece is given: past it, an outline is a jagged curve, not a polygon. */
const MOST_CORNERS = 40;

/** A closed outline (cm, its closing point left out) as a piece: corners, and edges that keep the outline's shape. */
function pieceOf(id: string, name: string, zone: Zone, loop: P2[], turns: P2[], nextEdge: number): FreePiece | null {
  let pts = loop.filter((p, i) => i === 0 || !near(p, loop[i - 1], 1e-4));
  if (pts.length > 1 && near(pts[0], pts[pts.length - 1], 1e-4)) pts = pts.slice(0, -1);
  if (pts.length < 3 || Math.abs(area(pts)) < 1) return null;
  if (area(pts) < 0) pts.reverse();
  const n = pts.length;
  // Corners: the turn points of the file that are on this outline; else where it turns sharply
  // (the sharpest ones); else, a round shape, its four extremes.
  let corners = [...new Set(turns.map((t) => pts.findIndex((p) => near(p, t, 0.2))).filter((i) => i >= 0))];
  if (corners.length < 3) {
    const sharp = pts.map((_, i) => i).filter((i) => turn(pts, i) > (30 * Math.PI) / 180);
    corners = sharp.sort((a, b) => turn(pts, b) - turn(pts, a)).slice(0, MOST_CORNERS);
  }
  if (corners.length < 3) {
    const extreme = (score: (p: P2) => number) => pts.reduce((best, p, i) => (score(p) > score(pts[best]) ? i : best), 0);
    corners = [...new Set([extreme((p) => -p[1]), extreme((p) => p[0]), extreme((p) => p[1]), extreme((p) => -p[0])])];
  }
  if (corners.length < 3) return null;
  corners.sort((a, b) => a - b);
  const edges = corners.map((from, k) => {
    const to = corners[(k + 1) % corners.length];
    const part: P2[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      part.push(pts[i]);
      if (i === to && part.length > 1) break;
    }
    const curve = shapeOf(part);
    return { id: `e${nextEdge + k}`, ...(curve && { curve }) };
  });
  return { id, name, zone, points: corners.map((i) => pts[i]), edges };
}

/** Where a piece is worn, from its name (French or English); the front when it says nothing. */
function zoneOf(name: string, sleeves: number): Zone {
  if (/manche|sleeve|bras|arm/i.test(name)) return sleeves % 2 ? "armR" : "armL";
  return /\bdos\b|back|arri[eè]re/i.test(name) ? "back" : "front";
}
const LOWER = /jupe|skirt|pantalon|pant|trouser|short|jambe|leg|taille|waist|ceinture/i;

/** The drawing of a DXF file (see the header); throws, with a message for the user, when no piece can be read. */
export function importDxf(text: string, units: DxfUnits, m: BodyMeasures): DxfImport {
  if (!/^\s*0\s*[\r\n]+\s*SECTION/m.test(text)) throw new Error("Ce fichier n'est pas un DXF texte (ASCII). Les DXF binaires ne sont pas lus.");
  const { groups, header } = parse(text);
  const all = [...groups.values()].flat();
  // Units: what the file says (its texts, then its header), else what the sizes suggest.
  const says = all.map((e) => (e.type === "TEXT" ? str(e, 1).match(/units?\s*:\s*(metric|english|mm|cm|inch)/i)?.[1].toLowerCase() : undefined)).find((u) => u);
  const told: DxfImport["units"] | undefined =
    units !== "auto" ? units
    : says ? (says === "english" || says === "inch" ? "in" : says === "cm" ? "cm" : "mm")
    : header.get("$INSUNITS") === 1 ? "in"
    : header.get("$INSUNITS") === 4 ? "mm"
    : header.get("$INSUNITS") === 5 ? "cm"
    : header.has("$MEASUREMENT") ? (header.get("$MEASUREMENT") ? "mm" : "in")
    : undefined;

  // The outlines, in the file's units: per block, the largest closed one of the best layer there is.
  const drawn: { name: string; loop: P2[]; turns: P2[]; line: DxfImport["line"]; quantity: number }[] = [];
  const pick = (found: Path[]): { list: Path[]; line: DxfImport["line"] } => {
    const closed = found.filter((p) => p.closed && p.pts.length > 3);
    for (const [layer, line] of [["14", "sew"], ["1", "cut"]] as const) {
      const list = closed.filter((p) => p.layer === layer);
      if (list.length) return { list, line };
    }
    return { list: closed, line: "other" };
  };
  for (const [block, entities] of groups) {
    if (!entities.length) continue;
    const extent = Math.max(1e-9, ...entities.flatMap((e) => [Math.abs(num(e, 10)), Math.abs(num(e, 20))]));
    const { list, line } = pick(paths(entities, extent * 1e-5));
    if (!list.length) continue;
    const label = entities.map((e) => (e.type === "TEXT" ? str(e, 1).match(/piece\s*name\s*:\s*(.+)/i)?.[1].trim() : undefined)).find((s) => s);
    const turns = entities.filter((e) => e.type === "POINT" && e.layer === "2").map((e) => [num(e, 10), num(e, 20)] as P2);
    const largest = (l: Path[]) => l.reduce((a, b) => (Math.abs(area(b.pts)) > Math.abs(area(a.pts)) ? b : a));
    // A block is one piece (its other loops are holes or marks); loose in model space, every outline is one.
    // "Quantity: 2": a piece cut twice (the sleeves) comes in twice, each to be worn on its side.
    const quantity = Math.min(4, Math.max(1, ...entities.map((e) => (e.type === "TEXT" ? Number(str(e, 1).match(/quantity\s*:\s*(\d+)/i)?.[1] ?? 1) : 1))));
    for (const path of block ? [largest(list)] : list)
      for (let copy = 0; copy < (block ? quantity : 1); copy++) drawn.push({ name: label && block ? label : block || "", loop: path.pts, turns, line, quantity });
  }
  if (!drawn.length) throw new Error("Aucune pièce trouvée : le fichier ne contient pas de contour fermé (calque 1 ou 14 d'un DXF AAMA / ASTM).");

  // A piece of clothing is 10 cm to 2 m across: the unit that makes the largest piece so.
  const largest = Math.max(...drawn.flatMap((d) => [Math.max(...d.loop.map((p) => p[0])) - Math.min(...d.loop.map((p) => p[0])), Math.max(...d.loop.map((p) => p[1])) - Math.min(...d.loop.map((p) => p[1]))]));
  const unit: DxfImport["units"] = told ?? (largest > 250 ? "mm" : largest > 80 ? "cm" : "in");
  const k = TO_CM[unit];

  const pieces: FreePiece[] = [];
  const sizes: DxfImport["pieces"] = [];
  let next = 1, sleeves = 0;
  const names = new Map<string, number>();
  for (const d of drawn) {
    const base = d.name ? d.name.charAt(0).toUpperCase() + d.name.slice(1).toLowerCase().replace(/_/g, " ") : `Pièce ${pieces.length + 1}`;
    const seen = (names.get(base) ?? 0) + 1;
    names.set(base, seen);
    const zone = zoneOf(base, sleeves);
    // Each piece where it is worn: across the middle of the body (or of the arm), its top at the
    // shoulder line — at the waist when its name says it is worn below.
    const xs = d.loop.map((p) => p[0] * k), ys = d.loop.map((p) => p[1] * k);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, top = Math.max(...ys) + (LOWER.test(base) ? m.hpsToWaist : 0);
    const place = ([x, y]: P2): P2 => [x * k - cx, y * k - top];
    const piece = pieceOf(`piece${next}`, seen > 1 ? `${base} ${seen}` : base, zone, d.loop.map(place), d.turns.map(place), next + 1);
    if (!piece) continue;
    if (zone !== "front" && zone !== "back") sleeves++;
    pieces.push(piece);
    sizes.push({ name: piece.name, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: piece.points.length });
    next += 1 + piece.edges.length;
  }
  if (!pieces.length) throw new Error("Les contours du fichier sont trop petits ou dégénérés pour en faire des pièces.");
  const line = drawn.some((d) => d.line === "sew") ? "sew" : drawn.some((d) => d.line === "cut") ? "cut" : "other";
  return {
    free: { pieces, seams: [], next },
    units: unit,
    guessed: !told,
    line,
    pieces: sizes,
  };
}
