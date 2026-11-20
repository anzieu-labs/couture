import { allowanceNote, cutPieces, type Allowances, type CutPiece } from "../markings";
import { layoutShelves, pieceBlock, rotateBlock, testSquareBlock, type Block, type Sheet } from "../sheet";
import type { Pattern } from "../types";
import { piecesToDxf } from "./dxf";
import { sheetToPdf, TILE, tileGrid } from "./pdf";
import { sheetToSvg } from "./svg";

/** Pattern exports: 1:1 SVG, tiled A4 PDF, AAMA DXF. */

export interface ExportOptions {
  allowances: Allowances;
  /** Front / back cut on the fold (half pieces). Ignored by the DXF (whole pieces). */
  fold: boolean;
}

const GAP = 1.5;
const MARGIN = 0.5;

/**
 * Lays the blocks out for the fewest printed A4 pages: every sheet width (whole
 * number of tiles) × every choice of quarter-turned blocks, shelf packed.
 * Ties go to fewer turned pieces, then to the smaller sheet.
 */
function packForTiles(blocks: Block[]): Sheet {
  let best: { sheet: Sheet; pages: number; turned: number; area: number } | null = null;
  const turnedVariants = blocks.map(rotateBlock);
  for (let mask = 0; mask < 1 << blocks.length; mask++) {
    const set = blocks.map((b, i) => (mask & (1 << i) ? turnedVariants[i] : b));
    const turned = blocks.filter((_, i) => mask & (1 << i)).length;
    for (let cols = 1; cols <= 12; cols++) {
      const sheet = layoutShelves(set, cols * TILE.w, GAP, MARGIN);
      if (!sheet) continue;
      const { pages } = tileGrid(sheet);
      const area = sheet.width * sheet.height;
      if (!best || pages < best.pages || (pages === best.pages && (turned < best.turned || (turned === best.turned && area < best.area))))
        best = { sheet, pages, turned, area };
    }
  }
  return best!.sheet;
}

function summary(pieces: CutPiece[]): string {
  return pieces.map((p) => `${p.name} ×${p.quantity}${p.onFold ? " (au pli)" : ""}`).join(", ");
}

function stamp(pattern: Pattern, measuresNote: string): string {
  return `${pattern.name} · ${measuresNote} · ${new Date().toLocaleDateString("fr-FR")}`;
}

export function exportPdf(pattern: Pattern, o: ExportOptions, measuresNote: string): Blob {
  const pieces = cutPieces(pattern, o.allowances, { fold: o.fold });
  const sheet = packForTiles(pieces.map((p) => pieceBlock(p, "print")));
  const bytes = sheetToPdf(sheet, {
    title: pattern.name,
    details: [stamp(pattern, measuresNote), `Pièces : ${summary(pieces)}`, allowanceNote(o.allowances)],
  });
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

export function exportSvg(pattern: Pattern, o: ExportOptions, measuresNote: string): Blob {
  const pieces = cutPieces(pattern, o.allowances, { fold: o.fold });
  const blocks = [
    testSquareBlock(pattern.name, [stamp(pattern, measuresNote), `Pièces : ${summary(pieces)}`, allowanceNote(o.allowances), "Échelle 1:1 — imprimer à 100 %"]),
    ...pieces.map((p) => pieceBlock(p, "print")),
  ];
  const sheet = packForTiles(blocks);
  return new Blob([sheetToSvg(sheet, pattern.name)], { type: "image/svg+xml" });
}

export function exportDxf(pattern: Pattern, o: ExportOptions, measuresNote: string): Blob {
  const pieces = cutPieces(pattern, o.allowances, { fold: false });
  const hasAllowance = o.allowances.seam > 0 || o.allowances.hem > 0;
  return new Blob([piecesToDxf(pieces, { style: pattern.name, sizeNote: measuresNote, hasAllowance })], { type: "application/dxf" });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
