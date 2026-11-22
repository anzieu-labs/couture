"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { AssistantState } from "@/lib/assistant/tools";
import { FEMALE, MALE, MORPHOLOGY_SLIDERS, type Morphology } from "@/lib/avatar/morphology";
import { CADENCE, type Posture } from "@/lib/avatar/motion";
import type { P2 } from "@/lib/pattern/curves";
import { constrain, withDelta } from "@/lib/pattern/edit";
import type { ExportOptions } from "@/lib/pattern/export";
import { DEFAULT_ALLOWANCES } from "@/lib/pattern/markings";
import type { PatternEdits } from "@/lib/pattern/types";
import { CUSTOM_TEXTILE, customTextile, drapeOf, TEXTILE_FIELDS, TEXTILES, withLook, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import type { FitMode } from "@/lib/viewer/fitMap";
import type { ViewPreset } from "@/lib/viewer/GarmentViewer";
import { AssistantPanel } from "./AssistantPanel";
import { FitLegend } from "./FitLegend";
import { useAssistant, type AssistantHandlers } from "./hooks/useAssistant";
import { FREE, useGarment } from "./hooks/useGarment";
import { useLocalSpans } from "./hooks/useLocalSpans";
import { useMorphology } from "./hooks/useMorphology";
import { useViewer } from "./hooks/useViewer";
import { MorphologyPanel } from "./MorphologyPanel";
import { PatternEditor } from "./PatternEditor";
import { PatternPanel } from "./PatternPanel";
import { PosePanel } from "./PosePanel";
import { edgeColorer } from "./seamColors";
import { TextilePanel } from "./TextilePanel";

type Tab = "morpho" | "pose" | "patron" | "tissu";

const TABS: [Tab, string][] = [
  ["morpho", "Morphologie"],
  ["pose", "Pose"],
  ["patron", "Patron"],
  ["tissu", "Tissu"],
];

const VIEW_LABELS: { id: ViewPreset; label: string }[] = [
  { id: "face", label: "Face" },
  { id: "profil", label: "Profil" },
  { id: "dos", label: "Dos" },
  { id: "buste", label: "Buste" },
];

const PRESETS = { Homme: MALE, Femme: FEMALE };

const DISPLAY_MODES: { id: FitMode | null; label: string; title: string }[] = [
  { id: null, label: "Tissu", title: "Rendu du tissu" },
  { id: "tension", label: "Tension", title: "Carte de tension (N/m) : où le vêtement serre" },
  { id: "stretch", label: "Étirement", title: "Carte d'étirement (%) du tissu" },
];

const defaultColors = (t: Textile): TextileColors => ({ primary: t.defaultColor, secondary: t.secondary?.default });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
/**
 * How long the assistant waits after changing the body before it reads the measurements back
 * (ms): the body is rebuilt on the next frame, pinned girths are fitted, then it is measured
 * (hooks/useMorphology.ts).
 */
const BODY_SETTLE = 1100;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The workshop as it was left — mannequin, textile, garment and its settings — kept in this
 * browser's local storage (no account) and found again when the page is opened: what the
 * assistant's conversation, kept the same way (hooks/useAssistant.ts), talks about. Not kept:
 * the pose, and a drawn pattern (the garment last worn from the catalogue is).
 */
const MEMORY = "couture.workshop.v1";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A morphology read back from storage, or null when it is not one. */
function readMorphology(v: unknown): Morphology | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const keys = ["gender", "ageYears", "statureCm", "weight", "muscle", "proportions", "cupsize", "firmness"] as const;
  if (!keys.every((k) => isNumber(m[k])) || !m.local || typeof m.local !== "object") return null;
  const local = Object.fromEntries(Object.entries(m.local as Record<string, unknown>).filter((e): e is [string, number] => isNumber(e[1])));
  return { ...(Object.fromEntries(keys.map((k) => [k, m[k]])) as Omit<Morphology, "local">), local };
}

