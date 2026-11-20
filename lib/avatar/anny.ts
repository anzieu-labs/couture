/**
 * Browser runtime for the parametric mannequin exported by
 * tools/mannequin/export.py from Anny (NAVER LABS Europe, Apache-2.0;
 * MakeHuman/MPFB2 assets, CC0).
 *
 * rest shape = base + Σ a_r · pca_r + Σ |lc_i| · localChange_i(±)
 * where the PCA coefficients `a` are an affine function of the MakeHuman macro
 * weights, each being a product of 1-D linear interpolation coefficients of the
 * phenotype sliders (same formula as anny.models.phenotype).
 */

export type PhenotypeLabel =
  | "gender" | "age" | "muscle" | "weight" | "height" | "proportions" | "cupsize" | "firmness";

export interface AnnyMeta {
  vertexCount: number;
  phenotypes: { label: PhenotypeLabel; min: number; max: number; default: number }[];
  race: Record<string, number>;
  anchors: Record<string, number[]>;
  variations: Record<string, string[]>;
  variationColumns: string[];
  macroTargets: number[][];
  pca: { rank: number; W: number[][]; b: number[] };
  localChanges: string[];
  targets: { name: string; scale: number }[];
  bones: {
    labels: string[];
    /** Index of each joint's parent in `labels` (-1: root). */
    parents: number[];
    base: number[];
    W: number[][];
    localChanges: number[][];
  };
}

/** Per-vertex skin influences on the joints of `meta.bones` (4 per vertex, weights sum to 255). */
export interface SkinWeights {
  index: Uint8Array;
  weight: Uint8Array;
}

export type Phenotype = Record<PhenotypeLabel, number>;
export type LocalChanges = Record<string, number>;

export interface BodyShape {
  /** xyz positions, meters, feet NOT yet grounded. */
  positions: Float32Array;
  /** Key joints (glTF frame), by label. */
  joints: Record<string, [number, number, number]>;
}

/** Anny calibration: morphological age (years) ↔ Anny `age` parameter. */
const AGE_YEARS = [16, 18, 64, 110];
const AGE_ANNY = [0.67, 0.77, 0.83, 1.0];

function piecewise(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++)
    if (x <= xs[i]) return ys[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
  return ys[ys.length - 1];
}
export const yearsToAnnyAge = (years: number) => piecewise(years, AGE_YEARS, AGE_ANNY);

/** anny.utils.interpolation.linear_interpolation_coefficients (no extrapolation). */
function interpolationCoefficients(value: number, anchors: number[]): number[] {
  const n = anchors.length;
  const v = Math.min(Math.max(value, anchors[0]), anchors[n - 1]);
  let i = 1;
  while (i < n - 1 && anchors[i] < v) i++;
  const t = (v - anchors[i - 1]) / (anchors[i] - anchors[i - 1]);
  const w = new Array(n).fill(0);
  w[i - 1] = 1 - t;
  w[i] = t;
  return w;
}

export class AnnyModel {
  readonly vertexCount: number;
  private readonly pcaDeltas: Float32Array[]; // real-scale deltas
  private readonly lcPlus = new Map<string, Float32Array>();
  private readonly lcMinus = new Map<string, Float32Array>();
  private readonly lcBones = new Map<string, { plus: number[]; minus: number[] }>();
  /** Scratch buffer for the stature probes. */
  private probe: Float32Array | null = null;

  constructor(
    readonly meta: AnnyMeta,
    readonly base: Float32Array,
    readonly indices: Uint16Array | Uint32Array,
    /** Real-scale deltas for every target, in meta.targets order. */
    deltas: Float32Array[],
    /** Skin influences, the same for every morphology. */
    readonly skin: SkinWeights,
  ) {
    this.vertexCount = meta.vertexCount;
    const byName = new Map(meta.targets.map((t, i) => [t.name, deltas[i]]));
    this.pcaDeltas = Array.from({ length: meta.pca.rank }, (_, r) => byName.get(`pca${String(r).padStart(2, "0")}`)!);
    meta.localChanges.forEach((label, i) => {
      this.lcPlus.set(label, byName.get(`lc:${label}:+`)!);
      this.lcMinus.set(label, byName.get(`lc:${label}:-`)!);
      this.lcBones.set(label, { plus: meta.bones.localChanges[2 * i], minus: meta.bones.localChanges[2 * i + 1] });
    });
  }

