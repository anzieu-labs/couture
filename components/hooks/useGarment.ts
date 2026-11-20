"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TorsoFrame } from "@/lib/avatar/bodyMeasures";
import type { BodyMeasurement } from "@/lib/avatar/measure";
import { GARMENTS, garmentDef, type GarmentParams } from "@/lib/pattern/garments";
import { NO_EDITS, type BodyMeasures, type GarmentKind, type PatternEdits } from "@/lib/pattern/types";
import { patternIssues } from "@/lib/pattern/validate";
import type { Textile } from "@/lib/textiles/catalog";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

const DRESS_DELAY = 250;
const HISTORY = 100;

interface History {
  past: PatternEdits[];
  present: PatternEdits;
  future: PatternEdits[];
}

const EMPTY: History = { past: [], present: NO_EDITS, future: [] };

/** Pattern edits with undo / redo, one history per garment. */
function useEditHistory(kind: GarmentKind) {
  const [all, setAll] = useState<Partial<Record<GarmentKind, History>>>({});
  const h = all[kind] ?? EMPTY;
  const update = useCallback(
    (f: (s: History) => History) => setAll((a) => ({ ...a, [kind]: f(a[kind] ?? EMPTY) })),
    [kind],
  );
  const commit = useCallback(
    (next: PatternEdits) => update((s) => (next === s.present ? s : { past: [...s.past, s.present].slice(-HISTORY), present: next, future: [] })),
    [update],
  );
  const undo = useCallback(
    () => update((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)),
    [update],
  );
  const redo = useCallback(
    () => update((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)),
    [update],
  );
  return { edits: h.present, commit, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

/** Pattern drafted from the measured body (+ edits), then sewn & draped with the textile's mechanics. */
export function useGarment(
  viewerRef: RefObject<GarmentViewer | null>,
  ready: boolean,
  measurements: BodyMeasurement | null,
  textile: Textile,
) {
  const [kind, setKind] = useState<GarmentKind>("tshirt");
  const [allParams, setAllParams] = useState<Record<GarmentKind, GarmentParams>>(
    () => Object.fromEntries(GARMENTS.map((g) => [g.id, g.defaults])) as Record<GarmentKind, GarmentParams>,
  );
  const garment = garmentDef(kind);
  const params = allParams[kind];
  const setParams = useCallback((p: GarmentParams) => setAllParams((a) => ({ ...a, [kind]: p })), [kind]);
  const [measures, setMeasures] = useState<BodyMeasures | null>(null);
  const [sewCount, setSewCount] = useState(0);
  const torso = useRef<TorsoFrame | null>(null);
  const history = useEditHistory(kind);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !measurements) return;
    const inputs = viewer.patternInputs(measurements);
    if (!inputs) return;
    torso.current = inputs.torso;
    setMeasures(inputs.measures);
  }, [ready, measurements, viewerRef]);

  const pattern = useMemo(() => (measures ? garment.draft(measures, params, history.edits) : null), [garment, measures, params, history.edits]);
  const issues = useMemo(() => (pattern ? patternIssues(pattern) : []), [pattern]);
  // The 3D keeps the last pattern that can be meshed.
  const [sewn, setSewn] = useState(pattern);
  if (pattern !== sewn && issues.length === 0) setSewn(pattern);

  // Only the mechanical properties matter here: re-sew on textile changes, not colours.
  const { weight, bending, stretch, thickness, friction } = textile;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !sewn || !torso.current) return;
    const timer = setTimeout(() => {
      viewer.dress(sewn, torso.current!, {
        density: weight / 1000,
        bending,
        stretchWarp: stretch.warp,
        stretchWeft: stretch.weft,
        thickness: thickness / 1000,
        friction,
      });
    }, DRESS_DELAY);
    return () => clearTimeout(timer);
  }, [ready, sewn, weight, bending, stretch, thickness, friction, sewCount, viewerRef]);

  return {
    kind,
    setKind,
    garment,
    params,
    setParams,
    measures,
    pattern,
    issues,
    resew: () => setSewCount((c) => c + 1),
    ...history,
  };
}
