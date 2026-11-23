"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { SharedPattern } from "@/lib/library/store";
import { thumbOf, type PatternThumb as Thumb } from "@/lib/pattern/thumb";
import { CUT_LABELS, CUTS, garmentDef, garmentId, garmentsOf, type Cut } from "@/lib/pattern/garments";
import type { DxfUnits } from "@/lib/pattern/import/dxf";
import { searchable, type SavedPattern } from "./hooks/useLibrary";

/** Thumbnail size (tools/thumbnails captures them at this ratio). */
const THUMB = { w: 480, h: 640 };

interface Props {
  open: boolean;
  /** Id of the garment worn (lib/pattern/garments.ts). */
  current: string;
  onSelect: (id: string) => void;
  /** A pattern of the user's own is started: from simple shapes, or as a copy of the garment worn. */
  onDraw: (source: "simple" | "copy") => void;
  /** A pattern of the user's own is read from a DXF file (AAMA / ASTM); throws, with a message for the user, when it cannot be. */
  onImport: (text: string, units: DxfUnits) => void;
  /** The shared library (lib/library/store.ts: what the assistant drew, for everyone) and how to wear one of its patterns. */
  shared: readonly SharedPattern[];
  onWearShared: (id: string) => void;
  /** The visitor's own patterns (hooks/useLibrary.ts: their variants and retouches, in this browser), the pattern being worn (of either library), and how to wear or forget one of theirs. */
  saved: readonly SavedPattern[];
  savedId: string | null;
  onWearSaved: (id: string) => void;
  onForgetSaved: (id: string) => void;
  /** There is a drawing already (it can be taken up again); the garment worn can be copied into one. */
  hasDrawing: boolean;
  canCopy: boolean;
  onClose: () => void;
}

/** Id of the user's own drawing among the garments (components/hooks/useGarment.ts FREE). */
const DRAWING = "free";

/**
 * The garment picker: it takes the place of the workshop's side panel while a garment is
 * chosen (Studio.tsx). A search, the cut (the men's or the women's of
 * each garment of the catalogue), a pattern of one's own to start, then small cards — the
 * shared library, the visitor's own patterns, the catalogue (meant to grow to dozens of
 * garments), each with a picture and its name. Escape goes back.
 */
