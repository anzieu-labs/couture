import { yearsToAnnyAge, type LocalChanges, type Phenotype } from "./anny";

/** Morphology as edited in the UI (human units where it makes sense). */
export interface Morphology {
  gender: number; // 0 = homme, 1 = femme
  ageYears: number;
  statureCm: number;
  weight: number;
  muscle: number;
  proportions: number;
  cupsize: number;
  firmness: number;
  local: LocalChanges;
}

export const MALE: Morphology = {
  gender: 0, ageYears: 30, statureCm: 178, weight: 0.5, muscle: 0.5,
  proportions: 0.5, cupsize: 0.5, firmness: 0.5, local: {},
};
export const FEMALE: Morphology = { ...MALE, gender: 1, statureCm: 166 };

/** Phenotype without `height`, which is solved from the stature. */
export function toPhenotype(m: Morphology): Phenotype {
  return {
    gender: m.gender,
    age: yearsToAnnyAge(m.ageYears),
    muscle: m.muscle,
    weight: m.weight,
    height: 0.5,
    proportions: m.proportions,
    cupsize: m.cupsize,
    firmness: m.firmness,
  };
}

export interface SliderDef {
  key: Exclude<keyof Morphology, "local">;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Labels for the low end, the middle and the high end. */
  ends?: [string, string, string];
  format?: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

export const MORPHOLOGY_SLIDERS: SliderDef[] = [
  { key: "gender", label: "Morphotype", min: 0, max: 1, step: 0.01, ends: ["Homme", "Androgyne", "Femme"] },
  { key: "statureCm", label: "Stature", min: 150, max: 200, step: 1, format: (v) => `${v} cm` },
  { key: "ageYears", label: "Âge", min: 18, max: 80, step: 1, format: (v) => `${v} ans` },
  { key: "weight", label: "Corpulence", min: 0, max: 1, step: 0.01, ends: ["Mince", "Moyenne", "Forte"] },
  { key: "muscle", label: "Musculature", min: 0, max: 1, step: 0.01, ends: ["Faible", "Moyenne", "Athlétique"] },
  { key: "proportions", label: "Proportions", min: 0, max: 1, step: 0.01, ends: ["Classiques", "Moyennes", "Atypiques"] },
  { key: "cupsize", label: "Poitrine", min: 0, max: 1, step: 0.01, format: pct },
  { key: "firmness", label: "Fermeté", min: 0, max: 1, step: 0.01, format: pct },
];

/** Anny local changes exported by tools/mannequin/export.py, with French labels. */
export const LOCAL_CHANGE_LABELS: Record<string, string> = {
  "measure-shoulder-dist-incr": "Carrure",
  "measure-frontchest-dist-incr": "Largeur devant",
  "torso-vshape-incr": "Buste en V",
  "measure-bust-circ-incr": "Tour de poitrine",
  "measure-underbust-circ-incr": "Tour sous-poitrine",
  "measure-waist-circ-incr": "Tour de taille",
  "measure-hips-circ-incr": "Tour de hanches",
  "buttocks-volume-incr": "Fessiers",
  "stomach-pregnant-incr": "Ventre",
  "measure-napetowaist-dist-incr": "Longueur nuque-taille",
  "measure-waisttohip-dist-incr": "Hauteur taille-hanches",
  "measure-neck-circ-incr": "Tour de cou",
  "measure-upperarm-circ-incr": "Tour de bras",
  "measure-upperarm-length-incr": "Longueur de bras",
  "measure-lowerarm-length-incr": "Longueur d'avant-bras",
  "measure-thigh-circ-incr": "Tour de cuisse",
  "measure-upperleg-height-incr": "Hauteur de cuisse",
  "measure-lowerleg-height-incr": "Hauteur de jambe",
};
