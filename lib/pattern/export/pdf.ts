import type { P2 } from "../curves";
import type { Prim, Role, Sheet } from "../sheet";

/**
 * Minimal vector PDF writer (no dependency): a 1:1 sheet tiled on A4 pages,
 * preceded by a cover page (assembly map, instructions, 10 cm test square).
 * Fonts: the standard Helvetica / Helvetica-Bold (not embedded), WinAnsi encoding.
 */

const PT = 72 / 2.54; // points per cm
export const A4 = { w: 21, h: 29.7 };
/** Printable frame on each page (cm): content of a tile; pages are trimmed along it. */
export const PAGE_MARGIN = 1;
export const TILE = { w: A4.w - 2 * PAGE_MARGIN, h: A4.h - 2 * PAGE_MARGIN };

// Helvetica advance widths (1/1000 em), ASCII 32..126.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556,
  222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Unicode → WinAnsi byte for the few non-ASCII characters we use (Latin-1 range maps 1:1). */
const WIN_ANSI_EXTRA: Record<string, number> = { "—": 0x97, "–": 0x96, "’": 0x92, "…": 0x85, "€": 0x80 };

function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else out.push(WIN_ANSI_EXTRA[ch] ?? 0x3f);
  }
  return out;
}

/** Width in em: accented letters take their base letter's width. */
function textWidth(s: string, bold: boolean): number {
  let w = 0;
  for (const ch of s.normalize("NFD")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x300 && c < 0x370) continue; // combining accent
    w += c >= 32 && c <= 126 ? HELV[c - 32] : c === 0xd7 ? 584 : c === 0xb7 ? 278 : c === 0x2014 ? 1000 : 556;
  }
  return (w / 1000) * (bold ? 1.06 : 1);
}

/** Greedy word wrap to a width (cm) at a font size (cm). */
function wrap(s: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, false) * size > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** PDF string literal; non-ASCII bytes as octal escapes so the stream stays ASCII. */
function pdfString(s: string): string {
  let out = "(";
  for (const b of winAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + ")";
}

const n = (v: number) => (Math.abs(v) < 5e-4 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""));

interface Style {
  width: number; // cm
  gray: number;
  dash?: number[]; // cm
}

const STYLES: Partial<Record<Role, Style>> = {
  cut: { width: 0.03, gray: 0 },
  seam: { width: 0.015, gray: 0.35, dash: [0.3, 0.15] },
  notch: { width: 0.03, gray: 0 },
  grain: { width: 0.02, gray: 0.2 },
  fold: { width: 0.025, gray: 0.2, dash: [0.6, 0.15, 0.1, 0.15] },
  mark: { width: 0.02, gray: 0 },
};

/** Content-stream builder in page cm, y down from the top of the page. */
class Page {
  private ops: string[] = [];

  constructor(private readonly hCm: number) {}

  private xy(p: P2): string {
    return `${n(p[0] * PT)} ${n((this.hCm - p[1]) * PT)}`;
  }

  raw(op: string) {
    this.ops.push(op);
  }

  path(pts: P2[], closed: boolean, style: Style, fill = false) {
    if (pts.length < 2) return;
    const g = n(style.gray);
    this.ops.push(
      `${n(style.width * PT)} w ${g} G ${g} g [${(style.dash ?? []).map((d) => n(d * PT)).join(" ")}] 0 d`,
      `${this.xy(pts[0])} m ` + pts.slice(1).map((p) => `${this.xy(p)} l`).join(" ") + (fill ? " h f" : closed ? " h S" : " S"),
    );
  }

  text(at: P2, s: string, size: number, opts: { anchor?: "start" | "middle" | "end"; bold?: boolean; rotate?: number; gray?: number } = {}) {
    const w = textWidth(s, !!opts.bold) * size;
    const shift = opts.anchor === "middle" ? -w / 2 : opts.anchor === "end" ? -w : 0;
    const a = (-(opts.rotate ?? 0) * Math.PI) / 180; // clockwise on screen = negative in PDF
    const c = Math.cos(a), si = Math.sin(a);
    const x = at[0] * PT + shift * PT * c, y = (this.hCm - at[1]) * PT + shift * PT * si;
    this.ops.push(
      `BT /${opts.bold ? "F2" : "F1"} ${n(size * PT)} Tf ${n(opts.gray ?? 0)} g ${n(c)} ${n(si)} ${n(-si)} ${n(c)} ${n(x)} ${n(y)} Tm ${pdfString(s)} Tj ET`,
    );
  }

  prims(prims: Prim[], map: (p: P2) => P2, scale = 1, filter?: (p: Prim) => boolean) {
    for (const p of prims) {
      if (filter && !filter(p)) continue;
      if (p.kind === "path") {
        const st = STYLES[p.role];
        if (!st) continue;
        this.path(p.pts.map(map), !!p.closed, scale === 1 ? st : { ...st, width: Math.max(0.008, st.width * Math.sqrt(scale)) }, p.fill);
      } else {
        this.text(map(p.at), p.text, p.size * scale, { anchor: p.anchor, bold: p.bold, rotate: p.rotate });
      }
    }
  }

