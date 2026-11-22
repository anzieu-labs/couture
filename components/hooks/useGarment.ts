"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TorsoFrame } from "@/lib/avatar/bodyMeasures";
import type { BodyMeasurement } from "@/lib/avatar/measure";
import { withBelts } from "@/lib/pattern/belt";
import { validClasps } from "@/lib/pattern/clasp";
import { bakeFree, canCopy, copyFree, draftFree, simpleFree, type FreePattern } from "@/lib/pattern/free";
import { importDxf, type DxfImport, type DxfUnits } from "@/lib/pattern/import/dxf";
import { GARMENTS, garmentDef, type GarmentDef, type GarmentParams } from "@/lib/pattern/garments";
import { NO_EDITS, type Belt, type BodyMeasures, type Clasp, type PatternEdits } from "@/lib/pattern/types";
import { patternIssues } from "@/lib/pattern/validate";
import type { Textile } from "@/lib/textiles/catalog";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

const DRESS_DELAY = 250;
const HISTORY = 100;

/**
 * What the user changed on a drafted pattern: its points moved, and the accessories added
 * (clasps, belts). A drawn pattern (lib/pattern/free.ts) is its drawing: the moves of its points
 * are taken into it as they are made.
 */
interface Changes {
  edits: PatternEdits;
  clasps: readonly Clasp[];
  belts: readonly Belt[];
  free?: FreePattern;
}

/** Id of the user's own drawing among the garments. */
export const FREE = "free";
const NO_DRAWING: FreePattern = { pieces: [], seams: [], next: 1 };
const NO_PARAMS: GarmentParams = {};

interface History {
  past: Changes[];
  present: Changes;
  future: Changes[];
}

const NO_CLASPS: readonly Clasp[] = [];
const NO_BELTS: readonly Belt[] = [];
/** Where each garment's history starts: the draft as it is, with the accessories the garment comes with. */
const INITIAL = Object.fromEntries(
  GARMENTS.map((g) => [g.id, { past: [], present: { edits: NO_EDITS, clasps: g.clasps ?? NO_CLASPS, belts: g.belts ?? NO_BELTS }, future: [] }]),
) as Record<string, History>;
INITIAL[FREE] = { past: [], present: { edits: NO_EDITS, clasps: NO_CLASPS, belts: NO_BELTS }, future: [] };

