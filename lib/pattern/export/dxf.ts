import type { P2 } from "../curves";
import { pieceBounds, type CutPiece } from "../markings";

/**
 * AAMA / ASTM D6673 style DXF (R12 ASCII), millimetres. One BLOCK per piece,
 * inserted side by side, with the layers CAD pattern software expects:
 *   1  boundary (cut line) + piece texts      2  turn points (corners)
 *   3  curve points                           4  notches (lines)
 *   7  grain line                             14 sew line (stitching line)
 * Pieces are always whole (never on the fold): CLO, Gerber, Optitex… mirror nothing.
 */

const MM = 10;
/** Group codes 60–99 and 170–179 (the ones used here) hold integers, the others reals or strings. */
const isInt = (code: number) => (code >= 60 && code <= 99) || (code >= 170 && code <= 179);
const g = (code: number, value: string | number) =>
  `${code}\n${typeof value === "string" ? value : isInt(code) ? Math.round(value) : num(value)}`;
const num = (v: number) => (Math.abs(v) < 1e-6 ? "0.0" : v.toFixed(3));

function point(layer: string, [x, y]: P2): string[] {
  return [g(0, "POINT"), g(8, layer), g(10, x * MM), g(20, y * MM), g(30, 0)];
}

function line(layer: string, [x1, y1]: P2, [x2, y2]: P2): string[] {
  return [g(0, "LINE"), g(8, layer), g(10, x1 * MM), g(20, y1 * MM), g(30, 0), g(11, x2 * MM), g(21, y2 * MM), g(31, 0)];
}

/** Closed outline as an open polyline repeating its first vertex (the AAMA habit). */
function polyline(layer: string, pts: P2[]): string[] {
  const out = [g(0, "POLYLINE"), g(8, layer), g(66, 1), g(10, 0), g(20, 0), g(30, 0), g(70, 0)];
  for (const [x, y] of [...pts, pts[0]]) out.push(g(0, "VERTEX"), g(8, layer), g(10, x * MM), g(20, y * MM), g(30, 0));
  out.push(g(0, "SEQEND"), g(8, layer));
  return out;
}

function text(layer: string, [x, y]: P2, height: number, s: string): string[] {
  return [g(0, "TEXT"), g(8, layer), g(10, x * MM), g(20, y * MM), g(30, 0), g(40, height * MM), g(1, ascii(s))];
}

/** R12 text is code-page bound: keep it ASCII (accents stripped). */
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/×/g, "x").replace(/[^\x20-\x7e]/g, "-");

const blockName = (p: CutPiece) => ascii(p.name).toUpperCase().replace(/[^A-Z0-9_-]/g, "_");

export function piecesToDxf(pieces: CutPiece[], info: { style: string; sizeNote: string; hasAllowance: boolean }): string {
  const layers = ["1", "2", "3", "4", "7", "14"];
  const out: string[] = [];
  out.push(g(0, "SECTION"), g(2, "HEADER"), g(9, "$ACADVER"), g(1, "AC1009"), g(9, "$INSUNITS"), g(70, 4), g(9, "$MEASUREMENT"), g(70, 1), g(0, "ENDSEC"));
  out.push(g(0, "SECTION"), g(2, "TABLES"));
  out.push(g(0, "TABLE"), g(2, "LTYPE"), g(70, 1), g(0, "LTYPE"), g(2, "CONTINUOUS"), g(70, 0), g(3, "Solid line"), g(72, 65), g(73, 0), g(40, 0), g(0, "ENDTAB"));
  out.push(g(0, "TABLE"), g(2, "LAYER"), g(70, layers.length + 1));
  for (const l of ["0", ...layers]) out.push(g(0, "LAYER"), g(2, l), g(70, 0), g(62, 7), g(6, "CONTINUOUS"));
  out.push(g(0, "ENDTAB"), g(0, "ENDSEC"));

  out.push(g(0, "SECTION"), g(2, "BLOCKS"));
  for (const p of pieces) {
    const name = blockName(p);
    out.push(g(0, "BLOCK"), g(8, "0"), g(2, name), g(70, 0), g(10, 0), g(20, 0), g(30, 0), g(3, name));
    out.push(...polyline("1", p.cutLine));
    const turns = new Set(p.turns);
    p.cutLine.forEach((q, i) => out.push(...point(turns.has(i) ? "2" : "3", q)));
    for (const [a, b] of p.notches) out.push(...line("4", a, b));
    out.push(...line("7", p.grain[0], p.grain[1]));
    if (info.hasAllowance) out.push(...polyline("14", p.seamLine));
    const [lx, ly] = p.label;
    out.push(
      ...text("1", [lx, ly], 1, `Piece Name: ${ascii(p.name)}`),
      ...text("1", [lx, ly - 1.4], 0.6, `Quantity: ${p.quantity}`),
      ...text("1", [lx, ly - 2.2], 0.6, `Size: ${info.sizeNote}`),
      ...text("1", [lx, ly - 3], 0.6, `Category: ${info.style}`),
    );
    out.push(g(0, "ENDBLK"), g(8, "0"));
  }
  out.push(g(0, "ENDSEC"));

  out.push(g(0, "SECTION"), g(2, "ENTITIES"));
  let x = 0, top = 0;
  for (const p of pieces) {
    const b = pieceBounds(p);
    top = Math.max(top, b.maxY);
    out.push(g(0, "INSERT"), g(8, "1"), g(2, blockName(p)), g(10, (x - b.minX) * MM), g(20, 0), g(30, 0));
    x += b.maxX - b.minX + 5;
  }
  const date = new Date().toISOString().slice(0, 10);
  [`Style Name: ${info.style}`, `Creation Date: ${date}`, "Author: Couture", `Sample Size: ${info.sizeNote}`, "Grading Rule Table: none", "Units: METRIC"].forEach((s, i) =>
    out.push(...text("1", [0, top + 4 + (5 - i) * 1.2], 0.8, s)),
  );
  out.push(g(0, "ENDSEC"), g(0, "EOF"));
  return out.join("\n") + "\n";
}