  defaults(): Phenotype {
    return Object.fromEntries(this.meta.phenotypes.map((p) => [p.label, p.default])) as Phenotype;
  }

  /** MakeHuman macro-target weights for a phenotype. */
  private macroWeights(ph: Phenotype): Float64Array {
    const col: Record<string, number> = {};
    for (const [feature, vars] of Object.entries(this.meta.variations)) {
      if (feature === "race") {
        for (const k of vars) col[k] = this.meta.race[k];
      } else {
        const w = interpolationCoefficients(ph[feature as PhenotypeLabel], this.meta.anchors[feature]);
        vars.forEach((k, i) => (col[k] = w[i]));
      }
    }
    const cols = this.meta.variationColumns.map((c) => col[c]);
    const rows = this.meta.macroTargets;
    const w = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      let p = 1;
      for (const c of rows[r]) p *= cols[c];
      w[r] = p;
    }
    return w;
  }

  /** Computes the rest shape. Pass `yOnly` to fill only the Y coordinates (fast probe). */
  compute(ph: Phenotype, lc: LocalChanges = {}, out?: Float32Array, yOnly = false): BodyShape {
    const { pca, bones } = this.meta;
    const w = this.macroWeights(ph);
    const a = Float64Array.from(pca.b);
    for (let r = 0; r < w.length; r++) {
      const wr = w[r];
      if (wr === 0) continue;
      const row = pca.W[r];
      for (let k = 0; k < a.length; k++) a[k] += wr * row[k];
    }

    const n = this.vertexCount * 3;
    const pos = out ?? new Float32Array(n);
    pos.set(this.base);
    const start = yOnly ? 1 : 0, step = yOnly ? 3 : 1;
    const accumulate = (d: Float32Array, s: number) => {
      if (s === 0) return;
      for (let i = start; i < n; i += step) pos[i] += s * d[i];
    };
    for (let r = 0; r < a.length; r++) accumulate(this.pcaDeltas[r], a[r]);
    for (const [label, x] of Object.entries(lc)) {
      if (!x) continue;
      accumulate((x > 0 ? this.lcPlus : this.lcMinus).get(label)!, Math.abs(x));
    }

    // Joints: template + w @ W (+ local change deltas)
    const j = Float64Array.from(bones.base);
    for (let r = 0; r < w.length; r++) {
      const wr = w[r];
      if (wr === 0) continue;
      const row = bones.W[r];
      for (let k = 0; k < j.length; k++) j[k] += wr * row[k];
    }
    for (const [label, x] of Object.entries(lc)) {
      if (!x) continue;
      const d = x > 0 ? this.lcBones.get(label)!.plus : this.lcBones.get(label)!.minus;
      for (let k = 0; k < j.length; k++) j[k] += Math.abs(x) * d[k];
    }
    const joints: BodyShape["joints"] = {};
    bones.labels.forEach((l, i) => (joints[l] = [j[3 * i], j[3 * i + 1], j[3 * i + 2]]));
    return { positions: pos, joints };
  }

  /** Stature (m) of a computed shape. */
  static stature(pos: Float32Array): number {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const y = pos[i];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return hi - lo;
  }

  /**
   * Finds the `height` parameter giving a target stature (m), all other
   * parameters fixed. Stature is linear in `height`, so two probes suffice.
   */
  solveHeight(ph: Phenotype, lc: LocalChanges, statureM: number): number {
    const buf = (this.probe ??= new Float32Array(this.vertexCount * 3));
    const h0 = 0.25, h1 = 0.75;
    const s0 = AnnyModel.stature(this.compute({ ...ph, height: h0 }, lc, buf, true).positions);
    const s1 = AnnyModel.stature(this.compute({ ...ph, height: h1 }, lc, buf, true).positions);
    const h = h0 + ((statureM - s0) * (h1 - h0)) / (s1 - s0);
    const range = this.meta.phenotypes.find((p) => p.label === "height")!;
    return Math.min(range.max, Math.max(range.min, h));
  }
}
