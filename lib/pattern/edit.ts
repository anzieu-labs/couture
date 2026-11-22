import type { P2 } from "./curves";
import type { Handle, PatternEdits } from "./types";

/** Editing a pattern's points (the 2D editor, and the same points dragged on the garment in 3D). */

/** Edits snap to this (cm). */
export const SNAP = 0.1;

/** `edits` with the displacement of one point set to `d` (removed when null). */
export function withDelta(edits: PatternEdits, key: string, d: P2): PatternEdits {
  const next = { ...edits };
  if (Math.hypot(d[0], d[1]) < 1e-6) delete next[key];
  else next[key] = d;
  return next;
}

/** A displacement as a point's axis allows it, snapped. */
export function constrain(d: P2, axis: Handle["axis"]): P2 {
  const r = (v: number) => Math.round(v / SNAP) * SNAP + 0; // + 0: no "-0"
  return axis === "vertical" ? [0, r(d[1])] : axis === "horizontal" ? [r(d[0]), 0] : [r(d[0]), r(d[1])];
}
