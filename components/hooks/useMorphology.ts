"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { fitGirths, type Girth, type GirthTargets } from "@/lib/avatar/fit";
import type { BodyMeasurement } from "@/lib/avatar/measure";
import { MALE, toPhenotype, type Morphology } from "@/lib/avatar/morphology";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

const MEASURE_DELAY = 150;
const FIT_DELAY = 220;

const hasPins = (t: GirthTargets) => Object.values(t).some((v) => v !== undefined);

/**
 * Morphology state → mannequin. The body is recomputed once per frame while a
 * slider moves; measurements follow once the user pauses; pinned girths are
 * re-fitted after every change.
 */
export function useMorphology(viewerRef: RefObject<GarmentViewer | null>, ready: boolean) {
  const [morph, setMorph] = useState<Morphology>(MALE);
  const [measurements, setMeasurements] = useState<BodyMeasurement | null>(null);
  const [targets, setTargets] = useState<GirthTargets>({});
  const [saturated, setSaturated] = useState<Girth[]>([]);
  const [fitting, setFitting] = useState(false);
  const lastFit = useRef<Morphology | null>(null);

  // Body: one recompute per frame, measurements once the user pauses.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const ph = toPhenotype(morph);
      ph.height = viewer.model.solveHeight(ph, morph.local, morph.statureCm / 100);
      viewer.setBody(ph, morph.local);
      // Counted from here: started with the frame's request, the delay could end before a slow
      // frame comes, and the previous body be measured — and the garment drafted for it.
      timer = setTimeout(() => setMeasurements(viewer.measure()), MEASURE_DELAY);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [ready, morph, viewerRef]);

  // Pinned girths: refit the local changes whenever the morphology changes.
  useEffect(() => {
    if (!ready || !hasPins(targets) || morph === lastFit.current) return;
    setFitting(true);
    const timer = setTimeout(() => {
      const model = viewerRef.current?.model;
      if (!model) return;
      const result = fitGirths(model, morph, targets);
      lastFit.current = result.morph;
      setSaturated(result.saturated);
      setFitting(false);
      setMorph(result.morph);
    }, FIT_DELAY);
    return () => clearTimeout(timer);
  }, [ready, morph, targets, viewerRef]);

  const updateTargets = (t: GirthTargets) => {
    lastFit.current = null;
    if (!hasPins(t)) {
      setSaturated([]);
      setFitting(false);
    }
    setTargets(t);
  };

  /** Replaces the whole morphology (presets) and releases the pinned girths. */
  const reset = (m: Morphology) => {
    updateTargets({});
    setMorph(m);
  };

  return { morph, setMorph, measurements, targets, setTargets: updateTargets, saturated, fitting, reset };
}
