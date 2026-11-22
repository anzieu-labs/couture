import { CAPE, CAPE_CLASPS, capeAutoLength, capeletAutoLength, DEFAULT_CAPE, draftCape, type CapeParams, type CapeStyle } from "./cape";
import { DEFAULT_SKIRT, draftSkirt, longSkirtAutoLength, SKIRT, SKIRT_BELTS, skirtAutoLength, type SkirtParams, type SkirtStyle } from "./skirt";
import { DEFAULT_TSHIRT, draftTShirt, dressAutoLength, sleeveAutoLength, TSHIRT, tshirtAutoLength, type TShirtParams, type TShirtStyle } from "./tshirt";
import type { Belt, BodyMeasures, Clasp, GarmentKind, Pattern, PatternEdits } from "./types";

/**
 * Catalogue of garments: how to draft them and which settings the panel shows.
 *
 * A garment is a style (a t-shirt, a long skirt…) in one of two cuts, men's and women's: the
 * same draft, started from other settings — closer to the body, taken in at the waist, a lower
 * neckline, shorter sleeves for the women's — and its own picture. Either is drafted on the
 * mannequin's measurements whatever its morphology: the cut is the garment's, not the body's.
 * The styles are built on three blocks (t-shirt, cape, skirt: `kind`, which also says how the
 * garment is put on the body before sewing, lib/garment/place.ts).
 */

export type GarmentParams = Record<string, number>;

export type Cut = "homme" | "femme";
export const CUTS: readonly Cut[] = ["homme", "femme"];
export const CUT_LABELS: Record<Cut, string> = { homme: "Homme", femme: "Femme" };

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Value 0 means "automatic", worked out from the body (double-click on the slider). */
  auto?: (m: BodyMeasures) => number;
  /** Unit shown after the value (default: cm). */
  unit?: string;
  /** Labels under both ends of the slider, and the text shown instead of the value at its maximum. */
  ends?: [string, string];
  maxLabel?: string;
}

export interface GarmentDef {
  /** `<style>.<cut>`: what the interface selects and keeps settings and edits by. */
  id: string;
  style: string;
  cut: Cut;
  /** The block it is built on. */
  kind: GarmentKind;
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
  /** Clasps the garment comes with (lib/pattern/clasp.ts): where the user's own start from. */
  clasps?: readonly Clasp[];
  /** Belts it comes with (lib/pattern/belt.ts), likewise: a skirt's waistband. */
  belts?: readonly Belt[];
}

/** A style: what its two cuts share, and what each starts from. */
interface Style {
  id: string;
  kind: GarmentKind;
  name: string;
  short: string;
  params: ParamSpec[];
  draft: GarmentDef["draft"];
  clasps?: readonly Clasp[];
  belts?: readonly Belt[];
  cuts: Record<Cut, { description: string; defaults: GarmentParams }>;
}

// --- T-shirt block ------------------------------------------------------------------------

const tshirtDraft = (style: TShirtStyle): GarmentDef["draft"] => (m, p, e) => draftTShirt(m, p as unknown as TShirtParams, e, style);
const CHEST: ParamSpec = { key: "chestEase", label: "Aisance poitrine", min: -12, max: 30 };
const WAIST: ParamSpec = { key: "waist", label: "Cintrage à la taille (par côté)", min: 0, max: 8, step: 0.5 };
const NECK: ParamSpec = { key: "neckDrop", label: "Encolure (abaissée de)", min: 0, max: 14, step: 0.5 };
const SLEEVE_EASE: ParamSpec = { key: "sleeveEase", label: "Aisance manche", min: -4, max: 16 };

const LONG_SLEEVE: TShirtStyle = { name: "T-shirt manches longues", sleeves: true, autoLength: tshirtAutoLength };
const TANK: TShirtStyle = { name: "Débardeur", sleeves: false, autoLength: tshirtAutoLength };
const DRESS: TShirtStyle = { name: "Robe t-shirt", sleeves: true, autoLength: dressAutoLength };

// --- Cape and skirt blocks ----------------------------------------------------------------

const capeDraft = (style: CapeStyle): GarmentDef["draft"] => (m, p, e) => draftCape(m, p as unknown as CapeParams, e, style);
const CAPELET: CapeStyle = { name: "Pèlerine", hood: false, autoLength: capeletAutoLength };
const NECK_EASE: ParamSpec = { key: "neckEase", label: "Aisance d'encolure", min: 2, max: 16 };