export default function Studio() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { viewerRef, status, simProgress, simBackend } = useViewer(viewportRef);
  const ready = status === "ready";

  const [tab, setTab] = useState<Tab>("morpho");
  const [view, setView] = useState<ViewPreset>("face");
  const [autoRotate, setAutoRotate] = useState(false);
  const [walking, setWalking] = useState(false);
  const [cadence, setCadence] = useState(CADENCE.default);
  const [posture, setPosture] = useState<Posture>("standing");
  const [fitMode, setFitMode] = useState<FitMode | null>(null);
  const [cutting, setCutting] = useState<ExportOptions>({ allowances: DEFAULT_ALLOWANCES, fold: true });
  // The 2D pattern editor belongs to the pattern tab: opened on entering it, closed on leaving it
  // (it may be closed while there — on a phone it covers the 3D view).
  const [editorOpen, setEditorOpen] = useState(false);
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const selectTab = (id: Tab) => {
    // Poses and motion belong to the pose tab: leaving it, the mannequin stands still again.
    if (tab === "pose" && id !== "pose") {
      setWalking(false);
      setPosture("standing");
      setCadence(CADENCE.default);
      viewerRef.current?.releaseHands();
    }
    setTab(id);
    setEditorOpen(id === "patron");
  };

  // Fabric
  const [textileId, setTextileId] = useState(TEXTILES[0].id);
  // The user's own textile (lib/textiles/catalog.ts customTextile), offered after the library's.
  const [custom, setCustom] = useState(customTextile);
  const [colorsById, setColorsById] = useState<Record<string, TextileColors>>(() =>
    Object.fromEntries([...TEXTILES, customTextile()].map((t) => [t.id, defaultColors(t)])),
  );
  const textiles = useMemo(() => [...TEXTILES, custom], [custom]);
  const textile = textileId === CUSTOM_TEXTILE ? custom : TEXTILES.find((t) => t.id === textileId)!;
  // A second colour for the looks that take one, whatever the textile's colours were chosen for.
  const stored = colorsById[textileId];
  const colors = useMemo(() => ({ primary: stored.primary, secondary: textile.secondary ? (stored.secondary ?? textile.secondary.default) : undefined }), [stored, textile.secondary]);

  const body = useMorphology(viewerRef, ready);
  const [showLocal, setShowLocal] = useState(false);
  const local = useLocalSpans(viewerRef, ready, body.morph, tab === "morpho" && showLocal);
  const garment = useGarment(viewerRef, ready, body.measurements, textile);

  useEffect(() => {
    if (ready) viewerRef.current?.setFabric(textile, colors);
  }, [ready, textile, colors, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setAutoRotate(autoRotate);
  }, [ready, autoRotate, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setFitMap(fitMode);
  }, [ready, fitMode, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setWalking(walking);
  }, [ready, walking, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setCadence(cadence);
  }, [ready, cadence, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setPosture(posture);
  }, [ready, posture, viewerRef]);

  // 2D editor open: the pattern is drawn on the garment too (its edges in the seams' colours,
  // its points), and a point can be dragged on either side — `live` holds the drag under way.
  const [live, setLive] = useState<PatternEdits | null>(null);
  const [focus3d, setFocus3d] = useState<string | null>(null);
  const overlay = editorOpen && !!garment.measures;
  const { pattern: drafted, edits } = garment;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    viewer.setPatternOverlay(overlay && drafted ? edgeColorer(drafted) : null);
  }, [ready, overlay, drafted, viewerRef]);
  // The points as the editor draws them (the drag under way included).
  const shown = useMemo(
    () => (overlay && garment.measures ? garment.garment.draft(garment.measures, garment.params, live ?? edits) : null),
    [overlay, garment.garment, garment.measures, garment.params, live, edits],
  );
  useEffect(() => {
    if (ready && shown) viewerRef.current?.setPatternHandles(shown.handles);
  }, [ready, shown, viewerRef]);
  /** A point dragged on the garment: `move` is its displacement on the pattern since it was taken (cm). */
  const onPatternEdit = useEffectEvent((key: string, move: P2, done: boolean) => {
    const start = edits[key] ?? [0, 0];
    const next = constrain([start[0] + move[0], start[1] + move[1]], drafted?.handles.find((h) => h.key === key)?.axis ?? "free");
    if (!done) return setLive(withDelta(edits, key, next));
    setLive(null);
    if (next[0] !== start[0] || next[1] !== start[1]) garment.commit(withDelta(edits, key, next));
  });
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    viewer.onPatternEdit = (key, move, done) => onPatternEdit(key, move, done);
    viewer.onPatternFocus = setFocus3d;
    return () => {
      viewer.onPatternEdit = viewer.onPatternFocus = undefined;
    };
  }, [ready, viewerRef]);
  const focusOnGarment = useCallback((key: string | null) => viewerRef.current?.setPatternFocus(key), [viewerRef]);
  const highlightOnGarment = useCallback((edges: ReadonlySet<string>) => viewerRef.current?.setPatternHighlight(edges), [viewerRef]);


  const goTo = (v: ViewPreset) => {
    setView(v);
    viewerRef.current?.goTo(v);
  };

  // ---- Memory (MEMORY): written a moment after a change, read back once the page is there
  // (after its first render: the server knows nothing of this browser's storage).
  const remembered = useRef(false);
  const lastCatalogue = useRef(garment.kind);
  const { morph, targets, setMorph, setTargets } = body;
  const { kind: garmentKind, allParams } = garment;
  useEffect(() => {
    if (garmentKind !== FREE) lastCatalogue.current = garmentKind;
    if (!remembered.current) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(MEMORY, JSON.stringify({ morph, targets, textileId, custom, colorsById, garment: lastCatalogue.current, params: allParams }));
      } catch {
        // Storage full or refused: the workshop starts afresh next time.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [morph, targets, textileId, custom, colorsById, garmentKind, allParams]);
  const recall = useEffectEvent(() => {
    remembered.current = true;
    try {
      const kept = JSON.parse(localStorage.getItem(MEMORY) ?? "null") as Record<string, unknown> | null;
      if (!kept) return;
      const m = readMorphology(kept.morph);
      if (m) setMorph(m);
      if (kept.targets && typeof kept.targets === "object") {
        const t = kept.targets as Record<string, unknown>;
        setTargets(Object.fromEntries((["bust", "waist", "hips"] as const).filter((k) => isNumber(t[k])).map((k) => [k, t[k]])));
      }
      const look = kept.custom as (Textile & { look: string }) | undefined;
      if (look && isNumber(look.weight) && isNumber(look.bending) && isNumber(look.thickness) && isNumber(look.friction) && isNumber(look.stretch?.warp) && isNumber(look.stretch?.weft) && typeof look.name === "string")
        setCustom({ ...withLook(customTextile(), String(look.look)), name: look.name.slice(0, 60), structure: String(look.structure ?? ""), composition: String(look.composition ?? ""), weight: look.weight, bending: look.bending, drape: drapeOf(look.bending), thickness: look.thickness, friction: look.friction, stretch: { warp: look.stretch.warp, weft: look.stretch.weft } });
      if (kept.colorsById && typeof kept.colorsById === "object") {
        const hex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
        const told = kept.colorsById as Record<string, { primary?: unknown; secondary?: unknown }>;
        setColorsById((prev) =>
          Object.fromEntries(Object.entries(prev).map(([id, c]) => [id, { primary: hex(told[id]?.primary) ? told[id].primary : c.primary, secondary: hex(told[id]?.secondary) ? told[id].secondary : c.secondary }])),
        );
      }
      if (kept.textileId === CUSTOM_TEXTILE || TEXTILES.some((t) => t.id === kept.textileId)) setTextileId(kept.textileId as string);
      garment.restore(kept.garment, kept.params);
    } catch {
      // Unreadable: the workshop as it starts.
    }
  });
  useEffect(() => {
    const timer = setTimeout(recall);
    return () => clearTimeout(timer);
  }, []);

  // ---- The assistant (lib/assistant/tools.ts): what its tools do here, and what it is told of the workshop.
  // Shown beside the 3D view unless folded away; on a phone, over it once opened (null: as the screen has room).
  const [assistantOpen, setAssistantOpen] = useState<boolean | null>(null);
  // The workshop's own panel, on the left, folds away the same way to leave the room to the 3D view (desktop: on a phone it is the page under the view).
  const [panelOpen, setPanelOpen] = useState(true);
  // What a tool reads back once the body has settled: the measurements of then, not of the render it was called in.
  const latest = useRef({ measurements: body.measurements, saturated: body.saturated, targets: body.targets, textileId });
  useEffect(() => {
    latest.current = { measurements: body.measurements, saturated: body.saturated, targets: body.targets, textileId };
  });
  const measured = () => {
    const m = latest.current.measurements;
    return m ? { stature: round(m.stature), bust: round(m.bust), waist: round(m.waist), hips: round(m.hips) } : null;
  };
  const handlers: AssistantHandlers = {
    setMorphology: async (i) => {
      const set: Partial<Morphology> = {};
      if (i.gender) set.gender = i.gender === "femme" ? 1 : 0;
      for (const key of ["statureCm", "ageYears", "weight", "muscle", "cupsize", "firmness"] as const) {
        const v = i[key], s = MORPHOLOGY_SLIDERS.find((x) => x.key === key)!;
        if (v !== undefined) set[key] = clamp(key === "statureCm" || key === "ageYears" ? Math.round(v) : v, s.min, s.max);
      }
      body.setMorph((m) => ({ ...m, ...set }));
      await settle(BODY_SETTLE);
      return { set, measuredCm: measured() };
    },
    setGirths: async (i) => {
      const targets = { ...latest.current.targets };
      for (const key of ["bust", "waist", "hips"] as const) {
        const v = i[key];
        if (v === null) delete targets[key];
        else if (v !== undefined) targets[key] = clamp(v, 40, 200);
      }
      body.setTargets(targets);
      await settle(BODY_SETTLE);
      return { pinnedCm: targets, measuredCm: measured(), outOfReach: latest.current.saturated };
    },
    setBodyDetails: async (i) => {
      const local = Object.fromEntries(i.changes.map((c) => [c.key, clamp(c.value, -1, 1)]));
      body.setMorph((m) => ({ ...m, local: { ...m.local, ...local } }));
      await settle(BODY_SETTLE);
      return { set: local, measuredCm: measured() };
    },
    setPose: (i) => {
      if (i.cadence !== undefined) setCadence(clamp(Math.round(i.cadence), CADENCE.min, CADENCE.max));
      // As the pose panel does: a held posture stops the walk, and walking stands the mannequin up.
      const held = i.posture && i.posture !== "standing";
      if (i.posture) setPosture(i.posture);
      if (held) setWalking(false);
      else if (i.walking !== undefined) {
        setWalking(i.walking);
        if (i.walking) setPosture("standing");
      }
      return { ...i, ...(held && i.walking ? { walking: false, note: "une posture tenue arrête la marche" } : {}) };
    },
    setTextile: (i) => {
      const id = i.id ?? latest.current.textileId;
      const chosen = id === CUSTOM_TEXTILE ? custom : TEXTILES.find((t) => t.id === id)!;
      if (i.id) setTextileId(id);
      if (i.color || i.secondaryColor)
        setColorsById((prev) => ({ ...prev, [id]: { ...prev[id], ...(i.color && { primary: i.color }), ...(i.secondaryColor && chosen.secondary && { secondary: i.secondaryColor }) } }));
      return { textile: chosen.name, ...(i.secondaryColor && !chosen.secondary && { note: "ce tissu n'a qu'une couleur" }) };
    },
    setCustomTextile: (i) => {
      const F = TEXTILE_FIELDS;
      let next = i.look ? withLook(custom, i.look) : custom;
      const bending = i.bending === undefined ? next.bending : clamp(i.bending * 1e-6, F.bending.min, F.bending.max);
      next = {
        ...next,
        ...(i.name?.trim() && { name: i.name.trim() }),
        ...(i.weight !== undefined && { weight: clamp(i.weight, F.weight.min, F.weight.max) }),
        ...(i.thickness !== undefined && { thickness: clamp(i.thickness, F.thickness.min, F.thickness.max) }),
        ...(i.friction !== undefined && { friction: clamp(i.friction, F.friction.min, F.friction.max) }),
        bending,
        drape: drapeOf(bending),
        stretch: {
          warp: i.warp === undefined ? next.stretch.warp : clamp(i.warp, F.warp.min, F.warp.max),
          weft: i.weft === undefined ? next.stretch.weft : clamp(i.weft, F.weft.min, F.weft.max),
        },
      };
      setCustom(next);
      setTextileId(CUSTOM_TEXTILE);
      return { name: next.name, weight: next.weight, thickness: next.thickness, bendingMicroNm: round(next.bending * 1e6, 2), drape: next.drape, stretch: next.stretch, friction: next.friction };
    },
    setGarment: (i) => ({ ...garment.wear(i.id, i.params ?? []), note: "le vêtement est recousu puis drapé en quelques secondes" }),
    drawGarment: async (i) => {
      const drawn = await garment.describeFree(i.description);
      return { name: drawn.name, note: drawn.note, pieces: drawn.free.pieces.length, seams: drawn.free.seams.length, stillWrong: drawn.issues };
    },
    removePieces: (i) => ({ ...garment.removePieces(i.pieces), note: "le vêtement est maintenant un patron dessiné ; « Annuler » de l'éditeur 2D revient en arrière s'il l'était déjà" }),
    reshapeGarment: async (i) => {
      const drawn = await garment.reshape(i.change);
      const same = drawn.unchanged?.length === drawn.free.pieces.length;
      return { note: drawn.note, pieces: drawn.free.pieces.map((p) => p.name), seams: drawn.free.seams.length, stillWrong: drawn.issues, ...(same && { warning: "le patron est revenu inchangé" }) };
    },
    addClasp: (i) => garment.addClasp(i.a, i.b),
    addBelt: (i) => garment.addBelt(i.piece, i.edge, i.stretch),
    removeAccessories: (i) => garment.removeAccessories(i),
    setView: (i) => {
      if (i.view) goTo(i.view);
      if (i.display) setFitMode(i.display === "tissu" ? null : i.display);
      if (i.autoRotate !== undefined) setAutoRotate(i.autoRotate);
      return i;
    },
  };
  const assistantState = (): AssistantState => {
    const m = body.morph;
    return {
      morphology: {
        gender: m.gender >= 0.5 ? "femme" : "homme",
        statureCm: m.statureCm,
        ageYears: m.ageYears,
        weight: round(m.weight, 2),
        muscle: round(m.muscle, 2),
        cupsize: round(m.cupsize, 2),
        firmness: round(m.firmness, 2),
        details: Object.fromEntries(Object.entries(m.local).filter(([, v]) => v !== 0).map(([k, v]) => [k, round(v, 2)])),
      },
      measures: measured(),
      pinnedGirths: body.targets,
      pose: { posture, walking, cadence },
      textile: {
        id: textile.id,
        name: textile.name,
        weight: textile.weight,
        thickness: textile.thickness,
        bending: round(textile.bending * 1e6, 2),
        warp: textile.stretch.warp,
        weft: textile.stretch.weft,
        friction: textile.friction,
        color: colors.primary,
        ...(colors.secondary && { secondaryColor: colors.secondary }),
      },
      garment: {
        id: garment.garment.id,
        name: garment.garment.name,
        params: garment.params,
        pieces: (garment.pattern?.pieces ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          edges: p.edges.map((e) => {
            const from = e.pts[0], to = e.pts[e.pts.length - 1];
            return { id: e.id, sewn: e.allowance === "seam", from: [Math.round(from[0]), Math.round(from[1])], to: [Math.round(to[0]), Math.round(to[1])] };
          }),
        })),
        clasps: garment.clasps.map((c) => ({ a: `${c.a.piece}/${c.a.edge} t=${round(c.a.t, 2)}`, b: `${c.b.piece}/${c.b.edge} t=${round(c.b.t, 2)}` })),
        belts: garment.belts.map((b) => ({ edge: `${b.piece}/${b.edge}`, stretch: b.stretch })),
      },
      draping: simProgress > 0 && simProgress < 1,
    };
  };
  const assistant = useAssistant(handlers, assistantState);

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-canvas text-ink md:flex-row">
      {/* ------------------------------------------------------------ 3D */}
      <section className="relative flex h-[58dvh] shrink-0 md:h-full md:flex-1" aria-label="Aperçu 3D">
        {editorOpen && garment.measures && (
          // Desktop: on the right of the 3D view (which follows the edits live); mobile: over it.
          <div className="absolute inset-0 z-20 md:static md:z-auto md:order-last md:w-1/2 md:shrink-0 md:border-l md:border-line">
            <PatternEditor
              key={garment.kind}
              garment={garment.garment}
              measures={garment.measures}
              params={garment.params}
              edits={garment.edits}
              live={live}
              onLive={setLive}
              focusKey={focus3d}
              onFocus={focusOnGarment}
              onHighlight={highlightOnGarment}
              onCommit={garment.commit}
              clasps={garment.clasps}
              onClasps={garment.commitClasps}
              belts={garment.belts}
              onBelts={garment.commitBelts}
              free={garment.free}
              onFree={garment.setFree}
              onUndo={garment.undo}
              onRedo={garment.redo}
              canUndo={garment.canUndo}
              canRedo={garment.canRedo}
              allowances={cutting.allowances}
              onClose={closeEditor}
            />
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          <div ref={viewportRef} className="absolute inset-0" />

          {!panelOpen && (
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="absolute left-4 top-4 z-10 hidden items-center gap-1.5 rounded-full border border-line bg-white/80 px-3.5 py-1.5 text-xs font-medium shadow-sm backdrop-blur transition-colors hover:border-ink md:left-6 md:top-5 md:inline-flex"
            >
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M8 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Atelier
            </button>
          )}

          {/* Top right of the view: what is shown on the garment. */}
          <div className="absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] flex-col items-end gap-3 md:right-6 md:top-5 md:max-w-[calc(100%-3rem)]">
            <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
              {simBackend && (
                <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-line bg-white/80 p-1 shadow-sm backdrop-blur" role="group" aria-label="Affichage du vêtement">
                  {DISPLAY_MODES.map((m) => (
                    <button
                      key={m.label}
                      type="button"
                      title={m.title}
                      onClick={() => setFitMode(m.id)}
                      aria-pressed={fitMode === m.id}
                      className="rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {fitMode && <FitLegend mode={fitMode} />}
          </div>

          {/* The way back to the assistant when it is folded away (on a phone: until it is opened): bottom right of the view. */}
          <button
            type="button"
            onClick={() => setAssistantOpen(true)}
            className={`absolute bottom-16 right-4 z-10 rounded-full bg-ink px-4 py-2 text-xs font-medium text-white shadow-md transition-opacity hover:opacity-90 md:bottom-6 md:right-6 ${assistantOpen === null ? "md:hidden" : assistantOpen ? "hidden" : ""}`}
          >
            Assistant
          </button>

          {!ready && (
            <div className="absolute inset-0 grid place-items-center">
              <p className="text-sm text-muted">
                {status === "loading" ? "Chargement du mannequin…" : "Impossible d'initialiser le rendu 3D sur ce navigateur."}
              </p>
            </div>
          )}

          <div className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-4 md:bottom-6">
            <div className="flex items-center gap-1 rounded-full border border-line bg-white/80 p-1 shadow-sm backdrop-blur">
              {VIEW_LABELS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => goTo(v.id)}
                  aria-pressed={view === v.id}
                  className="rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
                >
                  {v.label}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-line" aria-hidden />
              <button
                type="button"
                onClick={() => setAutoRotate((a) => !a)}
                aria-pressed={autoRotate}
                aria-label="Rotation automatique"
                title="Rotation automatique"
                className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
              >
                <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" strokeLinecap="round" />
                  <path d="M15 2.5v3.3h-3.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- Panel */}
      {/* Desktop: the panel on the left, the 3D view then the 2D pattern on its right; mobile: under the 3D view. */}
      <aside className={`flex min-h-0 flex-1 flex-col border-line bg-panel md:order-first md:h-full md:w-[360px] md:flex-none md:border-r ${panelOpen ? "" : "md:hidden"}`} aria-label="Atelier">
        <header className="border-b border-line px-5 pt-4 md:pt-5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold tracking-tight">Atelier</h1>
              <p className="truncate text-xs text-muted">{garment.garment.name} · mannequin paramétrique</p>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              aria-label="Replier l'atelier"
              title="Replier"
              className="hidden size-7 shrink-0 place-items-center rounded-full border border-line text-muted transition-colors hover:border-ink hover:text-ink md:grid"
            >
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M12 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div role="tablist" className="mt-3 flex gap-5">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => selectTab(id)}
                className="-mb-px border-b-2 border-transparent pb-2.5 text-sm font-medium text-muted transition-colors hover:text-ink aria-selected:border-ink aria-selected:text-ink"
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5" role="tabpanel">
          {tab === "morpho" && (
            <MorphologyPanel
              value={body.morph}
              onChange={body.setMorph}
              measurements={body.measurements}
              presets={PRESETS}
              onPreset={body.reset}
              targets={body.targets}
              onTargets={body.setTargets}
              saturated={body.saturated}
              fitting={body.fitting}
              showLocal={showLocal}
              onShowLocal={setShowLocal}
              localTapes={local.tapes}
              localSpans={local.spans}
            />
          )}
          {tab === "pose" && (
            <PosePanel
              cadence={cadence}
              onCadence={setCadence}
              walking={walking}
              onWalking={(on) => {
                setWalking(on);
                if (on) setPosture("standing");
              }}
              posture={posture}
              onPosture={(p) => {
                setPosture(p);
                if (p !== "standing") setWalking(false);
              }}
            />
          )}
          {tab === "patron" && (
            <PatternPanel
              pattern={garment.pattern}
              params={garment.params}
              onParams={garment.setParams}
              garment={garment.garment}
              onGarment={garment.setKind}
              onDraw={(source) => {
                garment.startFree(source);
                setEditorOpen(true);
              }}
              onImport={(text, units) => {
                const read = garment.importFree(text, units);
                setEditorOpen(true);
                return read;
              }}
              hasDrawing={garment.hasDrawing}
              canCopy={garment.canCopy}
              measures={garment.measures}
              progress={simProgress}
              cutting={cutting}
              onCutting={setCutting}
              editorOpen={editorOpen}
              onEditor={setEditorOpen}
              editCount={Object.keys(garment.edits).length}
              onResetEdits={() => garment.commit({})}
              issues={garment.issues.map((i) => i.message)}
            />
          )}
          {tab === "tissu" && (
            <TextilePanel
              textile={textile}
              textiles={textiles}
              onTextile={setTextileId}
              onCustom={setCustom}
              colors={colors}
              colorsById={colorsById}
              onColor={(key, hex) => setColorsById((prev) => ({ ...prev, [textileId]: { ...prev[textileId], [key]: hex } }))}
            />
          )}
        </div>

        <footer className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-muted">
          Corps : modèle Anny (NAVER LABS Europe, Apache 2.0) issu de MakeHuman (CC0).
        </footer>
      </aside>

      {/* ----------------------------------------------------- Assistant */}
      {/* Desktop: a column kept open on the right; mobile: over everything once opened. */}
      <aside
        aria-label="Assistant"
        className={`min-h-0 flex-col border-line md:h-full md:w-[320px] md:flex-none md:border-l ${
          assistantOpen === null ? "hidden md:flex" : assistantOpen ? "fixed inset-0 z-30 flex md:static md:z-auto" : "hidden"
        }`}
      >
        <AssistantPanel assistant={assistant} onClose={() => setAssistantOpen(false)} />
      </aside>
    </main>
  );
}
