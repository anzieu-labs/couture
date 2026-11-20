"use client";

import { useMemo, useState } from "react";
import { download, exportDxf, exportPdf, exportSvg, type ExportOptions } from "@/lib/pattern/export";
import { cutPieces } from "@/lib/pattern/markings";
import { layoutRow, pieceBlock, type Prim } from "@/lib/pattern/sheet";
import type { Pattern, TShirtParams } from "@/lib/pattern/tshirt";
import { RangeField } from "./RangeField";
import { Section } from "./Section";

interface Props {
  pattern: Pattern | null;
  params: TShirtParams;
  onParams: (p: TShirtParams) => void;
  autoLength: number | null;
  progress: number;
  onResew: () => void;
  cutting: ExportOptions;
  onCutting: (o: ExportOptions) => void;
}

const SEAM_COLORS: Record<string, string> = {
  shoulder: "#c0643e",
  side: "#3f7cac",
  arm: "#8a6bb8",
  capFront: "#8a6bb8",
  capBack: "#8a6bb8",
  underBack: "#4f9a6a",
  underFront: "#4f9a6a",
};

function seamColor(edgeId: string): string | null {
  const base = edgeId.replace(/[+-]$/, "");
  return SEAM_COLORS[base] ?? null;
}

const pts = (p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

function PreviewPrim({ p }: { p: Prim }) {
  if (p.kind === "text") return null;
  const d = `M${pts(p.pts).replaceAll(" ", "L")}${p.closed || p.fill ? "Z" : ""}`;
  switch (p.role) {
    case "cut":
      return <path d={d} fill="white" stroke="var(--color-ink)" strokeWidth={0.3} strokeLinejoin="round" />;
    case "seam": {
      const c = p.edge ? seamColor(p.edge) : null;
      return c ? (
        <path d={d} fill="none" stroke={c} strokeWidth={0.8} strokeLinecap="round" />
      ) : (
        <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.3} strokeDasharray="1 0.7" />
      );
    }
    case "notch":
      return <path d={d} stroke="var(--color-ink)" strokeWidth={0.4} />;
    case "fold":
      return <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.35} strokeDasharray="2.4 0.8 0.4 0.8" />;
    case "grain":
      return p.fill ? <path d={d} fill="var(--color-muted)" /> : <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.3} />;
    default:
      return null;
  }
}

/** Cut pieces side by side: cutting line, stitching line coloured by seam, notches, grain / fold. */
function PatternSvg({ pattern, cutting }: { pattern: Pattern; cutting: ExportOptions }) {
  const sheet = useMemo(() => {
    const pieces = cutPieces(pattern, cutting.allowances, { fold: cutting.fold });
    return { pieces, ...layoutRow(pieces.map((p) => pieceBlock(p, "preview")), 6) };
  }, [pattern, cutting]);
  const { width, height, prims, slots, pieces } = sheet;
  return (
    <svg viewBox={`-3 -3 ${width + 6} ${height + 12}`} className="w-full" role="img" aria-label="Patron du t-shirt">
      {prims.map((p, i) => (
        <PreviewPrim key={i} p={p} />
      ))}
      {pieces.map((piece, i) => (
        <text key={piece.id} x={slots[i].x + slots[i].w / 2} y={height + 7} textAnchor="middle" fontSize={3.4} fill="var(--color-ink)">
          {piece.name}
          {piece.quantity > 1 ? ` ×${piece.quantity}` : ""}
          {piece.onFold ? " (pli)" : ""}
        </text>
      ))}
    </svg>
  );
}

const measuresNote = (p: Pattern) => `poitrine finie ${p.dims.chestWidth.toFixed(0)} cm · longueur ${p.dims.length.toFixed(0)} cm`;

const EXPORTS = [
  { id: "pdf", label: "PDF A4", title: "PDF à l'échelle 1, tuilé sur pages A4 à assembler", run: exportPdf, ext: "pdf" },
  { id: "svg", label: "SVG 1:1", title: "Planche unique à l'échelle 1 (traceur, découpe)", run: exportSvg, ext: "svg" },
  { id: "dxf", label: "DXF AAMA", title: "DXF AAMA / ASTM, pièces entières (CLO, Gerber, Optitex…)", run: exportDxf, ext: "dxf" },
] as const;