const skirtDraft = (style: SkirtStyle): GarmentDef["draft"] => (m, p, e) => draftSkirt(m, p as unknown as SkirtParams, e, style);
const LONG_SKIRT: SkirtStyle = { name: "Jupe longue", autoLength: longSkirtAutoLength };
const skirtParams = (auto: (m: BodyMeasures) => number, longest: number): ParamSpec[] => [
  { key: "length", label: "Longueur", min: 35, max: longest, auto },
  { key: "waistEase", label: "Aisance taille", min: 0, max: 10 },
  { key: "hipEase", label: "Aisance hanches", min: 0, max: 16 },
  { key: "flare", label: "Évasement (par côté)", min: 0, max: 30 },
];

const STYLES: Style[] = [
  {
    id: "tshirt",
    kind: "tshirt",
    name: TSHIRT.name,
    short: "T-shirt",
    params: [
      { key: "length", label: "Longueur", min: 45, max: 95, auto: tshirtAutoLength },
      CHEST,
      WAIST,
      NECK,
      SLEEVE_EASE,
      { key: "sleeveLength", label: "Longueur de manche", min: 12, max: 40 },
    ],
    draft: tshirtDraft(TSHIRT),
    cuts: {
      homme: { description: "Manches courtes, coupe droite. Devant, dos et deux manches.", defaults: { ...DEFAULT_TSHIRT, waist: 0, neckDrop: 0 } },
      femme: {
        description: "Manches courtes, près du corps, cintré à la taille, encolure dégagée.",
        defaults: { ...DEFAULT_TSHIRT, chestEase: 5, waist: 2.5, neckDrop: 2.5, sleeveLength: 16, sleeveEase: 5 },
      },
    },
  },
  {
    id: "longsleeve",
    kind: "tshirt",
    name: LONG_SLEEVE.name,
    short: "Manches longues",
    params: [
      { key: "length", label: "Longueur", min: 45, max: 95, auto: tshirtAutoLength },
      CHEST,
      WAIST,
      NECK,
      SLEEVE_EASE,
      { key: "sleeveLength", label: "Longueur de manche", min: 30, max: 75, auto: sleeveAutoLength },
    ],
    draft: tshirtDraft(LONG_SLEEVE),
    cuts: {
      homme: { description: "Manches jusqu'au poignet, resserrées vers le bas, coupe droite.", defaults: { ...DEFAULT_TSHIRT, sleeveLength: 0, waist: 0, neckDrop: 0 } },
      femme: {
        description: "Manches jusqu'au poignet, près du corps, cintré à la taille.",
        defaults: { ...DEFAULT_TSHIRT, chestEase: 5, sleeveLength: 0, sleeveEase: 5, waist: 2.5, neckDrop: 2.5 },
      },
    },
  },
  {
    id: "tank",
    kind: "tshirt",
    name: TANK.name,
    short: "Débardeur",
    params: [
      { key: "length", label: "Longueur", min: 45, max: 95, auto: tshirtAutoLength },
      CHEST,
      WAIST,
      NECK,
      { key: "strap", label: "Largeur de bretelle", min: 3, max: 12, step: 0.5 },
      { key: "armDrop", label: "Emmanchure (abaissée de)", min: 0, max: 10, step: 0.5 },
    ],
    draft: tshirtDraft(TANK),
    cuts: {
      homme: { description: "Sans manches, larges bretelles, emmanchures basses. Devant et dos.", defaults: { ...DEFAULT_TSHIRT, chestEase: 8, waist: 0, neckDrop: 4, strap: 6, armDrop: 4 } },
      femme: {
        description: "Sans manches, bretelles fines, cintré, encolure basse. Devant et dos.",
        defaults: { ...DEFAULT_TSHIRT, chestEase: 3, waist: 2.5, neckDrop: 6, strap: 4, armDrop: 2 },
      },
    },
  },
  {
    id: "dress",
    kind: "tshirt",
    name: DRESS.name,
    short: "Robe",
    params: [
      { key: "length", label: "Longueur", min: 70, max: 130, auto: dressAutoLength },
      CHEST,
      WAIST,
      NECK,
      { key: "flare", label: "Évasement du bas (par côté)", min: 0, max: 20 },
      SLEEVE_EASE,
      { key: "sleeveLength", label: "Longueur de manche", min: 12, max: 40 },
    ],
    draft: tshirtDraft(DRESS),
    cuts: {
      homme: { description: "T-shirt long jusqu'au-dessus du genou, coupe droite, bas légèrement ouvert.", defaults: { ...DEFAULT_TSHIRT, waist: 0, neckDrop: 0, flare: 3 } },
      femme: {
        description: "Robe au-dessus du genou, cintrée à la taille, évasée sous la hanche.",
        defaults: { ...DEFAULT_TSHIRT, chestEase: 5, waist: 3, neckDrop: 3, flare: 6, sleeveLength: 16, sleeveEase: 5 },
      },
    },
  },
  {
    id: "cape",
    kind: "cape",
    name: CAPE.name,
    short: "Cape",
    params: [
      { key: "length", label: "Longueur", min: 40, max: 150, auto: capeAutoLength },
      NECK_EASE,
      { key: "hoodHeight", label: "Hauteur de capuche (aisance)", min: 2, max: 20 },
      { key: "hoodDepth", label: "Profondeur de capuche (aisance)", min: 4, max: 24 },
      { key: "hoodPoint", label: "Pointe de capuche", min: 0, max: 25 },
    ],
    draft: capeDraft(CAPE),
    clasps: CAPE_CLASPS,
    cuts: {
      homme: { description: "Cercle complet ouvert devant, fermé au cou par un fermoir, capuche pointue.", defaults: { ...DEFAULT_CAPE } },
      femme: { description: "Cercle complet ouvert devant, fermé au cou par un fermoir, capuche ronde et ample.", defaults: { ...DEFAULT_CAPE, hoodPoint: 0, hoodDepth: 13 } },
    },
  },
  {
    id: "capelet",
    kind: "cape",
    name: CAPELET.name,
    short: "Pèlerine",
    params: [{ key: "length", label: "Longueur", min: 20, max: 70, auto: capeletAutoLength }, NECK_EASE],
    draft: capeDraft(CAPELET),
    clasps: CAPE_CLASPS,
    cuts: {
      homme: { description: "Cape courte sans capuche, jusqu'au coude, fermée au cou par un fermoir.", defaults: { ...DEFAULT_CAPE } },
      femme: { description: "Cape courte sans capuche, sur les épaules, fermée au cou par un fermoir.", defaults: { ...DEFAULT_CAPE, length: 26, neckEase: 5 } },
    },
  },
  {
    id: "skirt",
    kind: "skirt",
    name: SKIRT.name,
    short: "Jupe",
    params: skirtParams(skirtAutoLength, 110),
    draft: skirtDraft(SKIRT),
    belts: SKIRT_BELTS,
    cuts: {
      homme: { description: "Jupe droite au genou, façon kilt : peu évasée, aisée aux hanches. Devant et dos.", defaults: { ...DEFAULT_SKIRT, hipEase: 6, flare: 5 } },
      femme: { description: "Taille naturelle, évasée sous la hanche, sans pinces. Devant et dos.", defaults: { ...DEFAULT_SKIRT } },
    },
  },
  {
    id: "longskirt",
    kind: "skirt",
    name: LONG_SKIRT.name,
    short: "Jupe longue",
    params: skirtParams(longSkirtAutoLength, 125),
    draft: skirtDraft(LONG_SKIRT),
    belts: SKIRT_BELTS,
    cuts: {
      homme: { description: "Jupe à la cheville, droite et aisée, assez ouverte en bas pour marcher.", defaults: { ...DEFAULT_SKIRT, hipEase: 6, flare: 12 } },
      femme: { description: "Jupe à la cheville, taille naturelle, bien évasée.", defaults: { ...DEFAULT_SKIRT, flare: 18 } },
    },
  },
];

export const garmentId = (style: string, cut: Cut) => `${style}.${cut}`;

/** Every garment: each style in both cuts. */
export const GARMENTS: GarmentDef[] = STYLES.flatMap(({ cuts, id, ...style }) =>
  CUTS.map((cut) => ({ ...style, ...cuts[cut], id: garmentId(id, cut), style: id, cut, image: `/garments/${id}-${cut}.webp` })),
);

/** The garments of a cut, in the catalogue's order. */
export const garmentsOf = (cut: Cut) => GARMENTS.filter((g) => g.cut === cut);

/** A garment by its id, or by its style and cut. */
export const garmentDef = (id: string, cut: Cut = "homme") => GARMENTS.find((g) => g.id === id || (g.style === id && g.cut === cut))!;
