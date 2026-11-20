"use client";

import { useState } from "react";
import { GIRTH_LOCAL_CHANGE, type Girth, type GirthTargets } from "@/lib/avatar/fit";
import type { Measurements } from "@/lib/avatar/measure";
import { LOCAL_CHANGE_LABELS, MORPHOLOGY_SLIDERS, type Morphology, type SliderDef } from "@/lib/avatar/morphology";
import { MeasurementsCard } from "./MeasurementsCard";
import { RangeField } from "./RangeField";
import { Section } from "./Section";

interface Props {
  value: Morphology;
  onChange: (m: Morphology) => void;
  measurements: Measurements | null;
  presets: Record<string, Morphology>;
  onPreset: (m: Morphology) => void;
  targets: GirthTargets;
  onTargets: (t: GirthTargets) => void;
  saturated: Girth[];
  fitting: boolean;
}

function sliderDisplay(s: SliderDef, v: number): string {
  if (s.format) return s.format(v);
  if (s.ends) return v < 0.35 ? s.ends[0] : v > 0.65 ? s.ends[2] : s.ends[1];
  return String(v);
}

export function MorphologyPanel(props: Props) {
  const { value, onChange, measurements, presets, onPreset, targets, onTargets, saturated, fitting } = props;
  const [showLocal, setShowLocal] = useState(false);
  const driven = new Set(
    (Object.keys(targets) as Girth[]).filter((k) => targets[k] !== undefined).map((k) => GIRTH_LOCAL_CHANGE[k]),
  );
  const localCount = Object.values(value.local).filter((v) => v !== 0).length;
  const setLocal = (key: string, v: number) => onChange({ ...value, local: { ...value.local, [key]: v } });

  return (
    <>
      <Section title="Mensurations">
        <MeasurementsCard
          measurements={measurements}
          statureCm={value.statureCm}
          onStature={(cm) => onChange({ ...value, statureCm: cm })}
          targets={targets}
          onTargets={onTargets}
          saturated={saturated}
          fitting={fitting}
        />
      </Section>

      <Section title="Silhouette">
        <div className="mb-4 flex gap-2">
          {Object.entries(presets).map(([name, preset]) => (
            <button
              key={name}
              type="button"
              onClick={() => onPreset(preset)}
              className="rounded-full border border-line bg-white/60 px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-muted"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="space-y-4">
          {MORPHOLOGY_SLIDERS.map((s) => (
            <RangeField
              key={s.key}
              label={s.label}
              min={s.min}
              max={s.max}
              step={s.step}
              value={value[s.key]}
              display={sliderDisplay(s, value[s.key])}
              ends={s.ends && [s.ends[0], s.ends[2]]}
              onChange={(v) => onChange({ ...value, [s.key]: v })}
            />
          ))}
        </div>
      </Section>

      <section>
        <button
          type="button"
          onClick={() => setShowLocal((s) => !s)}
          aria-expanded={showLocal}
          className="flex w-full items-baseline justify-between text-left"
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
            Ajustements de couture{localCount ? ` · ${localCount}` : ""}
          </h2>
          <span className="text-xs text-muted">{showLocal ? "Masquer" : "Afficher"}</span>
        </button>
        {showLocal && (
          <div className="mt-3 space-y-3.5">
            {Object.entries(LOCAL_CHANGE_LABELS).map(([key, label]) => {
              const v = value.local[key] ?? 0;
              const isDriven = driven.has(key);
              return (
                <RangeField
                  key={key}
                  label={
                    <span className="font-normal">
                      {label}
                      {isDriven && <span className="text-muted"> · piloté par la mensuration</span>}
                    </span>
                  }
                  min={-1}
                  max={1}
                  step={0.02}
                  value={v}
                  display={`${v > 0 ? "+" : ""}${Math.round(v * 100)} %`}
                  disabled={isDriven}
                  onChange={(x) => setLocal(key, x)}
                  onDoubleClick={() => setLocal(key, 0)}
                />
              );
            })}
            {localCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  onTargets({});
                  onChange({ ...value, local: {} });
                }}
                className="text-xs font-medium text-muted underline underline-offset-2 hover:text-ink"
              >
                Réinitialiser les ajustements
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
