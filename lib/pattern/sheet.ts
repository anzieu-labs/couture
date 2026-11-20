import type { P2 } from "./curves";
import { pieceBounds, type CutPiece } from "./markings";

/**
 * Drawing of cut pieces on a sheet, as backend-neutral primitives (cm, x right,
 * y DOWN, origin top-left), rendered by the panel preview, the SVG and the PDF
 * exports. Styles are left to the renderers (by `role`).
 */

export type Role = "cut" | "seam" | "notch" | "grain" | "fold" | "mark" | "text" | "caption";

export interface PathPrim {
  kind: "path";
  pts: P2[];
  closed?: boolean;
  fill?: boolean;
  role: Role;
  /** Seam kind of a stitching line (seam id without side), for colouring in the preview. */
  seam?: string;
}

export interface TextPrim {
  kind: "text";
  /** Baseline anchor point. */
  at: P2;
  text: string;
  /** Font size (cm). */
  size: number;
  anchor: "start" | "middle" | "end";
  bold?: boolean;
  /** Clockwise rotation (degrees) about `at`. */
  rotate?: number;
  role: Role;
}

export type Prim = PathPrim | TextPrim;

export interface Sheet {
  width: number;
  height: number;
  prims: Prim[];
}

/** Something placed on the sheet: a piece or the test square. */
export interface Block {
  w: number;
  h: number;
  /** Primitives with the block's top-left corner at (x, y). */
  draw: (x: number, y: number) => Prim[];
}

const arrowHead = (tip: P2, from: P2, len: number): PathPrim => {
  const dx = tip[0] - from[0], dy = tip[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l, w = len * 0.4;
  return {
    kind: "path",
    pts: [tip, [tip[0] - ux * len - uy * w, tip[1] - uy * len + ux * w], [tip[0] - ux * len + uy * w, tip[1] - uy * len - ux * w]],
    closed: true,
    fill: true,
    role: "grain",
  };
};

const foldTitle = (name: string) => `PLI · MILIEU ${name.toUpperCase()}`;

/**
 * A cut piece as a block. "print": every marking and note (1:1 output);
 * "preview": outlines, notches, grain / fold lines, no text (too small).
 */
export function pieceBlock(piece: CutPiece, detail: "print" | "preview"): Block {
  const b = pieceBounds(piece);
  const print = detail === "print";
  return {
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    draw: (x, y) => {
      const T = (p: P2): P2 => [p[0] - b.minX + x, b.maxY - p[1] + y];
      const prims: Prim[] = [];
      // Cutting line; when on the fold, open at the fold (that edge is folded, not cut).
      const cut = piece.cutLine.map(T);
      if (piece.foldSegment >= 0) {
        const k = piece.foldSegment + 1;
        prims.push({ kind: "path", pts: [...cut.slice(k), ...cut.slice(0, k)], role: "cut" });
      } else prims.push({ kind: "path", pts: cut, closed: true, role: "cut" });
      for (const e of piece.seamEdges) prims.push({ kind: "path", pts: e.pts.map(T), role: "seam", seam: e.seam });
      for (const [a, c] of piece.notches) prims.push({ kind: "path", pts: [T(a), T(c)], role: "notch" });

      // Grain line with arrows at both ends.
      const g0 = T(piece.grain[0]), g1 = T(piece.grain[1]);
      const head = print ? 0.7 : 1.6;
      prims.push({ kind: "path", pts: [g0, g1], role: "grain" }, arrowHead(g0, g1, head), arrowHead(g1, g0, head));

      if (piece.fold) {
        const f0 = T(piece.fold[0]), f1 = T(piece.fold[1]);
        prims.push({ kind: "path", pts: [f0, f1], role: "fold" });
        // "Place on fold" bracket: arrows pointing at the fold line.
        const inset = print ? 2.5 : 4, span = Math.abs(f1[1] - f0[1]);
        const ya = Math.min(f0[1], f1[1]) + span * 0.3, yb = Math.min(f0[1], f1[1]) + span * 0.7;
        const xf = f0[0], xb = xf + inset;
        prims.push(
          { kind: "path", pts: [[xf + head * 0.6, ya], [xb, ya], [xb, yb], [xf + head * 0.6, yb]], role: "grain" },
          arrowHead([xf + 0.05, ya], [xb, ya], head),
          arrowHead([xf + 0.05, yb], [xb, yb], head),
        );
        if (print) prims.push({ kind: "text", at: [xb + 0.55, (ya + yb) / 2], text: foldTitle(piece.name), size: 0.4, anchor: "middle", rotate: -90, role: "text" });
      }

      if (print) {
        const gx = (g0[0] + g1[0]) / 2, gy = (g0[1] + g1[1]) / 2;
        prims.push({ kind: "text", at: [gx - 0.25, gy], text: "DROIT-FIL", size: 0.4, anchor: "middle", rotate: -90, role: "text" });
        const [lx, ly] = T(piece.label);
        prims.push({ kind: "text", at: [lx, ly], text: piece.name.toUpperCase(), size: 1.2, anchor: "middle", bold: true, role: "text" });
        piece.notes.forEach((note, i) =>
          prims.push({ kind: "text", at: [lx, ly + 1.0 + i * 0.7], text: note, size: 0.45, anchor: "middle", role: "text" }),
        );
      }
      return prims;
    },
  };
}

/** 10 cm × 10 cm square to check the print scale, with the pattern's title. */
export function testSquareBlock(title: string, lines: string[]): Block {
  const s = 10;
  return {
    w: s + 0.1,
    h: s + 1.4 + lines.length * 0.6,
    draw: (x, y) => [
      { kind: "path", pts: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]], closed: true, role: "mark" },
      { kind: "text", at: [x + s / 2, y + s / 2 - 0.3], text: "10 cm", size: 0.8, anchor: "middle", bold: true, role: "text" },
      { kind: "text", at: [x + s / 2, y + s / 2 + 0.6], text: "carré test", size: 0.45, anchor: "middle", role: "text" },
      { kind: "text", at: [x, y + s + 0.9], text: title, size: 0.5, anchor: "start", bold: true, role: "text" },
      ...lines.map((t, i): Prim => ({ kind: "text", at: [x, y + s + 1.6 + i * 0.6], text: t, size: 0.38, anchor: "start", role: "text" })),
    ],
  };
}