function ExportSection({ pattern, cutting, onCutting }: { pattern: Pattern | null; cutting: ExportOptions; onCutting: (o: ExportOptions) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const al = cutting.allowances;
  const run = (e: (typeof EXPORTS)[number]) => {
    if (!pattern) return;
    setBusy(e.id);
    // Let the button repaint before the (synchronous) layout search.
    setTimeout(() => {
      try {
        download(e.run(pattern, cutting, measuresNote(pattern)), `t-shirt-col-rond.${e.ext}`);
      } finally {
        setBusy(null);
      }
    }, 0);
  };
  return (
    <Section title="Marges et export">
      <div className="space-y-4">
        <RangeField
          label="Marges de couture"
          min={0}
          max={2}
          step={0.1}
          value={al.seam}
          display={`${al.seam.toLocaleString("fr-FR")} cm`}
          onChange={(v) => onCutting({ ...cutting, allowances: { ...al, seam: v } })}
        />
        <RangeField
          label="Ourlets (bas et manches)"
          min={0}
          max={5}
          step={0.5}
          value={al.hem}
          display={`${al.hem.toLocaleString("fr-FR")} cm`}
          onChange={(v) => onCutting({ ...cutting, allowances: { ...al, hem: v } })}
        />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={cutting.fold} onChange={(e) => onCutting({ ...cutting, fold: e.target.checked })} className="accent-ink" />
          <span className="font-medium">Devant et dos au pli</span>
          <span className="text-muted">(demi-pièces)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {EXPORTS.map((e) => (
            <button
              key={e.id}
              type="button"
              title={e.title}
              disabled={!pattern || busy !== null}
              onClick={() => run(e)}
              className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium transition-colors hover:border-ink disabled:opacity-50"
            >
              {busy === e.id ? "…" : e.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Crans : simple au devant, aux milieux et en haut de manche, double au dos. Le DXF contient toujours les pièces entières.
        </p>
      </div>
    </Section>
  );
}

const SLIDERS: { key: keyof TShirtParams; label: string; min: number; max: number }[] = [
  { key: "chestEase", label: "Aisance poitrine", min: -12, max: 30 },
  { key: "sleeveEase", label: "Aisance manche", min: -4, max: 16 },
  { key: "sleeveLength", label: "Longueur de manche", min: 12, max: 40 },
];

export function PatternPanel({ pattern, params, onParams, autoLength, progress, onResew, cutting, onCutting }: Props) {
  const simulating = progress > 0 && progress < 1;
  return (
    <>
      <Section title="Patron" aside={pattern ? `${pattern.pieces.length} pièces` : undefined}>
        <div className="rounded-lg border border-line bg-white/60 p-3">
          {pattern ? <PatternSvg pattern={pattern} cutting={cutting} /> : <p className="text-xs text-muted">Calcul…</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            <Legend color={SEAM_COLORS.shoulder} label="Épaules" />
            <Legend color={SEAM_COLORS.side} label="Côtés" />
            <Legend color={SEAM_COLORS.arm} label="Emmanchures" />
            <Legend color={SEAM_COLORS.underBack} label="Dessous de bras" />
            <Legend color="var(--color-ink)" label="Coupe (marges incluses)" thin />
          </div>
        </div>
      </Section>

      {pattern && (
        <Section title="Cotes">
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center text-xs">
            {(
              [
                ["Tour de poitrine", pattern.dims.chestWidth],
                ["Tour de bas", pattern.dims.hemWidth],
                ["Longueur", pattern.dims.length],
                ["Emmanchure", pattern.dims.armhole],
                ["Tête de manche", pattern.dims.capHeight],
                ["Tour de bras", pattern.dims.bicep],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="bg-panel px-1 py-2">
                <dt className="text-[10px] text-muted">{k}</dt>
                <dd className="font-semibold tabular-nums">{v.toFixed(1)} cm</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="Coupe">
        <div className="space-y-4">
          <RangeField
            label="Longueur"
            min={45}
            max={95}
            value={params.length > 0 ? params.length : Math.round(autoLength ?? 45)}
            display={params.length > 0 ? `${params.length} cm` : `auto · ${autoLength?.toFixed(0) ?? "—"} cm`}
            onChange={(v) => onParams({ ...params, length: v })}
            onDoubleClick={() => onParams({ ...params, length: 0 })}
          />
          {SLIDERS.map((s) => (
            <RangeField
              key={s.key}
              label={s.label}
              min={s.min}
              max={s.max}
              value={params[s.key]}
              display={`${params[s.key]} cm`}
              onChange={(v) => onParams({ ...params, [s.key]: v })}
            />
          ))}
        </div>
      </Section>

      <ExportSection pattern={pattern} cutting={cutting} onCutting={onCutting} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onResew}
          className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
        >
          Recoudre
        </button>
        <span className="text-[11px] text-muted">
          {simulating ? `Couture et drapé… ${Math.round(progress * 100)} %` : "Le patron suit la morphologie du mannequin."}
        </span>
      </div>
    </>
  );
}

function Legend({ color, label, thin }: { color: string; label: string; thin?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`${thin ? "h-px" : "h-0.5"} w-3 rounded`} style={{ background: color }} />
      {label}
    </span>
  );
}
