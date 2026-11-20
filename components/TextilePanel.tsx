"use client";

import { PALETTE, TEXTILES, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import { RangeField } from "./RangeField";
import { Section } from "./Section";
import { Swatch } from "./Swatch";

interface Props {
  textile: Textile;
  onTextile: (id: string) => void;
  colorsById: Record<string, TextileColors>;
  onColor: (key: keyof TextileColors, hex: string) => void;
  scale: number;
  onScale: (s: number) => void;
}

export function TextilePanel({ textile, onTextile, colorsById, onColor, scale, onScale }: Props) {
  const colors = colorsById[textile.id];
  return (
    <>
      <Section title="Tissu">
        <div className="grid grid-cols-3 gap-2.5">
          {TEXTILES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTextile(t.id)}
              aria-pressed={t.id === textile.id}
              className="group flex flex-col gap-1.5 text-left"
            >
              <Swatch
                textile={t}
                colors={colorsById[t.id]}
                className="aspect-square w-full rounded-md ring-1 ring-line transition group-hover:ring-muted group-aria-pressed:ring-2 group-aria-pressed:ring-ink group-aria-pressed:ring-offset-2 group-aria-pressed:ring-offset-panel"
              />
              <span className="truncate text-[11px] leading-tight text-muted group-aria-pressed:font-medium group-aria-pressed:text-ink">
                {t.name}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title={textile.secondary ? "Couleur principale" : "Couleur"}>
        <ColorPicker value={colors.primary} onChange={(hex) => onColor("primary", hex)} />
      </Section>

      {textile.secondary && colors.secondary && (
        <Section title={`Couleur — ${textile.secondary.label.toLowerCase()}`}>
          <ColorPicker value={colors.secondary} onChange={(hex) => onColor("secondary", hex)} />
        </Section>
      )}

      <Section title="Motif">
        <RangeField label="Échelle" min={0.5} max={2.5} step={0.05} value={scale} display={`×${scale.toFixed(2)}`} onChange={onScale} />
      </Section>

      <Section title="Fiche technique">
        <TechSheet textile={textile} />
      </Section>
    </>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const isCustom = !PALETTE.some((p) => p.hex.toLowerCase() === value.toLowerCase());
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PALETTE.map((p) => (
        <button
          key={p.hex}
          type="button"
          title={p.name}
          aria-label={p.name}
          aria-pressed={p.hex.toLowerCase() === value.toLowerCase()}
          onClick={() => onChange(p.hex)}
          className="size-7 rounded-full ring-1 ring-black/10 transition aria-pressed:ring-2 aria-pressed:ring-ink aria-pressed:ring-offset-2 aria-pressed:ring-offset-panel"
          style={{ background: p.hex }}
        />
      ))}
      <label
        title="Couleur personnalisée"
        className={`relative size-7 cursor-pointer overflow-hidden rounded-full ring-1 ring-black/10 ${isCustom ? "ring-2 ring-ink ring-offset-2 ring-offset-panel" : ""}`}
        style={{
          background: isCustom ? value : "conic-gradient(#e0533b, #e8c33f, #6cbf5a, #3fa7d6, #7d5bd6, #d65ba8, #e0533b)",
        }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          aria-label="Couleur personnalisée"
        />
      </label>
    </div>
  );
}

function TechSheet({ textile: t }: { textile: Textile }) {
  const knit = t.family === "Maille";
  const rows: [string, string][] = [
    ["Famille", t.family],
    ["Armure", t.structure],
    ["Composition", t.composition],
    ["Grammage", `${t.weight} g/m²`],
    ["Élasticité", `${t.stretch.warp} % ${knit ? "colonne" : "chaîne"} · ${t.stretch.weft} % ${knit ? "rangée" : "trame"}`],
    ["Tombé", t.drape],
  ];
  return (
    <dl className="divide-y divide-line rounded-lg border border-line bg-white/60 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-3 py-2">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium first-letter:uppercase">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
