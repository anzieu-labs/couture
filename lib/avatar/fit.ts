import type { AnnyModel, LocalChanges } from "./anny";
import { measureBody, type Measurements } from "./measure";
import { toPhenotype, type Morphology } from "./morphology";

/**
 * Inverse problem: find the Anny local changes giving target girths.
 * Each girth has a dedicated local change whose effect is linear on each side
 * of 0 (separate "+" and "−" blendshapes) and nearly independent from the
 * others, so a one-sided secant step plus one correction is enough.
 */

export type Girth = "bust" | "waist" | "hips";
export type GirthTargets = Partial<Record<Girth, number>>;

export const GIRTH_LOCAL_CHANGE: Record<Girth, string> = {
  bust: "measure-bust-circ-incr",
  waist: "measure-waist-circ-incr",
  hips: "measure-hips-circ-incr",
};

export interface FitResult {
  morph: Morphology;
  achieved: Measurements;
  /** Girths whose target is out of reach (local change saturated at ±1). */
  saturated: Girth[];
}

function measureMorphology(model: AnnyModel, m: Morphology, local: LocalChanges, scratch: Float32Array): Measurements {
  const ph = toPhenotype(m);
  ph.height = model.solveHeight(ph, local, m.statureCm / 100);
  return measureBody(model.compute(ph, local, scratch), model.indices);
}

export function fitGirths(model: AnnyModel, m: Morphology, targets: GirthTargets): FitResult {
  const keys = (Object.keys(targets) as Girth[]).filter((k) => targets[k] !== undefined);
  const buf = new Float32Array(model.vertexCount * 3);
  const withValues = (v: Partial<Record<Girth, number>>): LocalChanges => {
    const local = { ...m.local };
    for (const k of keys) local[GIRTH_LOCAL_CHANGE[k]] = v[k] ?? 0;
    return local;
  };
  const all = (x: number) => Object.fromEntries(keys.map((k) => [k, x]));

  const m0 = measureMorphology(model, m, withValues(all(0)), buf);
  const mp = measureMorphology(model, m, withValues(all(1)), buf);
  const mn = measureMorphology(model, m, withValues(all(-1)), buf);
  const slope = (k: Girth, v: number) => (v >= 0 ? mp[k] - m0[k] : m0[k] - mn[k]) || 1;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  const v: Partial<Record<Girth, number>> = {};
  for (const k of keys) {
    const d = targets[k]! - m0[k];
    v[k] = clamp(d / slope(k, d));
  }
  // One correction step from the actual result (small cross-coupling).
  const m1 = measureMorphology(model, m, withValues(v), buf);
  for (const k of keys) v[k] = clamp(v[k]! + (targets[k]! - m1[k]) / slope(k, v[k]!));

  const local = withValues(v);
  const achieved = measureMorphology(model, m, local, buf);
  const saturated = keys.filter((k) => Math.abs(v[k]!) >= 1 && Math.abs(achieved[k] - targets[k]!) > 0.5);
  return { morph: { ...m, local }, achieved, saturated };
}
