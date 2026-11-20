"use client";

import { useState } from "react";
import type { Girth, GirthTargets } from "@/lib/avatar/fit";
import type { Measurements } from "@/lib/avatar/measure";

interface Props {
  measurements: Measurements | null;
  statureCm: number;
  onStature: (cm: number) => void;
  targets: GirthTargets;
  onTargets: (t: GirthTargets) => void;
  saturated: Girth[];
  fitting: boolean;
}

const FIELDS: { key: "stature" | Girth; label: string; min: number; max: number }[] = [
  { key: "stature", label: "Stature", min: 150, max: 200 },
  { key: "bust", label: "Poitrine", min: 60, max: 160 },
  { key: "waist", label: "Taille", min: 50, max: 150 },
  { key: "hips", label: "Hanches", min: 70, max: 160 },
];

/** Measurements, readable and editable: typing a girth pins it and the body is fitted to it. */
export function MeasurementsCard({ measurements, statureCm, onStature, targets, onTargets, saturated, fitting }: Props) {
  return (
    <div>
      <div className="grid grid-cols-4 divide-x divide-line rounded-lg border border-line bg-white/60 text-center">
        {FIELDS.map((f) => {
          const pinned = f.key !== "stature" && targets[f.key] !== undefined;
          const measured = f.key === "stature" ? statureCm : measurements?.[f.key];
          return (
            <Field
              key={f.key}
              label={f.label}
              min={f.min}
              max={f.max}
              value={measured}
              pinned={pinned}
              warn={f.key !== "stature" && saturated.includes(f.key)}
              onCommit={(v) => (f.key === "stature" ? onStature(v) : onTargets({ ...targets, [f.key]: v }))}
              onUnpin={() => {
                const next = { ...targets };
                delete next[f.key as Girth];
                onTargets(next);
              }}
            />
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {fitting
          ? "Ajustement du corps…"
          : saturated.length
            ? "Valeur hors de portée des ajustements : modifiez aussi la corpulence ou la musculature."
            : "En cm. Saisissez une valeur pour la fixer ; le corps s'y adapte, même quand vous changez la silhouette."}
      </p>
    </div>
  );
}

function Field(props: {
  label: string;
  min: number;
  max: number;
  value: number | undefined;
  pinned: boolean;
  warn: boolean;
  onCommit: (v: number) => void;
  onUnpin: () => void;
}) {
  const { label, min, max, value, pinned, warn, onCommit, onUnpin } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(Math.round(value)) : "");

  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", "."));
    setDraft(null);
    if (Number.isFinite(v) && v > 0) onCommit(Math.min(max, Math.max(min, v)));
  };

  return (
    <div className="relative px-1 py-2">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
        <input
          inputMode="decimal"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraft(null);
          }}
          className={`mt-0.5 w-full rounded bg-transparent text-center text-sm font-semibold tabular-nums outline-none focus:bg-white focus:ring-1 focus:ring-ink ${warn ? "text-amber-700" : ""}`}
          aria-label={`${label} en cm`}
        />
      </label>
      {pinned && (
        <button
          type="button"
          onClick={onUnpin}
          title="Valeur fixée — cliquer pour libérer"
          aria-label={`Libérer ${label.toLowerCase()}`}
          className="absolute right-1 top-1 text-ink hover:text-muted"
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
            <path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z" />
          </svg>
        </button>
      )}
    </div>
  );
}
