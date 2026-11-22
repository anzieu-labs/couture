import { draftFree, type FreePattern } from "./free";
import { NO_EDITS } from "./types";
import { outline } from "./validate";

/** A drawing as a card shows it: its pieces side by side, as they are drawn — the points of their outlines, and the room they take (cm). */
export interface PatternThumb {
  pieces: { id: string; points: string }[];
  width: number;
  height: number;
}

export function thumbOf(free: FreePattern): PatternThumb {
  const gap = 6;
  const pieces: PatternThumb["pieces"] = [];
  let x = 0, height = 1;
  for (const piece of draftFree(free, NO_EDITS).pieces) {
    const pts = outline(piece);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const left = Math.min(...xs), top = Math.max(...ys);
    pieces.push({ id: piece.id, points: pts.map(([px, py]) => `${(x + px - left).toFixed(1)},${(top - py).toFixed(1)}`).join(" ") });
    x += Math.max(...xs) - left + gap;
    height = Math.max(height, top - Math.min(...ys));
  }
  return { pieces, width: Math.max(1, x - gap), height };
}