/** The block turned a quarter turn clockwise (on screen). */
export function rotateBlock(b: Block): Block {
  return {
    w: b.h,
    h: b.w,
    draw: (x, y) =>
      b.draw(0, 0).map((p): Prim => {
        const R = ([px, py]: P2): P2 => [x + b.h - py, y + px];
        return p.kind === "path" ? { ...p, pts: p.pts.map(R) } : { ...p, at: R(p.at), rotate: (p.rotate ?? 0) + 90 };
      }),
  };
}

/** Blocks side by side, tops aligned; `slots` gives each block's x range. */
export function layoutRow(blocks: Block[], gap: number): Sheet & { slots: { x: number; w: number }[] } {
  let x = 0;
  const prims: Prim[] = [];
  const slots: { x: number; w: number }[] = [];
  for (const b of blocks) {
    prims.push(...b.draw(x, 0));
    slots.push({ x, w: b.w });
    x += b.w + gap;
  }
  return { width: Math.max(0, x - gap), height: Math.max(...blocks.map((b) => b.h)), prims, slots };
}

/**
 * Shelf packing (tallest first) inside `width`, with a `margin` all around.
 * Returns null when a block is wider than the sheet.
 */
export function layoutShelves(blocks: Block[], width: number, gap: number, margin: number): Sheet | null {
  const inner = width - 2 * margin;
  if (blocks.some((b) => b.w > inner)) return null;
  const order = blocks.slice().sort((a, b) => b.h - a.h);
  const prims: Prim[] = [];
  let x = margin, y = margin, shelf = 0, used = 0;
  for (const b of order) {
    if (x > margin && x + b.w > margin + inner) {
      y += shelf + gap;
      x = margin;
      shelf = 0;
    }
    prims.push(...b.draw(x, y));
    used = Math.max(used, x + b.w);
    x += b.w + gap;
    shelf = Math.max(shelf, b.h);
  }
  return { width: used + margin, height: y + shelf + margin, prims };
}