  clip(x: number, y: number, w: number, h: number) {
    this.ops.push(`${n(x * PT)} ${n((this.hCm - y - h) * PT)} ${n(w * PT)} ${n(h * PT)} re W n`);
  }

  get content(): string {
    return this.ops.join("\n");
  }
}

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
export const tileName = (col: number, row: number) => `${colName(col)}${row + 1}`;

export interface PdfInfo {
  title: string;
  /** Lines printed on the cover under the title (pieces, allowances…). */
  details: string[];
}

/** Does the segment ab cross the rectangle (Liang–Barsky)? */
function segmentHitsRect(a: P2, b: P2, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dy, a[1] - y0) && clip(dy, y1 - a[1]);
}

/** Tile grid of a sheet; `used[row][col]` is false for a page with nothing on it (not printed). */
export function tileGrid(sheet: Sheet): { cols: number; rows: number; used: boolean[][]; pages: number } {
  const cols = Math.max(1, Math.ceil(sheet.width / TILE.w - 1e-6));
  const rows = Math.max(1, Math.ceil(sheet.height / TILE.h - 1e-6));
  const used = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = c * TILE.w, y0 = r * TILE.h, x1 = x0 + TILE.w, y1 = y0 + TILE.h;
      used[r][c] = sheet.prims.some((p) => {
        if (p.kind === "text") return p.at[0] >= x0 && p.at[0] <= x1 && p.at[1] >= y0 && p.at[1] <= y1;
        const n = p.pts.length;
        for (let i = 0; i < (p.closed ? n : n - 1); i++) if (segmentHitsRect(p.pts[i], p.pts[(i + 1) % n], x0, y0, x1, y1)) return true;
        return false;
      });
    }
  return { cols, rows, used, pages: used.flat().filter(Boolean).length };
}

