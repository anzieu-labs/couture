"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BELT_STRETCH, ringLength, validBelts } from "@/lib/pattern/belt";
import { distanceToPiece, piecePointAt, piecePointPosition, twinPoint, validClasps } from "@/lib/pattern/clasp";
import type { P2 } from "@/lib/pattern/curves";
import { constrain, SNAP, withDelta } from "@/lib/pattern/edit";
import { addPiece, addSeam, flipSeam, freeSeams, insertPoint, movePiece, removePiece, removePoint, removeSeam, setZone, straighten, ZONES, type FreePattern } from "@/lib/pattern/free";
import { cutPieces, type Allowances } from "@/lib/pattern/markings";
import type { GarmentDef, GarmentParams } from "@/lib/pattern/garments";
import { NO_EDITS, seamSideLength, type Belt, type BodyMeasures, type Clasp, type Handle, type Pattern, type PatternEdits, type Piece, type PiecePoint, type Zone } from "@/lib/pattern/types";
import { outline, patternIssues } from "@/lib/pattern/validate";
import { edgeColorer } from "./seamColors";

interface Props {
  garment: GarmentDef;
  measures: BodyMeasures;
  params: GarmentParams;
  edits: PatternEdits;
  /** Edits of a drag under way, here or on the garment in 3D (null: none), and how this editor reports its own. */
  live: PatternEdits | null;
  onLive: (edits: PatternEdits | null) => void;
  /** Point hovered or dragged on the garment in 3D: shown as selected here. */
  focusKey: string | null;
  /** The point hovered, dragged or selected here changed: highlighted on the garment. */
  onFocus: (key: string | null) => void;
  onCommit: (edits: PatternEdits) => void;
  /** Clasps added on the pattern, and how this editor changes them (the "Fermoir" tool). */
  clasps: readonly Clasp[];
  onClasps: (clasps: readonly Clasp[]) => void;
  /** Belts, likewise (the "Ceinture" tool). */
  belts: readonly Belt[];
  onBelts: (belts: readonly Belt[]) => void;
  /**
   * The user's own drawing when that is what is edited (lib/pattern/free.ts), and how this
   * editor changes it: points added and removed, edges bent, seams, pieces. Null for a draft.
   */
  free: FreePattern | null;
  onFree: (free: FreePattern) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  allowances: Allowances;
  onClose: () => void;
}

const GAP = 8; // cm between pieces
const ZOOM = { min: 0.6, max: 80 }; // px per cm
/** Clasps: their colour, and (screen px) how close to a piece a click counts and to its outline it snaps. */
const CLASP = { color: "#b83280", reach: 12, snap: 8 };
/** Belts: their colour, how close to an edge a click takes it (screen px), and what their edges are called. */
const BELT = { color: "#8a5a2b", reach: 12 };
const EDGE_NAMES: Record<string, string> = { waist: "taille", hem: "bas", neck: "encolure", arm: "emmanchure", cf: "bord devant", face: "bord de capuche" };
/** A belt's elasticity in words: "rigide", "élastique +10 %", "fronce −15 %". */
const stretchLabel = (stretch: number) => {
  const pct = Math.round(stretch * 100);
  return pct === 0 ? "rigide" : pct > 0 ? `élastique +${pct} %` : `fronce −${-pct} %`;
};

/**
 * The accessories that can be put on a pattern, as the palette shows them: each is a tool —
 * choose it, then click on the pieces. To add one: an entry here, its tool below, and what
 * the simulation makes of it (lib/pattern/mesh.ts).
 */
type Accessory = "clasp" | "belt";
const ACCESSORIES: { id: Accessory; name: string; what: string; icon: React.ReactNode }[] = [
  {
    id: "clasp",
    name: "Fermoir",
    what: "Deux points tenus ensemble : une cape fermée au cou.",
    icon: (
      <>
        <circle cx="7" cy="12" r="3.2" />
        <circle cx="17" cy="12" r="3.2" />
        <path d="M10.2 12h3.6" />
      </>
    ),
  },
  {
    id: "belt",
    name: "Ceinture",
    what: "Un élastique le long d'un bord (taille, bas, encolure), sur tout son tour.",
    icon: (
      <>
        <path d="M2.5 9.5h19v5h-19z" />
        <rect x="9.5" y="8" width="5" height="8" rx="1" />
        <path d="M12 12h3" />
      </>
    ),
  },
];


interface View {
  /** Top-left corner (sheet cm) and zoom (px per cm). */
  x: number;
  y: number;
  s: number;
}

type Drag =
  | { kind: "handle"; key: string; axis: Handle["axis"]; ox: number; oy: number; start: P2; startDelta: P2; moved: boolean }
  | { kind: "pan"; startClient: P2; startView: View; moved: boolean };

const fmt = (v: number, digits = 1) => v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (v: number) => `${v > 0.04 ? "+" : v < -0.04 ? "−" : "±"}${fmt(Math.abs(v))}`;

