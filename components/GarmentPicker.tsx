"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { CUT_LABELS, CUTS, garmentDef, garmentId, garmentsOf, type Cut } from "@/lib/pattern/garments";
import type { DxfUnits } from "@/lib/pattern/import/dxf";

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
  /** There is a drawing already (it can be taken up again); the garment worn can be copied into one. */
  hasDrawing: boolean;
  canCopy: boolean;
  onClose: () => void;
}

/** Id of the user's own drawing among the garments (components/hooks/useGarment.ts FREE). */
const DRAWING = "free";

/**
 * Full-page garment picker: a grid of small cards — the catalogue is meant to grow to dozens
 * of garments — each with a picture of the garment draped on the mannequin and its name, for
 * one cut at a time; a switch in the header goes from the men's cuts to the women's. A native
 * modal dialog (focus kept inside, Escape closes); a click outside the cards closes it too.
 */
const UNITS: Record<DxfUnits, string> = { auto: "Unités : auto", mm: "mm", cm: "cm", in: "pouces" };

export function GarmentPicker({ open, current, onSelect, onDraw, onImport, hasDrawing, canCopy, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="garment-picker-title"
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-y-auto bg-canvas/95 p-0 text-ink backdrop:bg-ink/30 backdrop:backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <h2 id="garment-picker-title" className="text-xl font-semibold tracking-tight">
              Choisir un vêtement
            </h2>
            <p className="mt-0.5 text-xs text-muted">Tracé sur les mesures du mannequin, puis cousu et drapé en 3D.</p>
          </div>
          <div className="inline-flex gap-1 rounded-full border border-line bg-white/60 p-1" role="group" aria-label="Coupe">
            {CUTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setShown({ cut: c, forOpen: open })}
                aria-pressed={c === cut}
                className="rounded-full px-3.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
              >
                {CUT_LABELS[c]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-white/80 text-muted transition-colors hover:border-ink hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* A pattern of one's own: drawn in the 2D editor, from simple shapes or from a garment of the catalogue. */}
        <section className="mb-5 rounded-xl border border-line bg-panel p-3" aria-labelledby="garment-picker-drawing">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <h3 id="garment-picker-drawing" className="text-sm font-semibold">
                Dessiner son propre patron
                {current === DRAWING && <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-white">Actuel</span>}
              </h3>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">
                Des pièces faites de points à glisser : on en ajoute, on courbe les bords, on coud deux bords en deux clics. Chaque pièce se pose sur une zone du corps.
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
                title={canCopy ? "Le vêtement porté devient un dessin : mêmes pièces, mêmes coutures, tout modifiable" : "Ce vêtement ne peut pas être copié (cape : son cercle se pose à plat ; ou c'est déjà un dessin)"}
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

        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {garmentsOf(cut).map((g) => {
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
                      sizes="(min-width: 1024px) 180px, (min-width: 768px) 23vw, (min-width: 640px) 31vw, 46vw"
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
    </dialog>
  );
}