export function sheetToPdf(sheet: Sheet, info: PdfInfo): Uint8Array {
  const { cols, rows, used, pages: tiles } = tileGrid(sheet);
  const pages: Page[] = [];

  // ---- Cover: title, instructions, assembly map, test square.
  const cover = new Page(A4.h);
  const m = PAGE_MARGIN + 0.5;
  cover.text([m, m + 0.9], info.title, 0.75, { bold: true });
  info.details.forEach((d, i) => cover.text([m, m + 1.7 + i * 0.55], d, 0.38, { gray: 0.25 }));
  let y = m + 1.7 + info.details.length * 0.55 + 0.6;
  const steps = [
    `1. Imprimer les ${tiles + 1} pages à 100 % (« taille réelle », sans ajustement à la page), en portrait.` +
      (tiles < cols * rows ? " Les cases grisées du plan sont vides : elles ne sont pas imprimées." : ""),
    "2. Vérifier le carré test ci-dessous : il doit mesurer exactement 10 cm de côté.",
    "3. Couper chaque page le long du cadre, sur ses bords droit et bas.",
    `4. Poser chaque page coupée sur la suivante, bord coupé sur le cadre (les triangles forment des losanges) : ` +
      `${tileName(0, 0)} sur ${tileName(1, 0)}… rangée par rangée, puis les rangées entre elles.`,
    "Trait plein : coupe. Tirets : couture. Crans : simple = devant, milieux et haut de manche ; double = dos.",
  ];
  for (const s of steps)
    for (const line of wrap(s, 0.36, A4.w - 2 * m)) {
      cover.text([m, y], line, 0.36);
      y += 0.5;
    }
  y += 0.4;

  // Assembly map: the whole sheet scaled into the remaining width, with the tile grid.
  const mapW = A4.w - 2 * m, mapH = A4.h - y - m - 11.5;
  const k = Math.min(mapW / (cols * TILE.w), mapH / (rows * TILE.h));
  const map = (p: P2): P2 => [m + p[0] * k, y + p[1] * k];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const x0 = c * TILE.w, y0 = r * TILE.h;
      const box = [map([x0, y0]), map([x0 + TILE.w, y0]), map([x0 + TILE.w, y0 + TILE.h]), map([x0, y0 + TILE.h])];
      if (!used[r][c]) {
        cover.path(box, true, { width: 0, gray: 0.9 }, true);
        continue;
      }
      cover.path(box, true, { width: 0.01, gray: 0.6 });
      cover.text(map([x0 + TILE.w / 2, y0 + TILE.h / 2 + 1.5]), tileName(c, r), Math.min(0.6, TILE.h * k * 0.25), { anchor: "middle", gray: 0.55 });
    }
  cover.prims(sheet.prims, map, k, (p) => p.kind === "path" && (p.role === "cut" || p.role === "fold"));

  // Test square, 1:1.
  const sq = 10, sx = m, sy = A4.h - m - sq;
  cover.path([[sx, sy], [sx + sq, sy], [sx + sq, sy + sq], [sx, sy + sq]], true, { width: 0.02, gray: 0 });
  cover.text([sx + sq / 2, sy + sq / 2], "10 cm", 0.8, { anchor: "middle", bold: true });
  cover.text([sx + sq / 2, sy + sq / 2 + 0.8], "carré test", 0.45, { anchor: "middle" });
  cover.text([sx + sq + 0.6, sy + 0.5], "Échelle 1:1", 0.45, { bold: true });
  cover.text([sx + sq + 0.6, sy + 1.2], `${tiles} pages A4 (plan de ${cols} × ${rows})`, 0.38);
  cover.text([sx + sq + 0.6, sy + 1.8], `Planche ${(sheet.width / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} × ${(sheet.height / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} m`, 0.38);
  pages.push(cover);

  // ---- Tiles. Only the primitives whose box meets the tile are written (texts: a generous box).
  const boxes = sheet.prims.map((p) => {
    const pts = p.kind === "path" ? p.pts : [p.at];
    const pad = p.kind === "text" ? p.text.length * p.size : 0;
    return {
      x0: Math.min(...pts.map((q) => q[0])) - pad, x1: Math.max(...pts.map((q) => q[0])) + pad,
      y0: Math.min(...pts.map((q) => q[1])) - pad, y1: Math.max(...pts.map((q) => q[1])) + pad,
    };
  });
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!used[r][c]) continue;
      const page = new Page(A4.h);
      const x0 = c * TILE.w, y0 = r * TILE.h;
      const fx = PAGE_MARGIN, fy = PAGE_MARGIN;
      page.raw("q");
      page.clip(fx, fy, TILE.w, TILE.h);
      page.text([fx + TILE.w / 2, fy + TILE.h / 2 + 2], tileName(c, r), 6, { anchor: "middle", gray: 0.92 }); // watermark under the drawing
      const inTile = sheet.prims.filter((_, i) => {
        const b = boxes[i];
        return b.x1 >= x0 && b.x0 <= x0 + TILE.w && b.y1 >= y0 && b.y0 <= y0 + TILE.h;
      });
      page.prims(inTile, (p) => [p[0] - x0 + fx, p[1] - y0 + fy]);
      page.raw("Q");
      // Frame and alignment half-diamonds on the edges shared with a neighbour.
      const fr: Style = { width: 0.015, gray: 0.45 };
      page.path([[fx, fy], [fx + TILE.w, fy], [fx + TILE.w, fy + TILE.h], [fx, fy + TILE.h]], true, fr);
      const tri = 0.6;
      const mx = fx + TILE.w / 2, my = fy + TILE.h / 2;
      const black: Style = { width: 0.01, gray: 0.45 };
      if (c > 0) page.path([[fx, my - tri], [fx + tri, my], [fx, my + tri]], true, black, true);
      if (c < cols - 1) page.path([[fx + TILE.w, my - tri], [fx + TILE.w - tri, my], [fx + TILE.w, my + tri]], true, black, true);
      if (r > 0) page.path([[mx - tri, fy], [mx, fy + tri], [mx + tri, fy]], true, black, true);
      if (r < rows - 1) page.path([[mx - tri, fy + TILE.h], [mx, fy + TILE.h - tri], [mx + tri, fy + TILE.h]], true, black, true);
      // Page name and neighbours, in the margin.
      page.text([fx, fy - 0.3], `${tileName(c, r)}  ·  ${info.title}`, 0.35, { bold: true, gray: 0.3 });
      page.text([fx + TILE.w, fy - 0.3], `rangée ${r + 1}/${rows} · colonne ${c + 1}/${cols}`, 0.3, { anchor: "end", gray: 0.4 });
      if (c < cols - 1) page.text([fx + TILE.w + 0.3, my], `suite : ${tileName(c + 1, r)}`, 0.3, { anchor: "middle", rotate: 90, gray: 0.4 });
      if (r < rows - 1) page.text([mx, fy + TILE.h + 0.55], `suite : ${tileName(c, r + 1)}`, 0.3, { anchor: "middle", gray: 0.4 });
      pages.push(page);
    }

  return assemble(pages, info.title);
}

function assemble(pages: Page[], title: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // = 1-based object number
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Pages, filled below
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const content = p.content;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(A4.w * PT)} ${n(A4.h * PT)}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(title)} /Creator (Couture - atelier 3D) /Producer (Couture) >>`);

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  const bytes = (s: string) => s.length; // everything is single-byte (latin-1 header, ASCII bodies)
  let pos = bytes(out);
  objects.forEach((body, i) => {
    offsets.push(pos);
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    out += obj;
    pos += bytes(obj);
  });
  const xref = pos;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const u8 = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 0xff;
  return u8;
}
