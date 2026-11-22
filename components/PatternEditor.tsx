"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { P2 } from "@/lib/pattern/curves";
import { constrain, SNAP, withDelta } from "@/lib/pattern/edit";
import { cutPieces, type Allowances } from "@/lib/pattern/markings";
import type { GarmentDef, GarmentParams } from "@/lib/pattern/garments";
import { NO_EDITS, seamSideLength, type BodyMeasures, type Handle, type Pattern, type PatternEdits } from "@/lib/pattern/types";
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
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  allowances: Allowances;
  onClose: () => void;
}

const GAP = 8; // cm between pieces
const ZOOM = { min: 2, max: 80 }; // px per cm


interface View {
  /** Top-left corner (sheet cm) and zoom (px per cm). */
  x: number;
  y: number;
  s: number;
}

type Drag =
  | { kind: "handle"; key: string; axis: Handle["axis"]; ox: number; oy: number; start: P2; startDelta: P2; moved: boolean }
  | { kind: "pan"; startClient: P2; startView: View };

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
export const PatternEditor = memo(function PatternEditor({ garment, measures, params, edits, live, onLive, focusKey, onFocus, onCommit, onUndo, onRedo, canUndo, canRedo, allowances, onClose }: Props) {
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

  const setLiveEdits = (e: PatternEdits | null) => {
    liveRef.current = e;
    onLive(e);
  };

  const startHandleDrag = (e: React.PointerEvent, h: Handle, ox: number, oy: number) => {
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
    drag.current = { kind: "pan", startClient: [e.clientX, e.clientY], startView: view };
    setDragging("pan");
    setSelected(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      const v = d.startView;
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

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d?.kind === "handle" && d.moved && liveRef.current) onCommit(liveRef.current);
    setLiveEdits(null);
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
      if (!selected) return;
      const h = pattern.handles.find((x) => x.key === selected);
      if (!h) return;
      if (e.key === "Escape") setSelected(null);
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        resetHandle(selected);
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
  }, [selected, pattern, edits, onCommit, onUndo, onRedo, resetHandle]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="mr-auto text-sm font-semibold">Patron 2D</h2>
        <ToolButton onClick={onUndo} disabled={!canUndo} title="Annuler (⌘Z)">Annuler</ToolButton>
        <ToolButton onClick={onRedo} disabled={!canRedo} title="Rétablir (⇧⌘Z)">Rétablir</ToolButton>
        <ToolButton onClick={() => onCommit(NO_EDITS)} disabled={editCount === 0} title="Revenir au tracé d'origine (morphologie et coupe conservées)">
          Réinitialiser{editCount ? ` (${editCount})` : ""}
        </ToolButton>
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
            style={{ cursor: dragging === "pan" ? "grabbing" : "grab" }}
            onPointerDown={onPointerDown}
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
                      <polyline key={e.id} points={e.pts.map(T).join(" ")} fill="none" stroke={c} strokeWidth={px(hi ? 6 : 2.5)} strokeLinecap="round" strokeOpacity={hoverSeam && !hi ? 0.35 : 1} />
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
                      onDoubleClick: () => resetHandle(h.key),
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

        <div className="pointer-events-auto absolute bottom-3 left-3 w-60 rounded-lg border border-line bg-white/90 p-2.5 text-[11px] shadow-sm backdrop-blur">
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
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">Devant / dos (cm). Embu : tête de manche − emmanchure.</p>
        </div>

        <div className="pointer-events-none absolute bottom-3 right-3 max-w-[60%] text-right text-[11px] text-muted">
          {focus && focusDelta ? (
            <p className="rounded-md bg-white/90 px-2 py-1 text-ink shadow-sm">
              <span className="font-medium">{focus.label}</span> · {pieceName(focus)} · Δ {signed(focusDelta[0])} / {signed(focusDelta[1])} cm
            </p>
          ) : (
            <p>Glisser un point, ici ou sur le vêtement en 3D (Maj : axe) · double-clic : rétablir · flèches : 1 mm (Maj : 1 cm) · molette : zoom</p>
          )}
        </div>
      </div>
    </div>
  );
});

function ToolButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium transition-colors hover:border-ink disabled:opacity-40 disabled:hover:border-line"
    >
      {children}
    </button>
  );
}
