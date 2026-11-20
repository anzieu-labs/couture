/**
 * Textile library. Each entry carries:
 *  - optical parameters for the PBR material (roughness, sheen…),
 *  - the procedural pattern used to build its albedo/normal maps,
 *  - mechanical properties driving the XPBD cloth solver: bending rigidity
 *    (order of magnitude of Kawabata KES-F "B" measurements for the fabric
 *    type), elongation per grain direction, thickness and friction.
 */

export type Pattern =
  | "jersey"
  | "pique"
  | "rib"
  | "chunkyKnit"
  | "linen"
  | "denim"
  | "satin"
  | "velvet"
  | "breton"
  | "gingham";

export interface Textile {
  id: string;
  name: string;
  family: "Maille" | "Chaîne et trame" | "Velours";
  structure: string;
  composition: string;
  /** Grammage, g/m². */
  weight: number;
  /** Elongation under light load, % (warp/weft or wale/course). */
  stretch: { warp: number; weft: number };
  drape: "fluide" | "souple" | "structuré" | "rigide";
  pattern: Pattern;
  /** Physical size of one texture tile (m). */
  tile: number;
  roughness: number;
  sheen: number;
  sheenRoughness: number;
  normalStrength: number;
  defaultColor: string;
  /** Second colour (weft, stripe, check…) when the pattern uses one. */
  secondary?: { label: string; default: string };
  /** Bending rigidity B (N·m) — 1 gf·cm²/cm ≈ 9.8e-5 N·m. */
  bending: number;
  /** Thickness (mm). */
  thickness: number;
  /** Friction coefficient against the body. */
  friction: number;
}