/** A pattern as its card shows it: its pieces side by side, as they are drawn. */
function PatternThumb({ thumb }: { thumb: Thumb }) {
  return (
    <svg viewBox={`-4 -4 ${thumb.width + 8} ${thumb.height + 8}`} className="size-full p-3" preserveAspectRatio="xMidYMid meet" aria-hidden>
      {thumb.pieces.map((piece) => (
        <polygon key={piece.id} points={piece.points} fill="white" stroke="var(--color-ink)" strokeWidth={Math.max(thumb.width, thumb.height) / 160} strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** The card of a pattern of a library — the shared one or the visitor's own. */
function PatternCard({ name, note, thumb, worn, onWear, onForget }: { name: string; note: string; thumb: Thumb; worn: boolean; onWear: () => void; onForget?: () => void }) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onWear}
        aria-pressed={worn}
        title={note}
        className="group flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ink hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink aria-pressed:ring-1 aria-pressed:ring-ink"
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-canvas">
          <PatternThumb thumb={thumb} />
          {worn && <span className="absolute left-2 top-2 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-white">Actuel</span>}
        </div>
        <div className="px-2.5 py-2">
          <p className="truncate text-[13px] font-semibold leading-tight">{name}</p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted">{note}</p>
        </div>
      </button>
      {onForget && (
        <button
          type="button"
          onClick={onForget}
          aria-label={`Supprimer le patron « ${name} »`}
          title="Supprimer ce patron de ce navigateur"
          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full border border-line bg-white/90 text-xs text-muted transition-colors hover:border-[#b2442f] hover:text-[#b2442f]"
        >
          ×
        </button>
      )}
    </li>
  );
}

const UNITS: Record<DxfUnits, string> = { auto: "Unités : auto", mm: "mm", cm: "cm", in: "pouces" };

export function GarmentPicker({ open, current, onSelect, onDraw, onImport, shared, onWearShared, saved, savedId, onWearSaved, onForgetSaved, hasDrawing, canCopy, onClose }: Props) {
  const search = useRef<HTMLInputElement>(null);
  const [units, setUnits] = useState<DxfUnits>("auto");
  const [importError, setImportError] = useState<string | null>(null);
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      onImport(await file.text(), units);
      setImportError(null);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Ce fichier n'a pas pu être lu.");
    }
  };
  // The garment worn, when it is one of the catalogue's (not the user's own drawing).
  const worn = garmentDef(current) as ReturnType<typeof garmentDef> | undefined;
  // The cut shown: the worn garment's each time the picker opens, then as switched.
  const [shown, setShown] = useState<{ cut: Cut; forOpen: boolean }>({ cut: worn?.cut ?? "homme", forOpen: open });
  if (shown.forOpen !== open) setShown({ cut: worn?.cut ?? shown.cut, forOpen: open });
  const cut = shown.cut;
  // Search: the garments of the catalogue (in the cut shown) and the saved patterns whose name or description has every word typed.
  const [query, setQuery] = useState("");
  const words = searchable(query).split(/\s+/).filter(Boolean);
  const matches = (...texts: string[]) => words.every((w) => texts.some((t) => searchable(t).includes(w)));
  const catalogue = garmentsOf(cut).filter((g) => matches(g.name, g.description, g.short));
  const mine = saved.filter((p) => matches(p.name, p.note));
  const common = shared.filter((p) => matches(p.name, p.note));

  // Opened: the search is where one types; Escape goes back to the panel.
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  const GRID = "grid grid-cols-2 gap-2.5";
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" role="region" aria-labelledby="garment-picker-title">
      <header className="space-y-2.5 border-b border-line px-5 pb-3 pt-3 md:pt-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Revenir à l'atelier"
            title="Retour"
            className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-muted transition-colors hover:border-ink hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M12 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h2 id="garment-picker-title" className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            Choisir un vêtement
          </h2>
          <div className="inline-flex gap-1 rounded-full border border-line bg-white/60 p-0.5" role="group" aria-label="Coupe">
            {CUTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setShown({ cut: c, forOpen: open })}
                aria-pressed={c === cut}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
              >
                {CUT_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher un vêtement…"
          aria-label="Rechercher un vêtement"
          className="w-full rounded-full border border-line bg-white/80 px-3.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-ink"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* A pattern of one's own: drawn in the 2D editor, from simple shapes or from a garment of the catalogue. */}
        <section className="mb-5 rounded-xl border border-line bg-white/50 p-3" aria-labelledby="garment-picker-drawing">
          <div className="flex flex-col gap-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="garment-picker-drawing" className="text-sm font-semibold">
                Dessiner son propre patron
                {current === DRAWING && <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-white">Actuel</span>}
              </h3>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">
                Des pièces faites de points à glisser : on en ajoute, on courbe les bords, on coud deux bords en deux clics. Chaque pièce se pose sur une zone du corps. Pour le faire dessiner d&apos;après une description, demandez-le à l&apos;assistant.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {hasDrawing && current !== DRAWING && (
                <button type="button" onClick={() => onSelect(DRAWING)} className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90">
                  Reprendre mon patron
                </button>
              )}
              <button type="button" onClick={() => onDraw("simple")} className="rounded-full border border-ink px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-ink hover:text-white">
                Partir de formes simples
              </button>
              <button
                type="button"
                onClick={() => onDraw("copy")}
                disabled={!canCopy}
                title={canCopy ? "Le vêtement porté devient un dessin : mêmes pièces, mêmes coutures, tout modifiable" : "Le vêtement porté est déjà un dessin"}
                className="rounded-full border border-ink px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-ink hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink"
              >
                Copier le vêtement porté{worn ? ` (${worn.short.toLowerCase()})` : ""}
              </button>
              <span className="inline-flex items-stretch overflow-hidden rounded-full border border-ink text-xs font-medium">
                <label
                  title="Lire les pièces d'un patron au format DXF AAMA ou ASTM (Gerber, Lectra, Optitex, CLO…) : elles arrivent non cousues"
                  className="cursor-pointer px-3.5 py-1.5 transition-colors hover:bg-ink hover:text-white focus-within:bg-ink focus-within:text-white"
                >
                  Importer un DXF…
                  <input
                    type="file"
                    accept=".dxf,application/dxf,image/vnd.dxf"
                    className="sr-only"
                    onChange={(e) => {
                      void readFile(e.target.files?.[0]);
                      e.target.value = ""; // the same file can be chosen again
                    }}
                  />
                </label>
                <select value={units} onChange={(e) => setUnits(e.target.value as DxfUnits)} aria-label="Unités du fichier DXF" title="Unités du fichier : devinées, ou imposées si les pièces arrivent à la mauvaise taille" className="border-l border-ink bg-transparent px-1.5 text-[11px] font-normal outline-none">
                  {(Object.keys(UNITS) as DxfUnits[]).map((u) => (
                    <option key={u} value={u}>
                      {UNITS[u]}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          </div>
          {importError && (
            <p className="mt-2 text-[11px] text-[#b2442f]" role="alert">
              {importError}
            </p>
          )}
          {hasDrawing && <p className="mt-2 text-[10.5px] text-muted">Un nouveau départ remplace le patron déjà dessiné.</p>}
        </section>

        {/* The shared library: what the assistant drew, for every visitor. */}
        {common.length > 0 && (
          <section className="mb-5" aria-labelledby="garment-picker-shared">
            <h3 id="garment-picker-shared" className="mb-2 text-sm font-semibold">
              Bibliothèque commune <span className="font-normal text-muted">· dessinés par l&apos;assistant, disponibles pour tous</span>
            </h3>
            <ul className={GRID}>
              {common.map((p) => (
                <PatternCard key={p.id} name={p.name} note={p.note || `${p.pieces} pièces`} thumb={p.thumb} worn={p.id === savedId && current === DRAWING} onWear={() => onWearShared(p.id)} />
              ))}
            </ul>
          </section>
        )}

        {/* The visitor's own: variants and retouches, kept in this browser. */}
        {mine.length > 0 && (
          <section className="mb-5" aria-labelledby="garment-picker-saved">
            <h3 id="garment-picker-saved" className="mb-2 text-sm font-semibold">
              Mes patrons <span className="font-normal text-muted">· variantes et retouches, gardées dans ce navigateur</span>
            </h3>
            <ul className={GRID}>
              {mine.map((p) => (
                <PatternCard
                  key={p.id}
                  name={p.name}
                  note={p.note || `${p.free.pieces.length} pièces`}
                  thumb={thumbOf(p.free)}
                  worn={p.id === savedId && current === DRAWING}
                  onWear={() => onWearSaved(p.id)}
                  onForget={() => onForgetSaved(p.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {(mine.length > 0 || common.length > 0) && catalogue.length > 0 && <h3 className="mb-2 text-sm font-semibold">Catalogue</h3>}
        {words.length > 0 && !mine.length && !common.length && !catalogue.length && (
          <p className="rounded-xl border border-line bg-panel p-4 text-xs text-muted">Aucun vêtement ne correspond à « {query.trim()} ». Demandez-le à l&apos;assistant : il le dessinera et il sera gardé ici.</p>
        )}
        <ul className={GRID}>
          {catalogue.map((g) => {
            const selected = g.id === current;
            // The same style in the other cut is worn: this card switches the cut.
            const twin = !selected && !!worn && g.id === garmentId(worn.style, cut);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onSelect(g.id)}
                  aria-pressed={selected}
                  title={g.description}
                  className="group flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ink hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink aria-pressed:ring-1 aria-pressed:ring-ink"
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden bg-canvas">
                    <Image
                      src={g.image}
                      alt=""
                      width={THUMB.w}
                      height={THUMB.h}
                      sizes="(min-width: 768px) 160px, 46vw"
                      className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                    {(selected || twin) && (
                      <span className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${selected ? "bg-ink text-white" : "bg-white/90 text-ink"}`}>
                        {selected ? "Actuel" : `Actuel en ${CUT_LABELS[worn!.cut].toLowerCase()}`}
                      </span>
                    )}
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="truncate text-[13px] font-semibold leading-tight">{g.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted">{g.description}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
