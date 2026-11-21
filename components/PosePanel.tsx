"use client";

import { ARM_SPREAD, CADENCE } from "@/lib/avatar/motion";
import { RangeField } from "./RangeField";
import { Section } from "./Section";

interface Props {
  /** Arm spread (degrees from the body); null: rest pose. */
  armSpread: number | null;
  /** Arm spread of the rest pose, for display. */
  restArmSpread: number;
  onArmSpread: (degrees: number | null) => void;
  cadence: number;
  onCadence: (stepsPerMinute: number) => void;
  walking: boolean;
  onWalking: (on: boolean) => void;
  onTurn: () => void;
  /** Some arm is placed by its hand (3D handles). */
  handsPlaced: boolean;
  onReleaseHands: () => void;
}

const pill =
  "rounded-full border border-line bg-white/60 px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-muted aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white";

/** Mannequin pose and motions: arm spread, walk (with its cadence) and turn. */
export function PosePanel({
  armSpread, restArmSpread, onArmSpread, cadence, onCadence, walking, onWalking, onTurn, handsPlaced, onReleaseHands,
}: Props) {
  const arms = armSpread ?? Math.round(restArmSpread);
  return (
    <>
      <Section title="Bras">
        <RangeField
          label="Écartement des bras"
          value={arms}
          min={ARM_SPREAD.min}
          max={ARM_SPREAD.max}
          display={`${arms}°${armSpread === null ? " · repos" : ""}`}
          ends={["Le long du corps", "Écartés"]}
          onChange={onArmSpread}
          onDoubleClick={() => onArmSpread(null)}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-muted">
            Le vêtement est cousu bras en A (pose de repos), puis les bras prennent l&apos;angle choisi.
          </p>
          <button type="button" className={pill} onClick={() => onArmSpread(null)} disabled={armSpread === null}>
            Repos
          </button>
        </div>
      </Section>

      <Section title="Mains">
        <p className="text-[11px] leading-relaxed text-muted">
          Chaque poignet porte un repère à trois axes dans la vue 3D : une flèche déplace la main sur son axe (rouge :
          côté, vert : hauteur, bleu : avant / arrière), le centre la déplace librement face à la caméra. Le bras suit,
          le coude se place seul. Chaque bras est indépendant ; le curseur d&apos;écartement ou « Repos » les rend au
          réglage commun.
        </p>
        <button type="button" className={`${pill} mt-3 disabled:opacity-40`} onClick={onReleaseHands} disabled={!handsPlaced}>
          Libérer les mains
        </button>
      </Section>

      <Section title="Mouvement">
        <div className="mb-4 flex gap-2">
          <button type="button" className={pill} aria-pressed={walking} onClick={() => onWalking(!walking)}>
            Marche
          </button>
          <button type="button" className={pill} onClick={onTurn}>
            Tour complet
          </button>
        </div>
        <RangeField
          label="Vitesse de marche"
          value={cadence}
          min={CADENCE.min}
          max={CADENCE.max}
          step={5}
          display={`${cadence} pas/min`}
          ends={["Lente", "Rapide"]}
          onChange={onCadence}
          onDoubleClick={() => onCadence(CADENCE.default)}
        />
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Marche sur place ; elle démarre une fois le vêtement cousu. La foulée s&apos;allonge avec la vitesse.
        </p>
      </Section>
    </>
  );
}