function bounds(pts: P2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Lengths of both sides of each seam the pattern asks to compare ("match": equal; "ease": b − a). */
function seamChecks(pattern: Pattern) {
  return pattern.checks.map((row) => {
    const seam = pattern.seams.find((s) => s.id === row.seam)!;
    const a = seamSideLength(pattern, seam.a), b = seamSideLength(pattern, seam.b);
    const diff = b - a;
    const warn = row.kind === "match" ? Math.abs(diff) > 0.3 : diff < -0.1 || diff > 1.5;
    return { ...row, id: row.seam.replace(/[+-]$/, ""), a, b, diff, warn };
  });
}

/** One drawn piece per name (twin / mirrored pieces are edited once), handles grouped by piece. */
function shownPieces(pattern: Pattern) {
  const seen = new Set<string>();
  return pattern.pieces.filter((p) => !seen.has(p.name) && seen.add(p.name));
}

/**
 * Interactive 2D pattern editor: drag the draft's points and curve handles (on the right half).
 * The same points can be dragged on the garment in 3D (lib/viewer/PatternOverlay.ts): the edits
 * of a drag under way are shared (`live`), whichever side it happens on.
 * Memoised: the studio re-renders with the simulation progress, the editor need not.
 */
export const PatternEditor = memo(function PatternEditor({ garment, measures, params, edits, live, onLive, focusKey, onFocus, onCommit, clasps, onClasps, belts, onBelts, free, onFree, onUndo, onRedo, canUndo, canRedo, allowances, onClose }: Props) {
  const liveRef = useRef<PatternEdits | null>(null);
  const shown = live ?? edits;
  const pattern = useMemo(() => garment.draft(measures, params, shown), [garment, measures, params, shown]);
  // Piece placement follows the committed pattern only: nothing shifts under the pointer while dragging.
  const committed = useMemo(() => garment.draft(measures, params, edits), [garment, measures, params, edits]);
  const colorOf = useMemo(() => edgeColorer(pattern), [pattern]);
  const issues = useMemo(() => patternIssues(pattern), [pattern]);
  const checks = useMemo(() => seamChecks(pattern), [pattern]);
  const cuts = useMemo(
    () => (allowances.seam > 0 || allowances.hem > 0 ? cutPieces(pattern, allowances, { fold: false }) : []),
    [pattern, allowances],
  );

  const layout = useMemo(() => {
    const slots = [];
    let x = 0;
    for (const piece of shownPieces(committed)) {
      const b = bounds(outline(piece));
      slots.push({ id: piece.id, name: piece.name, left: x, ox: x - b.minX, oy: b.maxY, w: b.maxX - b.minX, h: b.maxY - b.minY });
      x += b.maxX - b.minX + GAP;
    }
    return { slots, width: x - GAP, height: Math.max(...slots.map((s) => s.h)) };
  }, [committed]);

  // ---- View (pan / zoom), sized to the container.
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Framing: the pieces that carry editable points (a cape's 2 m panels would shrink its hood
  // to a few pixels); the others stay a pan or a zoom away.
  const editable = useMemo(() => new Set(committed.handles.map((h) => h.piece)), [committed]);
  const fit = useCallback((): View | null => {
    if (!size || size.w === 0 || size.h === 0) return null;
    const m = 6; // room for allowances and names
    const focus = layout.slots.filter((sl) => editable.has(sl.id));
    const slots = focus.length ? focus : layout.slots;
    const left = Math.min(...slots.map((sl) => sl.left)), right = Math.max(...slots.map((sl) => sl.left + sl.w));
    const bw = right - left + 2 * m, bh = Math.max(...slots.map((sl) => sl.h)) + 2 * m + 4;
    const s = Math.min(size.w / bw, size.h / bh);
    return { s, x: left - m - (size.w / s - bw) / 2, y: -m - 4 - (size.h / s - bh) / 2 };
  }, [size, layout, editable]);
  if (!view && size && fit()) setView(fit());

  const toSheet = useCallback(
    (clientX: number, clientY: number): P2 => {
      const r = svgRef.current!.getBoundingClientRect();
      return [view!.x + (clientX - r.left) / view!.s, view!.y + (clientY - r.top) / view!.s];
    },
    [view],
  );

  const hasView = view !== null;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !hasView) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        if (!v) return v;
        const s = Math.min(ZOOM.max, Math.max(ZOOM.min, v.s * Math.exp(-e.deltaY * 0.0015)));
        const px = v.x + mx / v.s, py = v.y + my / v.s;
        return { s, x: px - mx / s, y: py - my / s };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [hasView]);

  // ---- Selection, hover, drag.
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoverSeam, setHoverSeam] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<string | "pan" | null>(null);
  // The "Fermoir" tool: null when off; `a`: its first end, once clicked.
  const [placing, setPlacing] = useState<{ a: PiecePoint | null } | null>(null);
  const [hotClasp, setHotClasp] = useState<number | null>(null);
  const [selectedClasp, setSelectedClasp] = useState<number | null>(null);
  // The "Ceinture" tool, the belt pointed at or selected, and the palette of accessories.
  const [belting, setBelting] = useState(false);
  const [hotBelt, setHotBelt] = useState<number | null>(null);
  const [selectedBelt, setSelectedBelt] = useState<number | null>(null);
  const [palette, setPalette] = useState(false);
  // A drawn pattern's own tools: "Couture" (`a`: its first edge, once clicked) and the menu of new pieces.
  const [seaming, setSeaming] = useState<{ a: { piece: string; edge: string } | null } | null>(null);
  // The edge under the pointer while a tool that takes edges is on (belt, seam): shown as what a click would make.
  const [aimed, setAimed] = useState<{ piece: string; edge: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const tool: Accessory | "seam" | null = placing ? "clasp" : belting ? "belt" : seaming ? "seam" : null;
  const chooseTool = (next: Accessory | "seam" | null) => {
    setPlacing(next === "clasp" ? { a: null } : null);
    setBelting(next === "belt");
    setSeaming(next === "seam" ? { a: null } : null);
    setPalette(false);
    setAdding(false);
    setAimed(null);
  };

  const setLiveEdits = (e: PatternEdits | null) => {
    liveRef.current = e;
    onLive(e);
  };

  const startHandleDrag = (e: React.PointerEvent, h: Handle, ox: number, oy: number) => {
    if (tool) return; // an accessory tool takes the click, even on a point of the draft
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const [sx, sy] = toSheet(e.clientX, e.clientY);
    drag.current = { kind: "handle", key: h.key, axis: h.axis, ox, oy, start: [sx - ox, oy - sy], startDelta: edits[h.key] ?? [0, 0], moved: false };
    setDragging(h.key);
    setSelected(h.key);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { kind: "pan", startClient: [e.clientX, e.clientY], startView: view, moved: false };
    setDragging("pan");
    setSelected(null);
    setSelectedClasp(null);
    setSelectedBelt(null);
  };

  /**
   * A click of the "Fermoir" tool: the first one sets where the clasp starts, the second one
   * where it fastens. On a piece cut twice, of which one is drawn, a second click on the piece
   * of the first means its twin — the other front of a cape — unless `sameCopy`.
   */
  const placeClasp = (clientX: number, clientY: number, sameCopy: boolean) => {
    if (!placing || !view) return;
    const [sx, sy] = toSheet(clientX, clientY);
    let hit: { piece: Piece; pos: P2; d: number } | null = null;
    for (const slot of layout.slots) {
      const piece = pattern.pieces.find((p) => p.id === slot.id);
      if (!piece) continue;
      const pos: P2 = [sx - slot.ox, slot.oy - sy];
      const d = distanceToPiece(piece, pos);
      if (d <= CLASP.reach / view.s && (!hit || d < hit.d)) hit = { piece, pos, d };
    }
    if (!hit) return;
    const point = piecePointAt(hit.piece, hit.pos, CLASP.snap / view.s);
    if (!placing.a) return setPlacing({ a: point });
    const b = placing.a.piece === point.piece && !sameCopy ? (twinPoint(pattern, point) ?? point) : point;
    const [clasp] = validClasps(pattern, [{ a: placing.a, b }]);
    if (!clasp) return; // both ends on the same spot: wait for another click
    onClasps([...clasps, clasp]);
    setPlacing(null);
  };
  /** The edge of a drawn piece under the pointer (within the belts' reach), and the place pointed at on its piece. */
  const edgeAt = (clientX: number, clientY: number): { piece: string; edge: string; pos: P2 } | null => {
    if (!view) return null;
    const [sx, sy] = toSheet(clientX, clientY);
    let hit: { piece: Piece; pos: P2; d: number } | null = null;
    for (const slot of layout.slots) {
      const piece = pattern.pieces.find((p) => p.id === slot.id);
      if (!piece) continue;
      const pos: P2 = [sx - slot.ox, slot.oy - sy];
      const d = distanceToPiece(piece, pos);
      if (d <= BELT.reach / view.s && (!hit || d < hit.d)) hit = { piece, pos, d };
    }
    if (!hit) return null;
    const point = piecePointAt(hit.piece, hit.pos, BELT.reach / view.s);
    // Inside the piece, away from its edges: none.
    return point.offset[0] === 0 && point.offset[1] === 0 ? { piece: point.piece, edge: point.edge, pos: hit.pos } : null;
  };
  /** A click of the "Couture" tool of a drawn pattern: an edge, then the edge it is sewn to. */
  const placeSeam = (clientX: number, clientY: number) => {
    const at = edgeAt(clientX, clientY);
    if (!at || !free || !seaming) return;
    const side = { piece: at.piece, edge: at.edge };
    if (!seaming.a) return setSeaming({ a: side });
    if (seaming.a.piece === side.piece && seaming.a.edge === side.edge) return; // the same edge: wait for another
    onFree(addSeam(free, seaming.a, side));
    setSeaming(null);
  };
  /** A drawn pattern: what Suppr or a double click does to a handle — a point goes, a bent edge is straight again. */
  const freeRemove = (key: string) => {
    if (!free) return;
    const dot = key.indexOf("."), piece = key.slice(0, dot), what = key.slice(dot + 1);
    onFree(what.startsWith("c:") ? straighten(free, piece, what.slice(2)) : removePoint(free, piece, Number(what.slice(1))));
    setSelected(null);
  };
  /**
   * A click of the "Ceinture" tool: on a free edge of a piece — not a seam — which becomes a
   * belt, all the way round the garment (lib/pattern/belt.ts). One per tour: a second one
   * replaces the first.
   */
  const placeBelt = (clientX: number, clientY: number) => {
    const point = edgeAt(clientX, clientY);
    if (!point) return;
    const belt: Belt = { piece: point.piece, edge: point.edge, stretch: BELT_STRETCH.initial };
    const [added] = validBelts(pattern, [belt]);
    if (!added) return; // a seam: wait for a click on a free edge
    const on = (b: Belt) => added.ring.some((r) => r.piece === b.piece && r.edge === b.edge);
    onBelts([...belts.filter((b) => !on(b)), belt]);
    setBelting(false);
  };
  const removeBelt = (index: number) => {
    onBelts(belts.filter((_, i) => i !== index));
    setSelectedBelt(null);
    setHotBelt(null);
  };
  const removeClasp = (index: number) => {
    onClasps(clasps.filter((_, i) => i !== index));
    setSelectedClasp(null);
    setHotClasp(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d && (belting || seaming)) {
      // What a click here would take: an edge that can be belted (not a seam), or any edge to sew.
      const at = edgeAt(e.clientX, e.clientY);
      const next = at && (seaming || validBelts(pattern, [{ piece: at.piece, edge: at.edge, stretch: 0 }]).length) ? { piece: at.piece, edge: at.edge } : null;
      if (next?.piece !== aimed?.piece || next?.edge !== aimed?.edge) setAimed(next);
    }
    if (!d) return;
    if (d.kind === "pan") {
      const v = d.startView;
      if (Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) > 4) d.moved = true;
      setView({ ...v, x: v.x - (e.clientX - d.startClient[0]) / v.s, y: v.y - (e.clientY - d.startClient[1]) / v.s });
      return;
    }
    const [sx, sy] = toSheet(e.clientX, e.clientY);
    let mx = sx - d.ox - d.start[0], my = d.oy - sy - d.start[1];
    if (e.shiftKey) {
      if (Math.abs(mx) > Math.abs(my)) my = 0;
      else mx = 0;
    }
    const next = constrain([d.startDelta[0] + mx, d.startDelta[1] + my], d.axis);
    d.moved = true;
    setLiveEdits(withDelta(edits, d.key, next));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d?.kind === "handle" && d.moved && liveRef.current) onCommit(liveRef.current);
    setLiveEdits(null);
    // A click (not a pan) with the clasp tool on.
    if (d?.kind !== "pan" || d.moved || e.type !== "pointerup") return;
    if (placing) placeClasp(e.clientX, e.clientY, e.altKey);
    else if (belting) placeBelt(e.clientX, e.clientY);
    else if (seaming) placeSeam(e.clientX, e.clientY);
  };

  const resetHandle = useCallback((key: string) => onCommit(withDelta(edits, key, [0, 0])), [edits, onCommit]);

  // ---- Keyboard: undo / redo, nudge the selected point, reset it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        onRedo();
        return;
      }
      if ((placing || belting || palette || seaming || adding) && e.key === "Escape") return chooseTool(null);
      if (selectedBelt !== null && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        onBelts(belts.filter((_, i) => i !== selectedBelt));
        setSelectedBelt(null);
        return;
      }
      if (selectedBelt !== null && e.key === "Escape") return setSelectedBelt(null);
      if (selectedClasp !== null && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        onClasps(clasps.filter((_, i) => i !== selectedClasp));
        setSelectedClasp(null);
        return;
      }
      if (selectedClasp !== null && e.key === "Escape") return setSelectedClasp(null);
      if (!selected) return;
      const h = pattern.handles.find((x) => x.key === selected);
      if (!h) return;
      if (e.key === "Escape") setSelected(null);
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (free) freeRemove(selected);
        else resetHandle(selected);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : SNAP;
        const dir: P2 = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key] as P2;
        const cur = edits[selected] ?? [0, 0];
        const next = constrain([cur[0] + dir[0] * step, cur[1] + dir[1] * step], h.axis);
        if (next[0] !== cur[0] || next[1] !== cur[1]) onCommit(withDelta(edits, selected, next));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // chooseTool and freeRemove are made anew at each render: what they read is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, pattern, edits, onCommit, onUndo, onRedo, resetHandle, placing, belting, palette, seaming, adding, free, onFree, selectedClasp, clasps, onClasps, selectedBelt, belts, onBelts]);

  // ---- Drawing.
  const s = view?.s ?? 1;
  const px = (v: number) => v / s; // screen pixels → cm
  const highlighted = useMemo(() => {
    if (!hoverSeam) return new Set<string>();
    const out = new Set<string>();
    for (const seam of pattern.seams)
      if (seam.id.replace(/[+-]$/, "") === hoverSeam) for (const sd of [seam.a, seam.b]) out.add(`${sd.piece}/${sd.edge}`);
    return out;
  }, [hoverSeam, pattern]);
  const badPieces = new Set(issues.map((i) => i.piece));
  const editCount = Object.keys(edits).length;
  const dragged = dragging && dragging !== "pan" ? dragging : null;
  const focus = pattern.handles.find((h) => h.key === (dragged ?? focusKey ?? hovered ?? selected));
  const own = dragged ?? hovered ?? selected;
  useEffect(() => onFocus(own), [own, onFocus]);
  const focusDelta = focus ? (shown[focus.key] ?? [0, 0]) : null;
  const pieceName = (h: Handle) => pattern.pieces.find((p) => p.id === h.piece)?.name ?? "";

  // ---- Clasps: where their ends are drawn. An end on the twin of a drawn piece (the other
  // front of a cape) is shown at the same place of the drawn one, as a ring.
  const claspMark = (end: PiecePoint) => {
    let point: PiecePoint | null = end, slot = layout.slots.find((sl) => sl.id === end.piece);
    const twin = !slot;
    if (!slot) {
      point = twinPoint(pattern, end);
      slot = point ? layout.slots.find((sl) => sl.id === point!.piece) : undefined;
    }
    const pos = point && slot ? piecePointPosition(pattern, point) : null;
    return pos && slot ? { x: pos[0] + slot.ox, y: slot.oy - pos[1], twin } : null;
  };
  const claspName = (c: Clasp) => {
    const name = (id: string) => pattern.pieces.find((p) => p.id === id)?.name ?? "?";
    const a = name(c.a.piece), b = name(c.b.piece);
    return a === b && c.a.piece !== c.b.piece ? `${a} ↔ l'autre ${b.toLowerCase()}` : `${a} ↔ ${b}`;
  };
  const pending = placing?.a ? claspMark(placing.a) : null;
  // ---- Belts: the edges each runs along, and the one it was put on.
  const worn = validBelts(pattern, belts);
  const beltIndex = (b: Belt) => belts.indexOf(b);
  // A drawn pattern's own edges have no name ("e12"): "bord".
  const beltName = (b: Belt) => EDGE_NAMES[b.edge.replace(/[+-]$/, "")] ?? (/^e\d+$/.test(b.edge) ? "bord" : b.edge);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="mr-auto text-sm font-semibold">Patron 2D</h2>
        <ToolButton onClick={onUndo} disabled={!canUndo} title="Annuler (⌘Z)">Annuler</ToolButton>
        <ToolButton onClick={onRedo} disabled={!canRedo} title="Rétablir (⇧⌘Z)">Rétablir</ToolButton>
        <ToolButton onClick={() => onCommit(NO_EDITS)} disabled={editCount === 0} title="Revenir au tracé d'origine (morphologie et coupe conservées)">
          Réinitialiser{editCount ? ` (${editCount})` : ""}
        </ToolButton>
        {free && (
          <>
            <div className="relative">
              <ToolButton onClick={() => { chooseTool(null); setAdding((a) => !a); }} active={adding} title="Ajouter une pièce au patron" aria-expanded={adding}>
                Pièce +
              </ToolButton>
              {adding && (
                <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-line bg-panel p-2 shadow-lg" role="menu" aria-label="Nouvelle pièce">
                  <p className="mb-1.5 px-0.5 text-[10.5px] leading-snug text-muted">Un rectangle, posé sur la zone du corps choisie : à retailler ensuite.</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(ZONES) as Zone[]).map((zone) => (
                      <button
                        key={zone}
                        type="button"
                        role="menuitem"
                        onClick={() => { onFree(addPiece(free, zone, measures)); setAdding(false); setView(null); }}
                        className="rounded-lg border border-line bg-white/70 px-2 py-1.5 text-left text-xs font-medium transition-colors hover:border-ink"
                      >
                        {ZONES[zone]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <ToolButton onClick={() => chooseTool(seaming ? null : "seam")} active={!!seaming} title="Coudre deux bords : cliquer un bord, puis celui auquel il se coud">
              {seaming ? "Couture · annuler" : "Couture"}
            </ToolButton>
          </>
        )}
        <div className="relative">
          <ToolButton onClick={() => (tool && tool !== "seam" ? chooseTool(null) : (chooseTool(null), setPalette((p) => !p)))} active={(!!tool && tool !== "seam") || palette} title="Ajouter un accessoire sur le patron" aria-expanded={palette}>
            {tool && tool !== "seam" ? `${ACCESSORIES.find((a) => a.id === tool)!.name} · annuler` : "Accessoires +"}
          </ToolButton>
          {palette && (
            <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-line bg-panel p-2 shadow-lg" role="menu" aria-label="Accessoires">
              <div className="grid grid-cols-2 gap-2">
                {ACCESSORIES.map((a) => {
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="menuitem"
                      onClick={() => chooseTool(a.id)}
                      title={a.what}
                      className="flex flex-col items-start gap-1 rounded-lg border border-line bg-white/70 p-2.5 text-left transition-colors hover:border-ink"
                    >
                      <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
                        {a.icon}
                      </svg>
                      <span className="text-xs font-semibold">{a.name}</span>
                      <span className="text-[10.5px] leading-snug text-muted">{a.what}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 px-0.5 text-[10.5px] leading-snug text-muted">Choisir un accessoire, puis cliquer sur le patron pour le poser. Il apparaît dans la liste, d&apos;où on le retire.</p>
            </div>
          )}
        </div>
        <ToolButton onClick={() => setView(fit())} title="Afficher toutes les pièces">Recadrer</ToolButton>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer l'éditeur"
          title="Fermer l'éditeur"
          className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden">
        {view && size && (
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            viewBox={`${view.x} ${view.y} ${size.w / s} ${size.h / s}`}
            className="absolute inset-0 touch-none select-none"
            style={{ cursor: tool ? "crosshair" : dragging === "pan" ? "grabbing" : "grab" }}
            onPointerDown={onPointerDown}
            onDoubleClick={(e) => {
              // A drawn pattern: a double click on an edge puts a point there.
              const at = free && !tool ? edgeAt(e.clientX, e.clientY) : null;
              if (at && free) onFree(insertPoint(free, at.piece, at.edge, at.pos));
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="application"
            aria-label="Éditeur de patron"
          >
            <defs>
              <pattern id="grid1" width={1} height={1} patternUnits="userSpaceOnUse">
                <path d="M1 0H0V1" fill="none" stroke="#000" strokeOpacity={0.05} strokeWidth={px(1)} />
              </pattern>
              <pattern id="grid10" width={10} height={10} patternUnits="userSpaceOnUse">
                {s > 6 && <rect width={10} height={10} fill="url(#grid1)" />}
                <path d="M10 0H0V10" fill="none" stroke="#000" strokeOpacity={0.1} strokeWidth={px(1)} />
              </pattern>
            </defs>
            <rect x={view.x} y={view.y} width={size.w / s} height={size.h / s} fill="url(#grid10)" />

            {layout.slots.map((slot) => {
              const piece = pattern.pieces.find((p) => p.id === slot.id)!;
              const cut = cuts.find((c) => c.name === piece.name);
              const T = ([x, y]: P2) => `${(x + slot.ox).toFixed(3)},${(slot.oy - y).toFixed(3)}`;
              const handles = pattern.handles.filter((h) => h.piece === slot.id);
              const bad = badPieces.has(piece.name);
              const b = bounds(outline(piece));
              return (
                <g key={slot.id}>
                  <text x={slot.ox} y={slot.oy - b.maxY - px(14)} textAnchor="middle" fontSize={px(12)} fill="var(--color-muted)" fontWeight={600}>
                    {piece.name}
                    {piece.quantity > 1 ? ` ×${piece.quantity}` : ""}
                  </text>
                  {cut && (
                    <polygon points={cut.cutLine.map(T).join(" ")} fill="none" stroke="#b5ada0" strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(3)}`} />
                  )}
                  <polygon
                    points={outline(piece).map(T).join(" ")}
                    fill={bad ? "#fdecea" : "white"}
                    stroke={bad ? "#c0392b" : "var(--color-ink)"}
                    strokeWidth={px(1.25)}
                    strokeLinejoin="round"
                  />
                  {/* Centre line: the left half mirrors the right one. */}
                  {piece.symmetric && <line x1={slot.ox} y1={slot.oy - b.maxY - px(6)} x2={slot.ox} y2={slot.oy - b.minY + px(6)} stroke="var(--color-muted)" strokeWidth={px(1)} strokeDasharray={`${px(6)} ${px(3)} ${px(1)} ${px(3)}`} />}
                  {piece.edges.map((e) => {
                    const c = colorOf(piece.id, e.id);
                    const hi = highlighted.has(`${piece.id}/${e.id}`);
                    return c ? (
                      <polyline key={e.id} data-edge={`${piece.id}/${e.id}`} points={e.pts.map(T).join(" ")} fill="none" stroke={c} strokeWidth={px(hi ? 6 : 2.5)} strokeLinecap="round" strokeOpacity={hoverSeam && !hi ? 0.35 : 1} />
                    ) : null;
                  })}
                  {handles.map((h) =>
                    h.anchor ? (
                      <line key={`${h.key}-t`} x1={h.anchor[0] + slot.ox} y1={slot.oy - h.anchor[1]} x2={h.pos[0] + slot.ox} y2={slot.oy - h.pos[1]} stroke="var(--color-muted)" strokeWidth={px(1)} />
                    ) : null,
                  )}
                  {handles.map((h) => {
                    const cx = h.pos[0] + slot.ox, cy = slot.oy - h.pos[1];
                    const edited = !!shown[h.key];
                    // Under the pointer (here or on the garment in 3D) or dragged: filled with the outline's colour.
                    const hot = hovered === h.key || focusKey === h.key || dragged === h.key;
                    const sel = hot || selected === h.key;
                    const common = {
                      fill: hot ? "#c0643e" : edited ? "var(--color-ink)" : "white",
                      stroke: sel ? "#c0643e" : "var(--color-ink)",
                      strokeWidth: px(sel ? 2.5 : 1.5),
                      style: { cursor: h.axis === "vertical" ? "ns-resize" : h.axis === "horizontal" ? "ew-resize" : "move" },
                      onPointerDown: (e: React.PointerEvent) => startHandleDrag(e, h, slot.ox, slot.oy),
                      onPointerEnter: () => setHovered(h.key),
                      onPointerLeave: () => setHovered((k) => (k === h.key ? null : k)),
                      onDoubleClick: (e: React.MouseEvent) => {
                        e.stopPropagation(); // not a double click on the edge under it
                        if (tool) return;
                        if (free) freeRemove(h.key);
                        else resetHandle(h.key);
                      },
                    };
                    const r = px(h.anchor ? 4.5 : 5.5);
                    return (
                      <g key={h.key}>
                        {/* Larger invisible target for touch / imprecise pointers. */}
                        <circle cx={cx} cy={cy} r={px(12)} {...common} fill="transparent" stroke="none" />
                        {h.anchor ? <circle cx={cx} cy={cy} r={r} {...common} /> : <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} {...common} />}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Belts: their edges drawn over, and their elasticity written by the edge they were put on. */}
            {worn.map(({ belt, ring }) => {
              const i = beltIndex(belt), hot = hotBelt === i || selectedBelt === i;
              return (
                <g
                  key={`belt${i}`}
                  style={{ cursor: "pointer" }}
                  onPointerDown={(e) => {
                    if (tool) return;
                    e.stopPropagation();
                    setSelected(null);
                    setSelectedClasp(null);
                    setSelectedBelt(i);
                  }}
                  onPointerEnter={() => setHotBelt(i)}
                  onPointerLeave={() => setHotBelt((k) => (k === i ? null : k))}
                >
                  {ring.map(({ piece, edge }) => {
                    const slot = layout.slots.find((sl) => sl.id === piece);
                    const pts = slot && pattern.pieces.find((q) => q.id === piece)?.edges.find((q) => q.id === edge)?.pts;
                    if (!slot || !pts) return null;
                    const d = pts.map(([x, y]) => `${x + slot.ox},${slot.oy - y}`).join(" ");
                    const mid = pts[Math.floor(pts.length / 2)];
                    return (
                      <g key={`${piece}/${edge}`}>
                        <polyline points={d} fill="none" stroke="transparent" strokeWidth={px(14)} />
                        <polyline points={d} fill="none" stroke={BELT.color} strokeWidth={px(hot ? 5.5 : 4)} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                        <polyline points={d} fill="none" stroke="white" strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(4)}`} pointerEvents="none" />
                        {piece === belt.piece && edge === belt.edge && (
                          <text x={mid[0] + slot.ox} y={slot.oy - mid[1] + px(18)} fontSize={px(11)} textAnchor="middle" fill={BELT.color} stroke="white" strokeWidth={px(3)} paintOrder="stroke" pointerEvents="none" fontWeight={600}>
                            ceinture · {stretchLabel(belt.stretch)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Clasps: a dot where each starts, a ring where it fastens on the piece's twin, a dashed line between the two. */}
            {clasps.map((c, i) => {
              const a = claspMark(c.a), b = claspMark(c.b);
              if (!a || !b) return null;
              const hot = hotClasp === i || selectedClasp === i;
              const events = {
                style: { cursor: "pointer" },
                onPointerDown: (e: React.PointerEvent) => {
                  if (tool) return;
                  e.stopPropagation();
                  setSelected(null);
                  setSelectedBelt(null);
                  setSelectedClasp(i);
                },
                onPointerEnter: () => setHotClasp(i),
                onPointerLeave: () => setHotClasp((k) => (k === i ? null : k)),
              };
              return (
                <g key={i}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={CLASP.color} strokeWidth={px(hot ? 2.5 : 1.5)} strokeDasharray={`${px(5)} ${px(3)}`} pointerEvents="none" />
                  {[a, b].map((m, k) => (
                    <g key={k} {...events}>
                      <circle cx={m.x} cy={m.y} r={px(12)} fill="transparent" />
                      {m.twin ? (
                        <circle cx={m.x} cy={m.y} r={px(hot ? 9.5 : 8.5)} fill="none" stroke={CLASP.color} strokeWidth={px(2)} />
                      ) : (
                        <circle cx={m.x} cy={m.y} r={px(hot ? 6 : 5)} fill={CLASP.color} stroke="white" strokeWidth={px(1.5)} />
                      )}
                    </g>
                  ))}
                </g>
              );
            })}
            {pending && <circle cx={pending.x} cy={pending.y} r={px(5)} fill={CLASP.color} stroke="white" strokeWidth={px(1.5)} pointerEvents="none" />}
            {/* What a click would make: the belt all the way round, in its colour; the edge to sew. */}
            {aimed &&
              (belting ? (validBelts(pattern, [{ ...aimed, stretch: 0 }])[0]?.ring ?? []) : seaming ? [aimed] : []).map(({ piece, edge }) => {
                const slot = layout.slots.find((sl) => sl.id === piece);
                const pts = slot && pattern.pieces.find((q) => q.id === piece)?.edges.find((q) => q.id === edge)?.pts;
                return slot && pts ? (
                  <polyline key={`aim/${piece}/${edge}`} points={pts.map(([x, y]) => `${x + slot.ox},${slot.oy - y}`).join(" ")} fill="none" stroke={belting ? BELT.color : "#c0643e"} strokeWidth={px(5)} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={0.75} pointerEvents="none" />
                ) : null;
              })}
            {seaming?.a &&
              (() => {
                const slot = layout.slots.find((sl) => sl.id === seaming.a!.piece);
                const pts = slot && pattern.pieces.find((q) => q.id === seaming.a!.piece)?.edges.find((q) => q.id === seaming.a!.edge)?.pts;
                return slot && pts ? <polyline points={pts.map(([x, y]) => `${x + slot.ox},${slot.oy - y}`).join(" ")} fill="none" stroke="#c0643e" strokeWidth={px(6)} strokeLinecap="round" strokeOpacity={0.7} pointerEvents="none" /> : null;
              })()}
          </svg>
        )}

        {issues.length > 0 && (
          <div className="absolute inset-x-3 top-3 rounded-lg border border-[#e6b4ae] bg-[#fdecea]/95 px-3 py-2 text-xs text-[#8f2a1f] shadow-sm" role="alert">
            {issues.map((i) => (
              <p key={i.message}>{i.message}</p>
            ))}
            <p className="mt-0.5 text-[11px] opacity-80">La 3D garde la dernière version valide.</p>
          </div>
        )}

        <div className="pointer-events-auto absolute bottom-3 left-3 max-h-[42%] w-60 overflow-y-auto rounded-lg border border-line bg-white/90 p-2.5 text-[11px] shadow-sm backdrop-blur">
          <p className="mb-1.5 font-semibold uppercase tracking-[0.14em] text-muted">Coutures</p>
          <ul className="space-y-1">
            {checks.map((c) => (
              <li
                key={c.id}
                className="flex cursor-default items-baseline justify-between gap-2 rounded px-1 hover:bg-canvas"
                onPointerEnter={() => setHoverSeam(c.id)}
                onPointerLeave={() => setHoverSeam(null)}
              >
                <span>{c.label}</span>
                <span className={`tabular-nums ${c.warn ? "font-semibold text-[#b2442f]" : "text-muted"}`}>
                  {c.kind === "match" ? `${fmt(c.a)} / ${fmt(c.b)} · ${signed(c.diff)}` : `embu ${signed(c.diff)}`}
                </span>
                {free &&
                  (() => {
                    const drawn = freeSeams(free).find((x) => x.id === c.seam)?.seam;
                    const button = "grid size-5 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink";
                    return drawn ? (
                      <span className="flex items-center">
                        <button type="button" onClick={() => onFree(flipSeam(free, drawn))} title="Coudre dans l'autre sens (si la couture vrille)" aria-label={`Inverser la couture ${c.label}`} className={button}>
                          ⇄
                        </button>
                        <button type="button" onClick={() => onFree(removeSeam(free, drawn))} title="Découdre" aria-label={`Supprimer la couture ${c.label}`} className={button}>
                          ×
                        </button>
                      </span>
                    ) : null;
                  })()}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            {free ? (checks.length ? "Longueur des deux bords cousus (cm)." : "Aucune couture : outil « Couture », puis deux bords.") : "Devant / dos (cm). Embu : tête de manche − emmanchure."}
          </p>
          {free && (
            <>
              <p className="mb-1.5 mt-2.5 font-semibold uppercase tracking-[0.14em] text-muted">Pièces</p>
              <ul className="space-y-1">
                {free.pieces.map((piece) => (
                  <li key={piece.id} className="flex items-center justify-between gap-2 px-1">
                    <span className="min-w-0">
                      <span className="block truncate">{piece.name}</span>
                      {/* Where it is worn: the height of its top under the shoulder line (or the top of the arm). */}
                      <span className="block text-[10px] text-muted">
                        haut à {fmt(Math.max(0, -Math.max(...(pattern.pieces.find((q) => q.id === piece.id)?.edges.flatMap((e) => e.pts.map((pt) => pt[1])) ?? [0]))), 0)} cm
                      </span>
                    </span>
                    <span className="flex items-center gap-0.5">
                      {([[5, "↑", "Monter"], [-5, "↓", "Descendre"]] as const).map(([dy, sign, verb]) => (
                        <button
                          key={sign}
                          type="button"
                          onClick={() => onFree(movePiece(free, piece.id, dy))}
                          title={`${verb} la pièce de 5 cm sur le corps (là où elle est dessinée, elle se porte)`}
                          aria-label={`${verb} ${piece.name} de 5 cm`}
                          className="grid size-5 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink"
                        >
                          {sign}
                        </button>
                      ))}
                      <select
                        value={piece.zone}
                        onChange={(e) => onFree(setZone(free, piece.id, e.target.value as Zone))}
                        title="Où la pièce est posée sur le corps avant la couture"
                        aria-label={`Zone du corps de ${piece.name}`}
                        className="rounded border border-line bg-white px-1 py-0.5 text-[10.5px]"
                      >
                        {(Object.keys(ZONES) as Zone[]).map((zone) => (
                          <option key={zone} value={zone}>
                            {ZONES[zone]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => { onFree(removePiece(free, piece.id)); setView(null); }}
                        disabled={free.pieces.length <= 1}
                        title="Supprimer la pièce"
                        aria-label={`Supprimer la pièce ${piece.name}`}
                        className="grid size-5 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink disabled:opacity-30"
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {clasps.length + belts.length > 0 && (
            <>
              <p className="mb-1.5 mt-2.5 font-semibold uppercase tracking-[0.14em] text-muted">Accessoires</p>
              <ul className="space-y-1">
                {worn.map(({ belt: b, ring }) => {
                  const i = beltIndex(b);
                  const length = ringLength(pattern, ring) * (1 + Math.min(0, b.stretch));
                  const stretch = (by: number) =>
                    onBelts(belts.map((x) => (x === b ? { ...x, stretch: Math.round(Math.max(BELT_STRETCH.min, Math.min(BELT_STRETCH.max, x.stretch + by)) * 100) / 100 } : x)));
                  const button = "grid size-5 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink";
                  return (
                    <li
                      key={`belt${i}`}
                      className={`flex items-center justify-between gap-2 rounded px-1 ${hotBelt === i || selectedBelt === i ? "bg-canvas" : ""}`}
                      onPointerEnter={() => setHotBelt(i)}
                      onPointerLeave={() => setHotBelt(null)}
                    >
                      <span className="flex items-start gap-1.5">
                        <span className="mt-1.5 inline-block h-1 w-3 shrink-0 rounded-full" style={{ background: BELT.color }} aria-hidden />
                        <span>
                          Ceinture · {beltName(b)}
                          <span className="block text-[10px] text-muted">
                            {fmt(length)} cm · {stretchLabel(b.stretch)}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-0.5">
                        <button type="button" onClick={() => stretch(-BELT_STRETCH.step)} title="Plus serrée (moins élastique, puis froncée)" aria-label="Serrer la ceinture" className={button}>
                          −
                        </button>
                        <button type="button" onClick={() => stretch(BELT_STRETCH.step)} title="Plus élastique" aria-label="Rendre la ceinture plus élastique" className={button}>
                          +
                        </button>
                        <button type="button" onClick={() => removeBelt(i)} title="Supprimer la ceinture" aria-label="Supprimer la ceinture" className={button}>
                          ×
                        </button>
                      </span>
                    </li>
                  );
                })}
                {clasps.map((c, i) => (
                  <li
                    key={i}
                    className={`flex items-center justify-between gap-2 rounded px-1 ${hotClasp === i || selectedClasp === i ? "bg-canvas" : ""}`}
                    onPointerEnter={() => setHotClasp(i)}
                    onPointerLeave={() => setHotClasp(null)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-full" style={{ background: CLASP.color }} aria-hidden />
                      {claspName(c)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeClasp(i)}
                      aria-label={`Supprimer le fermoir ${claspName(c)}`}
                      title="Supprimer le fermoir"
                      className="grid size-5 place-items-center rounded-full text-muted transition-colors hover:bg-white hover:text-ink"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-3 right-3 max-w-[60%] text-right text-[11px] text-muted">
          {seaming ? (
            <p className="rounded-md bg-white/90 px-2 py-1 text-ink shadow-sm">
              <span className="font-medium">Couture</span> · {seaming.a ? "cliquer le bord auquel il se coud" : "cliquer un bord"} · Échap : annuler
            </p>
          ) : belting ? (
            <p className="rounded-md bg-white/90 px-2 py-1 text-ink shadow-sm">
              <span className="font-medium">Ceinture</span> · cliquer un bord libre du patron (taille, bas, encolure… pas une couture) : il devient élastique sur tout son tour · Échap : annuler
            </p>
          ) : placing ? (
            <p className="rounded-md bg-white/90 px-2 py-1 text-ink shadow-sm">
              <span className="font-medium">Fermoir</span> ·{" "}
              {placing.a
                ? "cliquer le point où il se raccroche — sur la même pièce d'une paire (×2), c'est l'autre exemplaire (Alt : le même)"
                : "cliquer son point de départ sur une pièce"}{" "}
              · Échap : annuler
            </p>
          ) : focus && focusDelta ? (
            <p className="rounded-md bg-white/90 px-2 py-1 text-ink shadow-sm">
              <span className="font-medium">{focus.label}</span> · {pieceName(focus)} · Δ {signed(focusDelta[0])} / {signed(focusDelta[1])} cm
            </p>
          ) : (
            <p>
              {free
                ? "Glisser un point ou le milieu d'un bord (il se courbe) · double-clic sur un bord : nouveau point · Suppr ou double-clic sur un point : l'enlever · molette : zoom"
                : "Glisser un point, ici ou sur le vêtement en 3D (Maj : axe) · double-clic : rétablir · flèches : 1 mm (Maj : 1 cm) · molette : zoom"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

function ToolButton({ children, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-ink disabled:opacity-40 disabled:hover:border-line ${active ? "border-ink bg-ink text-white" : "border-line bg-white"}`}
    >
      {children}
    </button>
  );
}
