"use client";

import { CADENCE, RUN_CADENCE, type Posture } from "@/lib/avatar/motion";
import { RangeField } from "./RangeField";
import { Section } from "./Section";

interface Props {
  posture: Posture;
  onPosture: (posture: Posture) => void;
  walking: boolean;
  onWalking: (on: boolean) => void;
  cadence: number;
  onCadence: (stepsPerMinute: number) => void;
}

const pill =
  "rounded-full border border-line bg-white/60 px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-muted aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white";

const POSTURES: { id: Posture; label: string }[] = [
  { id: "sitting", label: "Assise" },
  { id: "squatting", label: "Accroupie" },
];

/** Mannequin posture: standing, walking or running (by its cadence), seated, squatting. */
export function PosePanel({ posture, onPosture, walking, onWalking, cadence, onCadence }: Props) {
  const gait = cadence >= RUN_CADENCE.to ? "course" : cadence > RUN_CADENCE.from ? "trot" : "marche";
  return (
    <Section title="Posture">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={pill}
          aria-pressed={!walking && posture === "standing"}
          onClick={() => {
            onWalking(false);
            onPosture("standing");
          }}
        >
          Debout
        </button>
        <button type="button" className={pill} aria-pressed={walking} onClick={() => onWalking(!walking)}>
          {cadence >= RUN_CADENCE.to ? "Course" : "Marche"}
        </button>
        {POSTURES.map((p) => (
          <button key={p.id} type="button" className={pill} aria-pressed={!walking && posture === p.id} onClick={() => onPosture(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {walking && (
        <RangeField
          className="mt-4"
          label="Cadence"
          value={cadence}
          min={CADENCE.min}
          max={CADENCE.max}
          step={5}
          display={`${cadence} pas/min · ${gait}`}
          ends={["Marche lente", "Course"]}
          onChange={onCadence}
          onDoubleClick={() => onCadence(CADENCE.default)}
        />
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Le vêtement est cousu debout, bras le long du corps, puis le mannequin prend la posture ; les pieds restent au
        sol. La marche se fait sur place : la foulée s&apos;allonge avec la cadence, et au-delà de {RUN_CADENCE.from}{" "}
        pas/min elle devient une course.
      </p>
    </Section>
  );
}
