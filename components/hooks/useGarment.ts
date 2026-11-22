"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TorsoFrame } from "@/lib/avatar/bodyMeasures";
import type { BodyMeasurement } from "@/lib/avatar/measure";
import { BELT_STRETCH, validBelts, withBelts } from "@/lib/pattern/belt";
import { nearestEnds, validClasps } from "@/lib/pattern/clasp";
import type { DescribedPattern } from "@/app/api/pattern/route";
import { sketchOf } from "@/lib/pattern/describe";
import { bakeFree, copyFree, draftFree, simpleFree, type FreePattern } from "@/lib/pattern/free";
import { importDxf, type DxfImport, type DxfUnits } from "@/lib/pattern/import/dxf";
import { GARMENTS, garmentDef, type GarmentDef, type GarmentParams } from "@/lib/pattern/garments";
import { NO_EDITS, type Belt, type BodyMeasures, type Clasp, type PatternEdits } from "@/lib/pattern/types";
import { patternIssues } from "@/lib/pattern/validate";
import type { Textile } from "@/lib/textiles/catalog";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";
import { useLibrary } from "./useLibrary";
import { fetchShared, useSharedLibrary } from "./useSharedLibrary";

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
  /** A drawing changed along with its accessories, as one step to undo. */
  const commitDrawing = useCallback((free: FreePattern, clasps: readonly Clasp[], belts: readonly Belt[]) => change({ free, clasps, belts }), [change]);
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
  return { edits: h.present.edits, clasps: h.present.clasps, belts: h.present.belts, free: h.present.free, drawing: all[FREE]?.present.free, drawingClasps: all[FREE]?.present.clasps ?? NO_CLASPS, drawingBelts: all[FREE]?.present.belts ?? NO_BELTS, commit, commitClasps, commitBelts, commitFree, commitDrawing, restart, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
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
  // The saved pattern (hooks/useLibrary.ts) the drawing is: `own`, the one it is saved to as it
  // changes; else a copy of it being worn, whose first change is saved as a variant.
  const library = useLibrary();
  // `shared`: the pattern is of the shared library (lib/library/store.ts, the same for every visitor and never
  // changed from here) — worn as a copy, as it was drawn.
  type Kept = { name: string; note: string; free: FreePattern; clasps: readonly Clasp[]; belts: readonly Belt[] };
  const [entry, setEntry] = useState<{ id: string; own: boolean; shared?: Kept } | null>(null);
  const saved: Kept | undefined = entry?.shared ?? (entry ? library.patterns.find((p) => p.id === entry.id) : undefined);
  const sharedLibrary = useSharedLibrary();
  const { drawingClasps, drawingBelts } = history;
  const { add: saveNew, update: saveOver } = library;
  useEffect(() => {
    if (!entry || !saved || !drawing) return;
    if (saved.free === drawing && saved.clasps === drawingClasps && saved.belts === drawingBelts) return;
    const timer = setTimeout(() => {
      // The library holds the history's very arrays: that is how a drawing is told unchanged, above.
      const now = { free: drawing, clasps: drawingClasps as Clasp[], belts: drawingBelts as Belt[] };
      if (entry.own) saveOver(entry.id, now);
      else setEntry({ id: saveNew({ name: `${saved.name} · variante`, note: saved.note, ...now }), own: true });
    }, 500);
    return () => clearTimeout(timer);
  }, [entry, saved, drawing, drawingClasps, drawingBelts, saveNew, saveOver]);
  const freeDef = useMemo(
    (): GarmentDef => ({
      id: FREE,
      style: FREE,
      cut: "homme",
      kind: "tshirt",
      name: saved?.name ?? "Patron libre",
      short: "Libre",
      description: saved?.note || "Dessiné à la main : pièces, points, coutures.",
      image: "",
      params: [],
      defaults: NO_PARAMS,
      draft: (_m, _p, edits) => draftFree(drawing ?? NO_DRAWING, edits),
    }),
    [drawing, saved?.name, saved?.note],
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

  // The same garment sewn and draped again from the start, when asked (the count of the times it was).
  const [stitching, setStitching] = useState(0);
  const resew = useCallback(() => setStitching((n) => n + 1), []);
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
  }, [ready, sewn, weight, bending, stretch, thickness, friction, viewerRef, stitching]);

  /**
   * A new drawing, and the garment worn becomes it: from simple shapes, or as a copy of the
   * garment worn as it is (its edits, clasps and belts with it).
   */
  const startFree = (source: "simple" | "copy") => {
    if (!measures) return;
    const worn = garment.draft(measures, params, history.edits);
    const copy = source === "copy" && kind !== FREE;
    history.restart(FREE, {
      edits: NO_EDITS,
      clasps: copy ? history.clasps : NO_CLASPS,
      belts: copy ? history.belts : NO_BELTS,
      free: copy ? copyFree(worn, measures) : simpleFree(measures),
    });
    setEntry(null);
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
    setEntry(null);
    setKind(FREE);
    return read;
  };
  /**
   * A new drawing made from a description by a language model (app/api/pattern/route.ts), and
   * the garment worn becomes it; resolves with what was drawn, or rejects with a message for
   * the user.
   */
  const askPattern = async (request: object): Promise<DescribedPattern> => {
    const response = await fetch("/api/pattern", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }).catch(() => null);
    // The answer takes up to a minute and a half to come: a connection cut meanwhile (the page or
    // the server reloaded, the network lost) is not the service failing — told apart, to be asked again.
    if (!response) throw new Error("La connexion a été coupée avant la réponse du service de dessin (page ou serveur rechargé, réseau perdu). Le vêtement n'a pas changé : renvoyez la demande.");
    const drawn = (await response.json().catch(() => null)) as (DescribedPattern & { error?: string }) | null;
    if (!response.ok || !drawn?.free) throw new Error(drawn?.error ?? "Le service de dessin n'a pas répondu. Réessayez dans un instant.");
    return drawn;
  };
  const describeFree = async (description: string): Promise<DescribedPattern> => {
    if (!measures) throw new Error("Le mannequin n'est pas encore prêt.");
    const drawn = await askPattern({ description, measures });
    const clasps = drawn.clasps ?? [], belts = drawn.belts ?? [];
    history.restart(FREE, { edits: NO_EDITS, clasps, belts, free: drawn.free });
    keep(drawn, { name: drawn.name, note: drawn.note, free: drawn.free, clasps, belts });
    setKind(FREE);
    return drawn;
  };
  /**
   * A model just drawn, kept to be worn again: in the shared library when the server put it
   * there (for everyone; a copy of it is worn), else in the visitor's own.
   */
  const keep = (drawn: DescribedPattern, kept: Kept) => {
    if (!drawn.shared) return setEntry({ id: saveNew({ ...kept, clasps: kept.clasps as Clasp[], belts: kept.belts as Belt[] }), own: true });
    setEntry({ id: drawn.shared.id, own: false, shared: { ...kept, name: drawn.shared.name } });
    void sharedLibrary.refresh();
  };
  /** A pattern of the shared library worn: a copy of it, fetched from the server. */
  const wearShared = async (id: string) => {
    const kept = await fetchShared(id);
    history.restart(FREE, { edits: NO_EDITS, clasps: kept.clasps, belts: kept.belts, free: kept.free });
    setEntry({ id, own: false, shared: kept });
    setKind(FREE);
    return { name: kept.name, note: kept.note, pieces: kept.free.pieces.map((p) => p.name) };
  };
  /** A pattern of the library worn: a copy of it (`own`: the pattern itself, taken up where it was left). */
  const wearSaved = (id: string, own = false) => {
    const kept = library.patterns.find((p) => p.id === id);
    if (!kept) throw new Error("Ce patron n'est plus dans la bibliothèque.");
    history.restart(FREE, { edits: NO_EDITS, clasps: kept.clasps, belts: kept.belts, free: kept.free });
    setEntry({ id, own });
    setKind(FREE);
    return { name: kept.name, note: kept.note, pieces: kept.free.pieces.map((p) => p.name) };
  };
  const forgetSaved = (id: string) => {
    if (entry?.id === id) setEntry(null);
    library.remove(id);
  };

  // ---- The garment worn, changed (the assistant's retouches): whatever it is, it is changed as
  // a drawing — its own when it is one (a step to undo), a copy of it when it is of the catalogue.
  type Worn = { free: FreePattern; clasps: readonly Clasp[]; belts: readonly Belt[]; own: boolean; name: string };
  /** A model to start from, told by its id: a saved pattern of the library, or a garment of the catalogue as it is set — as a drawing, whatever is being worn. */
  const modelDrawing = async (id: string): Promise<Worn | null> => {
    if (!measures) throw new Error("Le mannequin n'est pas encore prêt.");
    const kept = library.patterns.find((p) => p.id === id) ?? (sharedLibrary.patterns.some((p) => p.id === id) ? await fetchShared(id) : undefined);
    if (kept) return { free: kept.free, clasps: kept.clasps, belts: kept.belts, own: false, name: `${kept.name} · variante` };
    const def = GARMENTS.find((g) => g.id === id);
    if (!def) return null;
    return { free: copyFree(def.draft(measures, allParams[id] ?? def.defaults, NO_EDITS), measures), clasps: def.clasps ?? NO_CLASPS, belts: def.belts ?? NO_BELTS, own: false, name: `${def.name} retouché` };
  };
  const wornDrawing = (): Worn => {
    if (!measures) throw new Error("Le mannequin n'est pas encore prêt.");
    if (kind !== FREE) return { free: copyFree(garment.draft(measures, params, history.edits), measures), clasps: history.clasps, belts: history.belts, own: false, name: `${garment.name} retouché` };
    if (!drawing) throw new Error("Il n'y a pas de patron à retoucher.");
    return { free: drawing, clasps: history.clasps, belts: history.belts, own: true, name: garment.name };
  };
  const putOn = (worn: Worn, free: FreePattern, clasps: readonly Clasp[], belts: readonly Belt[], note: string) => {
    if (worn.own) return history.commitDrawing(free, clasps, belts);
    // A garment of the catalogue retouched: a drawing from now on, kept in the library under its name.
    const own = { clasps: [...clasps], belts: [...belts] };
    history.restart(FREE, { edits: NO_EDITS, ...own, free });
    setEntry({ id: saveNew({ name: worn.name, note, free, ...own }), own: true });
    setKind(FREE);
  };
  /** Pieces taken off the garment worn, told by their id or their name, with their seams and what was fastened to them. */
  const removePieces = (told: readonly string[]) => {
    const worn = wornDrawing();
    const wanted = new Set(told.map((t) => t.trim().toLowerCase()));
    const gone = worn.free.pieces.filter((p) => wanted.has(p.id.toLowerCase()) || wanted.has(p.name.toLowerCase()));
    const names = (pieces: readonly { name: string }[]) => pieces.map((p) => p.name);
    if (!gone.length) throw new Error(`Aucune pièce de ce nom. Pièces du vêtement : ${worn.free.pieces.map((p) => `${p.id} (${p.name})`).join(", ")}.`);
    if (gone.length === worn.free.pieces.length) throw new Error("Un vêtement garde au moins une pièce.");
    const off = new Set(gone.map((p) => p.id));
    const free = { ...worn.free, pieces: worn.free.pieces.filter((p) => !off.has(p.id)), seams: worn.free.seams.filter((s) => !off.has(s.a.piece) && !off.has(s.b.piece)) };
    putOn(worn, free, worn.clasps.filter((c) => !off.has(c.a.piece) && !off.has(c.b.piece)), worn.belts.filter((b) => !off.has(b.piece)), `${garment.name}, sans ${[...new Set(names(gone).map((n) => n.replace(/ \d+$/, "").toLowerCase()))].join(" ni ")}.`);
    return { removed: names(gone), left: names(free.pieces) };
  };
  // ---- Accessories put on by the assistant: as the 2D editor's tools do, told by edges.
  const edgesOf = () => (pattern?.pieces ?? []).map((p) => `${p.id} : ${p.edges.map((e) => e.id).join(", ")}`).join(" ; ");
  /** A clasp between two points of the garment, each told by how far along an edge it is (0: its start, 1: its end). */
  const addClasp = (a: { piece: string; edge: string; t: number }, b: { piece: string; edge: string; t: number }) => {
    if (!pattern) throw new Error("Le vêtement n'est pas encore prêt.");
    const at = (p: typeof a) => ({ piece: p.piece, edge: p.edge, t: Math.min(1, Math.max(0, p.t)), offset: [0, 0] as [number, number] });
    const clasp = nearestEnds(pattern, { a: at(a), b: at(b) });
    if (!validClasps(pattern, [clasp]).length) throw new Error(`Ce fermoir ne tient pas : il relie deux points de bords du vêtement, à deux endroits différents. Bords : ${edgesOf()}.`);
    history.commitClasps([...history.clasps, clasp]);
    return { clasp: { a: { piece: clasp.a.piece, edge: clasp.a.edge, t: clasp.a.t }, b: { piece: clasp.b.piece, edge: clasp.b.edge, t: clasp.b.t } }, clasps: history.clasps.length + 1 };
  };
  /** A belt along a free edge, all the way round the garment; it takes the place of one already there. */
  const addBelt = (piece: string, edge: string, stretch = BELT_STRETCH.initial) => {
    if (!pattern) throw new Error("Le vêtement n'est pas encore prêt.");
    const belt: Belt = { piece, edge, stretch: Math.min(BELT_STRETCH.max, Math.max(BELT_STRETCH.min, stretch)) };
    const [put] = validBelts(pattern, [belt]);
    if (!put) throw new Error(`Une ceinture suit un bord libre (non cousu) qui fait le tour du vêtement : une taille, un ourlet. Bords : ${edgesOf()}.`);
    const round = new Set(put.ring.map((r) => `${r.piece}/${r.edge}`));
    history.commitBelts([...history.belts.filter((b) => !round.has(`${b.piece}/${b.edge}`)), belt]);
    return { belt, along: put.ring.map((r) => `${r.piece}/${r.edge}`) };
  };
  /** Every clasp, every belt, or both, taken off. */
  const removeAccessories = (what: { clasps?: boolean; belts?: boolean }) => {
    const removed = { clasps: what.clasps ? history.clasps.length : 0, belts: what.belts ? history.belts.length : 0 };
    if (removed.clasps) history.commitClasps([]);
    if (removed.belts) history.commitBelts([]);
    return removed;
  };
  /**
   * The garment worn redrawn by the pattern model with a change (app/api/pattern/route.ts, its
   * `base`). What the model gives back unchanged is kept as it was drawn here — its curves to
   * the point, the way its seams were sewn — and not as the model retold it.
   */
  const reshape = async (change: string, from?: string): Promise<DescribedPattern> => {
    // `from`: another model than the garment worn to start from (modelDrawing) — the result is then a new pattern of the library.
    const worn = (from !== undefined && (await modelDrawing(from))) || wornDrawing();
    // Drawn from another model or from a garment of the catalogue, it is a garment of its own (`asNew`: the
    // server keeps it in the shared library); a drawing being worked on is retouched as it is.
    const fresh = from !== undefined || !worn.own;
    const drawn = await askPattern({ description: change, measures, base: sketchOf(worn.free, worn.belts, worn.clasps, worn.name, ""), ...(fresh && { asNew: true }) });
    const kept = new Set(drawn.unchanged ?? []);
    const sides = (s: FreePattern["seams"][number]) => [`${s.a.piece}/${s.a.edge}`, `${s.b.piece}/${s.b.edge}`].sort().join(" ");
    const sewn = new Map(worn.free.seams.map((s) => [sides(s), s.reverse]));
    const free: FreePattern = {
      next: worn.free.next,
      pieces: drawn.free.pieces.map((p) => (kept.has(p.id) && worn.free.pieces.find((w) => w.id === p.id)) || p),
      seams: drawn.free.seams.map((s) => (kept.has(s.a.piece) && kept.has(s.b.piece) && sewn.has(sides(s)) ? { ...s, reverse: sewn.get(sides(s))! } : s)),
    };
    if (fresh && drawn.shared) {
      // A new model in the shared library: worn as such.
      const clasps = drawn.clasps ?? [], belts = drawn.belts ?? [];
      history.restart(FREE, { edits: NO_EDITS, clasps, belts, free });
      keep(drawn, { name: drawn.name, note: drawn.note, free, clasps, belts });
      setKind(FREE);
      return { ...drawn, free };
    }
    // Started from another model: a garment of its own, under the name the pattern maker gave it.
    putOn(fresh && drawn.name ? { ...worn, name: drawn.name } : worn, free, drawn.clasps ?? NO_CLASPS, drawn.belts ?? NO_BELTS, drawn.note);
    return { ...drawn, free };
  };
  /**
   * A garment of the catalogue worn (the one worn, when none is told) with some of its settings
   * changed — each kept within what its slider allows, 0 where a length is worked out from the
   * body. Returns the garment's name and the settings as taken; throws, with a message, when
   * there is no such garment or setting.
   */
  const wear = (id: string | undefined, changes: readonly { key: string; value: number }[]) => {
    const target = id ?? kind;
    const def = GARMENTS.find((g) => g.id === target);
    if (!def) throw new Error(target === FREE ? "Le vêtement porté est un patron dessiné : il n'a pas de réglages, seulement des points (éditeur 2D)." : "Ce vêtement n'est pas au catalogue.");
    const next = { ...(allParams[target] ?? def.defaults) };
    const unknown: string[] = [];
    for (const { key, value } of changes) {
      const spec = def.params.find((s) => s.key === key);
      if (!spec) unknown.push(key);
      else next[key] = spec.auto && value <= 0 ? 0 : Math.min(spec.max, Math.max(spec.min, value));
    }
    if (unknown.length) throw new Error(`Réglage inconnu pour ${def.name} : ${unknown.join(", ")}. Réglages : ${def.params.map((s) => s.key).join(", ")}.`);
    setAllParams((a) => ({ ...a, [target]: next }));
    setKind(target);
    return { name: def.name, cut: def.cut, params: next };
  };
  /** The garment worn and the settings of every garment as they were left (Studio's memory): what is not of the catalogue any more is left out. */
  const restore = (id: unknown, settings: unknown, savedId?: unknown) => {
    if (settings && typeof settings === "object") {
      const kept: Record<string, GarmentParams> = {};
      for (const g of GARMENTS) {
        const told = (settings as Record<string, unknown>)[g.id];
        if (!told || typeof told !== "object") continue;
        kept[g.id] = { ...g.defaults };
        for (const spec of g.params) {
          const v = (told as Record<string, unknown>)[spec.key];
          if (typeof v === "number" && Number.isFinite(v)) kept[g.id][spec.key] = spec.auto && v <= 0 ? 0 : Math.min(spec.max, Math.max(spec.min, v));
        }
      }
      setAllParams((a) => ({ ...a, ...kept }));
    }
    if (GARMENTS.some((g) => g.id === id)) setKind(id as string);
    // The saved pattern that was being worn, taken up where it was left; one of the shared library, as it is there.
    if (typeof savedId !== "string") return;
    if (library.patterns.some((p) => p.id === savedId)) wearSaved(savedId, true);
    else void wearShared(savedId).catch(() => {});
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
    describeFree,
    wear,
    resew,
    removePieces,
    reshape,
    /** The library of saved patterns, the one being worn (null: none), and how to wear or forget one. */
    saved: library.patterns,
    savedId: kind === FREE ? (entry?.id ?? null) : null,
    wearSaved,
    forgetSaved,
    /** The shared library (the same for every visitor), and how to wear one of its patterns. */
    shared: sharedLibrary.patterns,
    wearShared,
    /** Whether an id is a model one can start from: a pattern of either library or a garment of the catalogue. */
    isModel: (id: string) => library.patterns.some((p) => p.id === id) || sharedLibrary.patterns.some((p) => p.id === id) || GARMENTS.some((g) => g.id === id),
    addClasp,
    addBelt,
    removeAccessories,
    allParams,
    restore,
    hasDrawing: !!drawing,
    canCopy: kind !== FREE && !!pattern,
  };
}
