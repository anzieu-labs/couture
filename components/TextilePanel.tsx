"use client";

import { CUSTOM_TEXTILE, drapeOf, PALETTE, TEXTILE_FIELDS, TEXTILES, withLook, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import { RangeField } from "./RangeField";
import { Section } from "./Section";
import { Swatch } from "./Swatch";
import { textileSummary } from "./TextilePicker";

type Custom = Textile & { look: string };

interface Props {
  textile: Textile;
  /** The textile picker is asked for (it takes the place of the panel: Studio.tsx). */
  onPick: () => void;
  onCustom: (textile: Custom) => void;
  /** The colours of `textile` as shown. */
  colors: TextileColors;
  onColor: (key: keyof TextileColors, hex: string) => void;
}

export function TextilePanel({ textile, onPick, onCustom, colors, onColor }: Props) {
  return (
    <>
      <Section title="Tissu">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-white/60 p-2 pr-3">
          <Swatch textile={textile} colors={colors} className="size-14 shrink-0 rounded-lg ring-1 ring-line" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{textile.name}</p>
            <p className="truncate text-[11px] text-muted">{textileSummary(textile)}</p>
          </div>
          <button
            type="button"
            onClick={onPick}
            className="shrink-0 rounded-full border border-ink px-3 py-1.5 text-xs font-medium transition-colors hover:bg-ink hover:text-white"
          >
            Changer
          </button>
        </div>
      </Section>

      {textile.id === CUSTOM_TEXTILE && <CustomFields textile={textile as Custom} onChange={onCustom} />}

      <Section title={textile.secondary ? "Couleur principale" : "Couleur"}>
        <ColorPicker value={colors.primary} onChange={(hex) => onColor("primary", hex)} />
      </Section>

      {textile.secondary && colors.secondary && (
        <Section title={`Couleur — ${textile.secondary.label.toLowerCase()}`}>
          <ColorPicker value={colors.secondary} onChange={(hex) => onColor("secondary", hex)} />
        </Section>
      )}

      <Section title="Fiche technique">
        <TechSheet textile={textile} />
      </Section>
    </>
  );
}

const FIELD = "mt-1 w-full rounded-md border border-line bg-white/70 px-2 py-1.5 text-xs outline-none focus:border-ink";

/**
 * The user's own textile: every field of its technical sheet. Its look is borrowed from a
 * textile of the library; its mechanics — what the cloth is simulated with — are set here, and
 * the garment is sewn again in it as they change.
 */
function CustomFields({ textile: t, onChange }: { textile: Custom; onChange: (t: Custom) => void }) {
  const F = TEXTILE_FIELDS;
  const set = (patch: Partial<Custom>) => onChange({ ...t, ...patch });
  const text = (label: string, key: "name" | "structure" | "composition") => (
    <label className="block text-xs">
      <span className="font-medium">{label}</span>
      <input type="text" value={t[key]} maxLength={60} onChange={(e) => set({ [key]: e.target.value })} className={FIELD} />
    </label>
  );
  const num = (v: number, digits = 0) => v.toLocaleString("fr-FR", { maximumFractionDigits: digits });
  // Bending rigidity: three decades, set by its exponent.
  const lo = Math.log10(F.bending.min), hi = Math.log10(F.bending.max);
  return (
    <Section title="Tissu sur mesure">
      <div className="space-y-3.5">
        {text("Nom", "name")}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs">
            <span className="font-medium">Aspect</span>
            <select value={t.look} onChange={(e) => onChange(withLook(t, e.target.value))} className={FIELD}>
              {TEXTILES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium">Famille</span>
            <select value={t.family} onChange={(e) => set({ family: e.target.value as Textile["family"] })} className={FIELD}>
              {(["Maille", "Chaîne et trame", "Velours"] as const).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        </div>
        {text("Armure", "structure")}
        {text("Composition", "composition")}
        <RangeField label={F.weight.label} min={F.weight.min} max={F.weight.max} step={F.weight.step} value={t.weight} display={`${num(t.weight)} ${F.weight.unit}`} onChange={(weight) => set({ weight })} />
        <RangeField label={F.thickness.label} min={F.thickness.min} max={F.thickness.max} step={F.thickness.step} value={t.thickness} display={`${num(t.thickness, 2)} ${F.thickness.unit}`} onChange={(thickness) => set({ thickness })} />
        <RangeField
          label={F.bending.label}
          min={lo}
          max={hi}
          step={0.02}
          value={Math.log10(t.bending)}
          display={`${num(t.bending * 1e6, 1)} ${F.bending.unit} · ${drapeOf(t.bending)}`}
          ends={["fluide", "rigide"]}
          onChange={(e) => {
            const bending = Number((10 ** e).toPrecision(2));
            set({ bending, drape: drapeOf(bending) });
          }}
        />
        <RangeField label={F.warp.label} min={F.warp.min} max={F.warp.max} step={F.warp.step} value={t.stretch.warp} display={`${t.stretch.warp} ${F.warp.unit}`} onChange={(warp) => set({ stretch: { ...t.stretch, warp } })} />
        <RangeField label={F.weft.label} min={F.weft.min} max={F.weft.max} step={F.weft.step} value={t.stretch.weft} display={`${t.stretch.weft} ${F.weft.unit}`} onChange={(weft) => set({ stretch: { ...t.stretch, weft } })} />
        <RangeField label={F.friction.label} min={F.friction.min} max={F.friction.max} step={F.friction.step} value={t.friction} display={num(t.friction, 2)} onChange={(friction) => set({ friction })} />
        <p className="text-[11px] leading-relaxed text-muted">Le vêtement est recousu dans ce tissu à chaque changement de sa mécanique.</p>
      </div>
    </Section>
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
    ["Épaisseur", `${t.thickness.toLocaleString("fr-FR")} mm`],
    ["Rigidité en flexion", `${(t.bending * 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} µN·m`],
    ["Élasticité", `${t.stretch.warp} % ${knit ? "colonne" : "chaîne"} · ${t.stretch.weft} % ${knit ? "rangée" : "trame"}`],
    ["Tombé", t.drape],
    ["Frottement", t.friction.toLocaleString("fr-FR")],
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