/** Pattern edits and clasps with undo / redo, one history per garment. */
function useEditHistory(kind: string) {
  const [all, setAll] = useState<Partial<Record<string, History>>>({});
  const h = all[kind] ?? INITIAL[kind];
  const update = useCallback(
    (f: (s: History) => History) => setAll((a) => ({ ...a, [kind]: f(a[kind] ?? INITIAL[kind]) })),
    [kind],
  );
  const change = useCallback(
    (next: Partial<Changes>) =>
      update((s) =>
        (next.edits ?? s.present.edits) === s.present.edits &&
        (next.clasps ?? s.present.clasps) === s.present.clasps &&
        (next.belts ?? s.present.belts) === s.present.belts &&
        (next.free ?? s.present.free) === s.present.free
          ? s
          : { past: [...s.past, s.present].slice(-HISTORY), present: { ...s.present, ...next }, future: [] },
      ),
    [update],
  );
  const commit = useCallback((edits: PatternEdits) => change({ edits }), [change]);
  const commitClasps = useCallback((clasps: readonly Clasp[]) => change({ clasps }), [change]);
  const commitBelts = useCallback((belts: readonly Belt[]) => change({ belts }), [change]);
  const commitFree = useCallback((free: FreePattern) => change({ free }), [change]);
  /** A garment's history started afresh from `present` (a new drawing). */
  const restart = useCallback((key: string, present: Changes) => setAll((a) => ({ ...a, [key]: { past: [], present, future: [] } })), []);
  const undo = useCallback(
    () => update((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)),
    [update],
  );
  const redo = useCallback(
    () => update((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)),
    [update],
  );
  return { edits: h.present.edits, clasps: h.present.clasps, belts: h.present.belts, free: h.present.free, drawing: all[FREE]?.present.free, commit, commitClasps, commitBelts, commitFree, restart, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

/** Pattern drafted from the measured body (+ edits), then sewn & draped with the textile's mechanics. */
export function useGarment(
  viewerRef: RefObject<GarmentViewer | null>,
  ready: boolean,
  measurements: BodyMeasurement | null,
  textile: Textile,
) {
  // The garment's id (lib/pattern/garments.ts): a style in one of its cuts.
  const [kind, setKind] = useState(GARMENTS[0].id);
  const [allParams, setAllParams] = useState<Record<string, GarmentParams>>(() => Object.fromEntries(GARMENTS.map((g) => [g.id, g.defaults])));
  const history = useEditHistory(kind);
  // The user's own drawing as a garment: drafted from the drawing, not from the body.
  const drawing = history.drawing;
  const freeDef = useMemo(
    (): GarmentDef => ({
      id: FREE,
      style: FREE,
      cut: "homme",
      kind: "tshirt",
      name: "Patron libre",
      short: "Libre",
      description: "Dessiné à la main : pièces, points, coutures.",
      image: "",
      params: [],
      defaults: NO_PARAMS,
      draft: (_m, _p, edits) => draftFree(drawing ?? NO_DRAWING, edits),
    }),
    [drawing],
  );
  const garment = kind === FREE ? freeDef : garmentDef(kind);
  const params = allParams[kind] ?? NO_PARAMS;
  const setParams = useCallback((p: GarmentParams) => setAllParams((a) => ({ ...a, [kind]: p })), [kind]);
  const [measures, setMeasures] = useState<BodyMeasures | null>(null);
  const torso = useRef<TorsoFrame | null>(null);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !measurements) return;
    const inputs = viewer.patternInputs(measurements);
    if (!inputs) return;
    torso.current = inputs.torso;
    setMeasures(inputs.measures);
  }, [ready, measurements, viewerRef]);

  const pattern = useMemo(() => {
    if (!measures) return null;
    const drafted = garment.draft(measures, params, history.edits);
    // The accessories the user added, those that still hold on the pattern as it is now.
    const clasps = validClasps(drafted, history.clasps);
    return withBelts(clasps.length ? { ...drafted, clasps } : drafted, history.belts);
  }, [garment, measures, params, history.edits, history.clasps, history.belts]);
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
  }, [ready, sewn, weight, bending, stretch, thickness, friction, viewerRef]);

  /**
   * A new drawing, and the garment worn becomes it: from simple shapes, or as a copy of the
   * garment worn as it is (its edits, clasps and belts with it).
   */
  const startFree = (source: "simple" | "copy") => {
    if (!measures) return;
    const worn = garment.draft(measures, params, history.edits);
    const copy = source === "copy" && kind !== FREE && canCopy(worn);
    history.restart(FREE, {
      edits: NO_EDITS,
      clasps: copy ? history.clasps : NO_CLASPS,
      belts: copy ? history.belts : NO_BELTS,
      free: copy ? copyFree(worn, measures) : simpleFree(measures),
    });
    setKind(FREE);
  };
  /**
   * A new drawing read from a DXF file (lib/pattern/import/dxf.ts), and the garment worn becomes
   * it; returns what was read, or throws with a message for the user when nothing can be.
   */
  const importFree = (text: string, units: DxfUnits): DxfImport => {
    if (!measures) throw new Error("Le mannequin n'est pas encore prêt.");
    const read = importDxf(text, units, measures);
    history.restart(FREE, { edits: NO_EDITS, clasps: NO_CLASPS, belts: NO_BELTS, free: read.free });
    setKind(FREE);
    return read;
  };
  const { commit: commitEdits, commitFree } = history;
  // A drawn pattern has no edits: the points moved are moved in the drawing.
  const commit = useCallback(
    (edits: PatternEdits) => (kind === FREE && drawing ? commitFree(bakeFree(drawing, edits)) : commitEdits(edits)),
    [kind, drawing, commitEdits, commitFree],
  );

  return {
    kind,
    setKind,
    garment,
    params,
    setParams,
    measures,
    pattern,
    issues,
    ...history,
    commit,
    /** The drawing being edited (the garment worn is the user's own), and how to change it. */
    free: kind === FREE ? (drawing ?? null) : null,
    setFree: commitFree,
    startFree,
    importFree,
    hasDrawing: !!drawing,
    canCopy: kind !== FREE && !!pattern && canCopy(pattern),
  };
}
