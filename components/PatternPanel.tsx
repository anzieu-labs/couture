"use client";

import type { P2 } from "@/lib/pattern/curves";
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

/** Flat pattern pieces, laid out side by side (cm, y up → SVG y down). */
function PatternSvg({ pattern }: { pattern: Pattern }) {
  const shown = pattern.pieces.filter((p) => p.id !== "sleeve-");
  const gap = 6;
  const boxes = shown.map((piece) => {
    const pts = piece.edges.flatMap((e) => e.pts);
    return {
      piece,
      minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
    };
  });
  const offsets = boxes.map((_, i) => boxes.slice(0, i).reduce((s, b) => s + b.maxX - b.minX + gap, 0));
  const layout = boxes.map((b, i) => {
    const dx = offsets[i] - b.minX;
    return { piece: b.piece, dx, minY: b.minY, maxY: b.maxY, cx: dx + (b.minX + b.maxX) / 2 };
  });
  const last = boxes[boxes.length - 1];
  const cursor = offsets[offsets.length - 1] + last.maxX - last.minX + gap;
  const minY = Math.min(...layout.map((l) => l.minY)), maxY = Math.max(...layout.map((l) => l.maxY));
  const width = cursor - gap, height = maxY - minY;
  const tx = (p: P2, dx: number) => `${(p[0] + dx).toFixed(2)},${(maxY - p[1]).toFixed(2)}`;

  return (
    <svg viewBox={`-3 -3 ${width + 6} ${height + 12}`} className="w-full" role="img" aria-label="Patron du t-shirt">
      {layout.map(({ piece, dx, cx }) => {
        const outline = piece.edges.flatMap((e, i) => (i === 0 ? e.pts : e.pts.slice(1)));
        return (
          <g key={piece.id}>
            <path d={`M${outline.map((p) => tx(p, dx)).join("L")}Z`} fill="white" stroke="var(--color-ink)" strokeWidth={0.35} />
            {piece.edges.map((e) => {
              const c = seamColor(e.id);
              return c ? (
                <polyline key={e.id} points={e.pts.map((p) => tx(p, dx)).join(" ")} fill="none" stroke={c} strokeWidth={0.9} strokeLinecap="round" />
              ) : null;
            })}
            <line
              x1={piece.grain[0][0] + dx} y1={maxY - piece.grain[0][1]}
              x2={piece.grain[1][0] + dx} y2={maxY - piece.grain[1][1]}
              stroke="var(--color-muted)" strokeWidth={0.3} strokeDasharray="1.2 0.8" markerEnd="url(#grain)" markerStart="url(#grain)"
            />
            <text x={cx} y={height + 7} textAnchor="middle" fontSize={3.4} fill="var(--color-ink)">
              {piece.name}{piece.id === "sleeve+" ? " ×2" : ""}
            </text>
          </g>
        );
      })}
      <defs>
        <marker id="grain" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--color-muted)" />
        </marker>
      </defs>
    </svg>
  );
}

const SLIDERS: { key: keyof TShirtParams; label: string; min: number; max: number }[] = [
  { key: "chestEase", label: "Aisance poitrine", min: 0, max: 30 },
  { key: "sleeveEase", label: "Aisance manche", min: 2, max: 16 },
  { key: "sleeveLength", label: "Longueur de manche", min: 12, max: 40 },
];

export function PatternPanel({ pattern, params, onParams, autoLength, progress, onResew }: Props) {
  const simulating = progress > 0 && progress < 1;
  return (
    <>
      <Section title="Patron" aside={pattern ? `${pattern.pieces.length} pièces` : undefined}>
        <div className="rounded-lg border border-line bg-white/60 p-3">
          {pattern ? <PatternSvg pattern={pattern} /> : <p className="text-xs text-muted">Calcul…</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            <Legend color={SEAM_COLORS.shoulder} label="Épaules" />
            <Legend color={SEAM_COLORS.side} label="Côtés" />
            <Legend color={SEAM_COLORS.arm} label="Emmanchures" />
            <Legend color={SEAM_COLORS.underBack} label="Dessous de bras" />
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

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-0.5 w-3 rounded" style={{ background: color }} />
      {label}
    </span>
  );
}
