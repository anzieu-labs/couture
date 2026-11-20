import { capeAutoLength, DEFAULT_CAPE, draftCape, type CapeParams } from "./cape";
import { DEFAULT_SKIRT, draftSkirt, skirtAutoLength, type SkirtParams } from "./skirt";
import { DEFAULT_TSHIRT, draftTShirt, type TShirtParams } from "./tshirt";
import type { BodyMeasures, GarmentKind, Pattern, PatternEdits } from "./types";

/** Catalogue of garments: how to draft them and which settings the panel shows. */

export type GarmentParams = Record<string, number>;

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Value 0 means "automatic", worked out from the body (double-click on the slider). */
  auto?: (m: BodyMeasures) => number;
}

export interface GarmentDef {
  id: GarmentKind;
  name: string;
  /** Short label. */
  short: string;
  /** One line under the name in the garment picker. */
  description: string;
  /** Picture of the draped garment (public/, captured by tools/thumbnails). */
  image: string;
  params: ParamSpec[];
  defaults: GarmentParams;
  draft: (m: BodyMeasures, p: GarmentParams, edits: PatternEdits) => Pattern;
}

export const GARMENTS: GarmentDef[] = [
  {
    id: "tshirt",
    name: "T-shirt col rond",
    short: "T-shirt",
    description: "Manches courtes, coupe droite. Devant, dos et deux manches.",
    image: "/garments/tshirt.webp",
    params: [
      { key: "length", label: "Longueur", min: 45, max: 95, auto: (m) => Math.round(m.hpsToHip + 10) },
      { key: "chestEase", label: "Aisance poitrine", min: -12, max: 30 },
      { key: "sleeveEase", label: "Aisance manche", min: -4, max: 16 },
      { key: "sleeveLength", label: "Longueur de manche", min: 12, max: 40 },
    ],
    defaults: { ...DEFAULT_TSHIRT },
    draft: (m, p, e) => draftTShirt(m, p as unknown as TShirtParams, e),
  },
  {
    id: "cape",
    name: "Cape à capuche",
    short: "Cape",
    description: "Cercle complet ouvert devant, capuche pointue. Dos, deux devants, capuche en deux pièces.",
    image: "/garments/cape.webp",
    params: [
      { key: "length", label: "Longueur", min: 40, max: 150, auto: capeAutoLength },
      { key: "neckEase", label: "Aisance d'encolure", min: 2, max: 16 },
      { key: "hoodHeight", label: "Hauteur de capuche (aisance)", min: 2, max: 20 },
      { key: "hoodDepth", label: "Profondeur de capuche (aisance)", min: 4, max: 24 },
      { key: "hoodPoint", label: "Pointe de capuche", min: 0, max: 25 },
    ],
    defaults: { ...DEFAULT_CAPE },
    draft: (m, p, e) => draftCape(m, p as unknown as CapeParams, e),
  },
  {
    id: "skirt",
    name: "Jupe trapèze",
    short: "Jupe",
    description: "Taille naturelle, évasée sous la hanche, sans pinces. Devant et dos.",
    image: "/garments/skirt.webp",
    params: [
      { key: "length", label: "Longueur", min: 35, max: 110, auto: skirtAutoLength },
      { key: "waistEase", label: "Aisance taille", min: 0, max: 10 },
      { key: "hipEase", label: "Aisance hanches", min: 0, max: 16 },
      { key: "flare", label: "Évasement (par côté)", min: 0, max: 30 },
    ],
    defaults: { ...DEFAULT_SKIRT },
    draft: (m, p, e) => draftSkirt(m, p as unknown as SkirtParams, e),
  },
];

export const garmentDef = (id: GarmentKind) => GARMENTS.find((g) => g.id === id)!;