export const TEXTILES: Textile[] = [
  {
    id: "jersey",
    name: "Jersey coton",
    family: "Maille",
    structure: "Jersey simple",
    composition: "100 % coton peigné",
    weight: 160,
    stretch: { warp: 8, weft: 25 },
    drape: "souple",
    pattern: "jersey",
    tile: 0.024,
    roughness: 0.88,
    sheen: 0.35,
    sheenRoughness: 0.6,
    normalStrength: 0.9,
    defaultColor: "#1f2f4f",
    bending: 5e-6,
    thickness: 0.6,
    friction: 0.45,
  },
  {
    id: "breton",
    name: "Marinière",
    family: "Maille",
    structure: "Jersey rayé fil à fil",
    composition: "100 % coton",
    weight: 200,
    stretch: { warp: 6, weft: 20 },
    drape: "souple",
    pattern: "breton",
    tile: 0.03,
    roughness: 0.86,
    sheen: 0.3,
    sheenRoughness: 0.6,
    normalStrength: 0.8,
    defaultColor: "#1c2a4a",
    secondary: { label: "Fond", default: "#f3efe6" },
    bending: 8e-6,
    thickness: 0.7,
    friction: 0.45,
  },
  {
    id: "pique",
    name: "Piqué",
    family: "Maille",
    structure: "Piqué nid d'abeille",
    composition: "100 % coton",
    weight: 210,
    stretch: { warp: 5, weft: 15 },
    drape: "structuré",
    pattern: "pique",
    tile: 0.02,
    roughness: 0.9,
    sheen: 0.25,
    sheenRoughness: 0.7,
    normalStrength: 1.2,
    defaultColor: "#f2efe8",
    bending: 1.5e-5,
    thickness: 1,
    friction: 0.5,
  },
  {
    id: "rib",
    name: "Côtes 2×2",
    family: "Maille",
    structure: "Bord-côte 2×2",
    composition: "95 % coton, 5 % élasthanne",
    weight: 230,
    stretch: { warp: 10, weft: 60 },
    drape: "souple",
    pattern: "rib",
    tile: 0.024,
    roughness: 0.9,
    sheen: 0.3,
    sheenRoughness: 0.6,
    normalStrength: 1.4,
    defaultColor: "#8a9a7b",
    bending: 1e-5,
    thickness: 1.2,
    friction: 0.5,
  },
  {
    id: "wool",
    name: "Grosse maille",
    family: "Maille",
    structure: "Jersey jauge 5",
    composition: "100 % laine mérinos",
    weight: 420,
    stretch: { warp: 12, weft: 30 },
    drape: "structuré",
    pattern: "chunkyKnit",
    tile: 0.06,
    roughness: 1,
    sheen: 0.6,
    sheenRoughness: 0.8,
    normalStrength: 2,
    defaultColor: "#d0a23a",
    bending: 5e-5,
    thickness: 4,
    friction: 0.6,
  },
  {
    id: "linen",
    name: "Lin lavé",
    family: "Chaîne et trame",
    structure: "Toile",
    composition: "100 % lin",
    weight: 185,
    stretch: { warp: 1, weft: 2 },
    drape: "souple",
    pattern: "linen",
    tile: 0.02,
    roughness: 0.82,
    sheen: 0.15,
    sheenRoughness: 0.7,
    normalStrength: 1,
    defaultColor: "#c9bba3",
    bending: 2e-5,
    thickness: 0.5,
    friction: 0.4,
  },
  {
    id: "denim",
    name: "Denim",
    family: "Chaîne et trame",
    structure: "Sergé 3/1",
    composition: "100 % coton",
    weight: 340,
    stretch: { warp: 1, weft: 2 },
    drape: "rigide",
    pattern: "denim",
    tile: 0.028,
    roughness: 0.84,
    sheen: 0.1,
    sheenRoughness: 0.7,
    normalStrength: 1,
    defaultColor: "#2b4a7a",
    secondary: { label: "Trame", default: "#e7e2d6" },
    bending: 1.2e-4,
    thickness: 1,
    friction: 0.4,
  },
  {
    id: "gingham",
    name: "Vichy",
    family: "Chaîne et trame",
    structure: "Toile à carreaux tissés",
    composition: "100 % coton",
    weight: 120,
    stretch: { warp: 1, weft: 2 },
    drape: "souple",
    pattern: "gingham",
    tile: 0.032,
    roughness: 0.8,
    sheen: 0.1,
    sheenRoughness: 0.6,
    normalStrength: 0.6,
    defaultColor: "#b5313a",
    secondary: { label: "Fond", default: "#f6f3ee" },
    bending: 8e-6,
    thickness: 0.3,
    friction: 0.35,
  },
  {
    id: "satin",
    name: "Satin de soie",
    family: "Chaîne et trame",
    structure: "Satin 5 lisses",
    composition: "100 % soie",
    weight: 90,
    stretch: { warp: 1, weft: 3 },
    drape: "fluide",
    pattern: "satin",
    tile: 0.01,
    roughness: 0.38,
    sheen: 0.8,
    sheenRoughness: 0.25,
    normalStrength: 0.25,
    defaultColor: "#6b1f2a",
    bending: 2e-6,
    thickness: 0.2,
    friction: 0.15,
  },
  {
    id: "velvet",
    name: "Velours",
    family: "Velours",
    structure: "Velours ras",
    composition: "82 % coton, 18 % modal",
    weight: 280,
    stretch: { warp: 2, weft: 4 },
    drape: "fluide",
    pattern: "velvet",
    tile: 0.05,
    roughness: 0.95,
    sheen: 1,
    sheenRoughness: 0.38,
    normalStrength: 0.35,
    defaultColor: "#3d2a5c",
    bending: 2.5e-5,
    thickness: 1.5,
    friction: 0.6,
  },
];

export const PALETTE: { name: string; hex: string }[] = [
  { name: "Blanc cassé", hex: "#f2efe8" },
  { name: "Gris chiné", hex: "#9b9a97" },
  { name: "Noir", hex: "#1d1d1f" },
  { name: "Marine", hex: "#1f2f4f" },
  { name: "Bleu ciel", hex: "#9cc0de" },
  { name: "Sauge", hex: "#8a9a7b" },
  { name: "Moutarde", hex: "#d0a23a" },
  { name: "Terracotta", hex: "#c0643e" },
  { name: "Bordeaux", hex: "#6b1f2a" },
  { name: "Rose poudré", hex: "#e3b7b0" },
];
