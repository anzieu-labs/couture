"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { localSpans, localTapes, type LocalSpan } from "@/lib/avatar/localMeasures";
import type { Morphology } from "@/lib/avatar/morphology";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

/** Pause in the sliders after which the body is measured again (ms). */
const DELAY = 200;

/** A tape measure taken on the body (cm), and the value its local change had then. */
export interface LocalTape {
  cm: number;
  at: number;
}

/** Runs a generator one step per task, so that the page stays responsive; returns how to stop it. */
function spread<T>(run: Generator<T>, each: (value: T) => void, done?: () => void, delay = DELAY) {
  let timer = setTimeout(function next() {
    const step = run.next();
    if (step.done) return done?.();
    each(step.value);
    timer = setTimeout(next);
  }, delay);
  return () => clearTimeout(timer);
}

/**
 * The local changes in centimetres (lib/avatar/localMeasures.ts): `tapes`, each one's measure
 * on the body as it is, taken once the sliders rest; `spans`, what each adds to its measure on
 * the current silhouette, to follow a slider while it moves. Measured while `active` only, one
 * local change per task: the spans of all of them at once would freeze the page for a while.
 */
export function useLocalSpans(viewerRef: RefObject<GarmentViewer | null>, ready: boolean, morph: Morphology, active: boolean) {
  const [spans, setSpans] = useState<Record<string, LocalSpan>>({});
  const [tapes, setTapes] = useState<Record<string, LocalTape>>({});
  const measured = useRef("");
  const { gender, ageYears, statureCm, weight, muscle, proportions, cupsize, firmness } = morph;

  useEffect(() => {
    const model = ready && active && viewerRef.current?.model;
    if (!model) return;
    return spread(localTapes(model, morph), ([key, cm]) => setTapes((t) => ({ ...t, [key]: { cm, at: morph.local[key] ?? 0 } })));
  }, [ready, active, viewerRef, morph]);

  useEffect(() => {
    const model = ready && active && viewerRef.current?.model;
    if (!model) return;
    const silhouette = { gender, ageYears, statureCm, weight, muscle, proportions, cupsize, firmness, local: {} };
    const id = JSON.stringify(silhouette);
    if (measured.current === id) return;
    // After the tapes: they are what is shown.
    return spread(localSpans(model, silhouette), ([key, span]) => setSpans((s) => ({ ...s, [key]: span })), () => (measured.current = id), 2 * DELAY);
  }, [ready, active, viewerRef, gender, ageYears, statureCm, weight, muscle, proportions, cupsize, firmness]);

  return { spans, tapes };
}
