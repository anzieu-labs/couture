import { polylineLength, type P2 } from "./curves";
import type { Band, Belt, Pattern, SeamSide } from "./types";

/**
 * Belts (types.ts Belt): an elastic along a free edge of the garment, all the way round. The
 * user points at one edge — the front half of a skirt's waist; the belt runs along every edge
 * that continues it: the other half, and across each seam it meets, the edge of the same name
 * on the piece sewn there (the back's waist), until it comes back to where it started — a
 * skirt's waist, a t-shirt's hem, the hem of one sleeve. Only free edges: a seam is sewn, not
 * belted.
 */

/** Elasticity of a belt: its range, the step of the editor's buttons, and what a new one starts with (rigid). */
export const BELT_STRETCH = { min: -0.4, max: 0.4, step: 0.05, initial: 0 };

const sideKey = (piece: string, edge: string) => `${piece}/${edge}`;
/** An edge's name without its side: "waist+" and "waist-" are the two halves of the waist. */
const base = (edge: string) => edge.replace(/[+-]$/, "");

/** The edges a belt runs along, in no particular order; null when its edge is not on the pattern (any more) or is sewn. */
export function beltRing(pattern: Pattern, belt: Pick<Belt, "piece" | "edge">): { piece: string; edge: string }[] | null {
  const sewn = new Map<string, { self: SeamSide; other: SeamSide }>();
  for (const s of pattern.seams) {
    sewn.set(sideKey(s.a.piece, s.a.edge), { self: s.a, other: s.b });
    sewn.set(sideKey(s.b.piece, s.b.edge), { self: s.b, other: s.a });
  }
  const pieces = new Map(pattern.pieces.map((p) => [p.id, p]));
  const start = pieces.get(belt.piece)?.edges.findIndex((e) => e.id === belt.edge) ?? -1;
  if (start < 0 || sewn.has(sideKey(belt.piece, belt.edge))) return null;
  const name = base(belt.edge);
  const ring = new Map<string, { piece: string; edge: string }>([[sideKey(belt.piece, belt.edge), { piece: belt.piece, edge: belt.edge }]]);
  // From each end of the first edge: the next edge round the piece; across a seam, the edge next
  // to the same end of the seam on the other piece.
  for (const forward of [true, false]) {
    let piece = belt.piece, index = start, ahead = forward, crossed = false;
    for (let guard = 0; guard < 64; guard++) {
      const edges = pieces.get(piece)!.edges;
      const previous = index;
      index = (index + (ahead ? 1 : edges.length - 1)) % edges.length;
      const seam = sewn.get(sideKey(piece, edges[index].id));
      if (seam) {
        // Reached at its start when going forward; the same point of the seam on the other side.
        const first = ahead !== seam.self.reverse;
        const there = pieces.get(seam.other.piece);
        const at = there?.edges.findIndex((e) => e.id === seam.other.edge) ?? -1;
        if (!there || at < 0) break;
        const atStart = first !== seam.other.reverse;
        piece = seam.other.piece;
        index = at;
        ahead = !atStart; // away from the seam: back from its start, on from its end
        crossed = true;
        continue;
      }
      const key = sideKey(piece, edges[index].id);
      if (ring.has(key)) break;
      // Round a piece: the edge of the same name, or one that goes straight on (a drawn pattern's
      // edges have no names: its waist is whatever continues the edge pointed at). Across a seam:
      // whatever free edge is there.
      if (!crossed && base(edges[index].id) !== name && !straightOn(edges[previous].pts, edges[index].pts, ahead)) break;
      ring.set(key, { piece, edge: edges[index].id });
      crossed = false;
    }
  }
  return [...ring.values()];
}

/** Whether an edge goes straight on into the next one round the piece (within 35°), at the corner they share. */
function straightOn(from: P2[], to: P2[], ahead: boolean): boolean {
  const end = (pts: P2[], last: boolean): P2 => {
    const a = pts[last ? pts.length - 2 : 0], b = pts[last ? pts.length - 1 : 1];
    return [b[0] - a[0], b[1] - a[1]];
  };
  // Going forward: out of the end of `from`, into the start of `to`; backward, the other ends.
  const u = end(from, ahead), v = end(to, !ahead);
  return (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1) > Math.cos((35 * Math.PI) / 180);
}

/** Length of the edges a belt runs along (cm). */
export function ringLength(pattern: Pattern, ring: { piece: string; edge: string }[]): number {
  let length = 0;
  for (const { piece, edge } of ring) length += polylineLength(pattern.pieces.find((p) => p.id === piece)!.edges.find((e) => e.id === edge)!.pts);
  return length;
}

/** The belts that hold on a pattern as it is now, one per ring (the last one put on it). */
export function validBelts(pattern: Pattern, belts: readonly Belt[]): { belt: Belt; ring: { piece: string; edge: string }[] }[] {
  const out: { belt: Belt; ring: { piece: string; edge: string }[] }[] = [];
  const taken = new Map<string, number>();
  for (const belt of belts) {
    const ring = beltRing(pattern, belt);
    if (!ring) continue;
    const id = ring.map((r) => sideKey(r.piece, r.edge)).sort()[0];
    if (taken.has(id)) out[taken.get(id)!] = { belt, ring };
    else taken.set(id, out.push({ belt, ring }) - 1);
  }
  return out;
}

/** A pattern with its belts as bands (what the simulation holds: lib/sim/model.ts BandModel). */
export function withBelts(pattern: Pattern, belts: readonly Belt[]): Pattern {
  const bands: Band[] = validBelts(pattern, belts).map(({ belt, ring }) => ({ edges: ring, stretch: belt.stretch }));
  return bands.length ? { ...pattern, bands: [...(pattern.bands ?? []), ...bands] } : pattern;
}
