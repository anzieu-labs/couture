import type { Prim, Role, Sheet } from "../sheet";

/** Standalone SVG at real size (1 user unit = 1 cm; width / height in cm). */

const STROKES: Partial<Record<Role, string>> = {
  cut: 'stroke="#000" stroke-width="0.03"',
  seam: 'stroke="#555" stroke-width="0.015" stroke-dasharray="0.3 0.15"',
  notch: 'stroke="#000" stroke-width="0.03"',
  grain: 'stroke="#333" stroke-width="0.02"',
  fold: 'stroke="#333" stroke-width="0.025" stroke-dasharray="0.6 0.15 0.1 0.15"',
  mark: 'stroke="#000" stroke-width="0.02"',
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (v: number) => v.toFixed(3).replace(/\.?0+$/, "") || "0";

function prim(p: Prim): string {
  if (p.kind === "path") {
    const stroke = STROKES[p.role];
    if (!stroke) return "";
    const d = `M${p.pts.map(([x, y]) => `${f(x)},${f(y)}`).join("L")}${p.closed || p.fill ? "Z" : ""}`;
    return p.fill
      ? `<path d="${d}" fill="#333"/>`
      : `<path d="${d}" fill="none" ${stroke} stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  const [x, y] = p.at;
  const rot = p.rotate ? ` transform="rotate(${f(p.rotate)} ${f(x)} ${f(y)})"` : "";
  return `<text x="${f(x)}" y="${f(y)}" font-size="${f(p.size)}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="bold"' : ""}${rot}>${esc(p.text)}</text>`;
}

export function sheetToSvg(sheet: Sheet, title: string): string {
  const w = f(sheet.width), h = f(sheet.height);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}cm" height="${h}cm" viewBox="0 0 ${w} ${h}">`,
    `<title>${esc(title)}</title>`,
    `<g font-family="Helvetica, Arial, sans-serif" fill="#000">`,
    ...sheet.prims.map(prim).filter(Boolean),
    `</g>`,
    `</svg>`,
  ].join("\n");
}
