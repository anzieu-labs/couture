"use client";

import { FIT_RAMP, FIT_SCALES, type FitMode } from "@/lib/viewer/fitMap";

const format = (mode: FitMode, v: number) =>
  mode === "stretch" ? `${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}` : String(v);

/** Colour scale of the fit map. */
export function FitLegend({ mode }: { mode: FitMode }) {
  const scale = FIT_SCALES[mode];
  return (
    <div className="w-56 rounded-lg border border-line bg-white/85 px-3 py-2.5 text-[11px] text-muted shadow-sm backdrop-blur">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-semibold text-ink">{scale.label}</span>
        <span>{scale.unit}</span>
      </div>
      <div className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${FIT_RAMP.join(", ")})` }} />
      <div className="mt-1 flex justify-between tabular-nums">
        {scale.ticks.map((t, i) => (
          <span key={t}>
            {format(mode, t)}
            {i === scale.ticks.length - 1 ? "+" : ""}
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between">
        <span>libre</span>
        <span>serré</span>
      </div>
    </div>
  );
}
