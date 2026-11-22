import { seamKinds, type Pattern } from "@/lib/pattern/types";

/** Seam colours and legend labels, by seam kind (seam id without its "+" / "-" side). */
const SEAM_STYLES: Record<string, { color: string; label: string }> = {
  shoulder: { color: "#c0643e", label: "Épaules" },
  side: { color: "#3f7cac", label: "Côtés" },
  armFront: { color: "#8a6bb8", label: "Emmanchures" },
  armBack: { color: "#8a6bb8", label: "Emmanchures" },
  underarm: { color: "#4f9a6a", label: "Dessous de bras" },
  neckFront: { color: "#c49a2c", label: "Encolure" },
  neckBack: { color: "#c49a2c", label: "Encolure" },
  hood: { color: "#3f9a96", label: "Milieu de capuche" },
};

/** Colours of the seams that have no name of their own (a drawn pattern's: "shoulder·1", "e12·4"). */
const OTHER = ["#c0643e", "#3f7cac", "#8a6bb8", "#4f9a6a", "#c49a2c", "#3f9a96", "#b0527a", "#6b7f2a"];

export function seamColor(kind: string | undefined): string | null {
  if (!kind) return null;
  const numbered = kind.match(/^(.*)·(\d+)$/);
  if (!numbered) return SEAM_STYLES[kind]?.color ?? null;
  return SEAM_STYLES[numbered[1]]?.color ?? OTHER[(Number(numbered[2]) - 1) % OTHER.length];
}

/** Colour of an edge of a pattern piece, from the seam it belongs to. */
export function edgeColorer(pattern: Pattern): (piece: string, edge: string) => string | null {
  const kinds = seamKinds(pattern);
  return (piece, edge) => seamColor(kinds.get(`${piece}/${edge}`));
}

/** Legend entries for the seams of a pattern (one per label). */
export function seamLegend(pattern: Pattern): { color: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of pattern.seams) {
    const style = SEAM_STYLES[s.id.replace(/[+-]$/, "")];
    if (style && !seen.has(style.label)) seen.set(style.label, style.color);
  }
  return [...seen].map(([label, color]) => ({ label, color }));
}
