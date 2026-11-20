"use client";

interface Props {
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Text shown on the right of the label. */
  display?: React.ReactNode;
  /** Labels under both ends of the track. */
  ends?: [string, string];
  disabled?: boolean;
  onChange: (v: number) => void;
  onDoubleClick?: () => void;
  className?: string;
}

/** Labelled range slider used across the panels. */
export function RangeField({ label, value, min, max, step = 1, display, ends, disabled, onChange, onDoubleClick, className }: Props) {
  return (
    <label className={`block ${disabled ? "opacity-50" : ""} ${className ?? ""}`}>
      <span className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        {display !== undefined && <span className="shrink-0 tabular-nums text-muted">{display}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onDoubleClick}
        className="w-full accent-ink"
      />
      {ends && (
        <span className="flex justify-between text-[10px] text-muted">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </span>
      )}
    </label>
  );
}
