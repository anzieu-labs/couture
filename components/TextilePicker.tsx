"use client";

import { useEffect, useRef } from "react";
import { CUSTOM_TEXTILE, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import { Swatch } from "./Swatch";

interface Props {
  open: boolean;
  /** The textiles offered: the library's, then the user's own. */
  textiles: readonly Textile[];
  /** Id of the textile the garment is made of (lib/textiles/catalog.ts). */
  current: string;
  /** The colours each textile is shown in: the user's own, kept per textile. */
  colorsById: Record<string, TextileColors>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** One line under a textile's name: what it is, how heavy, how it hangs. */
export const textileSummary = (t: Textile) => `${t.family} · ${t.weight} g/m² · ${t.drape}`;

/**
 * Full-page textile picker, the garment picker's twin (GarmentPicker.tsx): a grid of small
 * cards, each with a swatch of the textile in its colours, its name and what it is. A native
 * modal dialog (focus kept inside, Escape closes); a click outside the cards closes it too.
 */
export function TextilePicker({ open, textiles, current, colorsById, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

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
      aria-labelledby="textile-picker-title"
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-y-auto bg-canvas/95 p-0 text-ink backdrop:bg-ink/30 backdrop:backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <header className="mb-5 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <h2 id="textile-picker-title" className="text-xl font-semibold tracking-tight">
              Choisir un tissu
            </h2>
            <p className="mt-0.5 text-xs text-muted">Son aspect, et sa mécanique : grammage, rigidité, élasticité. Le vêtement est recousu dedans.</p>
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

        {/* The swatches are drawn when the picker opens, not with the panel. */}
        {open && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {textiles.map((t) => {
              const selected = t.id === current, own = t.id === CUSTOM_TEXTILE;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    aria-pressed={selected}
                    title={`${t.structure} · ${t.composition}`}
                    className="group flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ink hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink aria-pressed:ring-1 aria-pressed:ring-ink"
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-canvas">
                      <Swatch textile={t} colors={colorsById[t.id]} className="size-full transition-transform duration-300 group-hover:scale-[1.03]" />
                      {selected && <span className="absolute left-2 top-2 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-white">Actuel</span>}
                      {own && <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-ink">À définir soi-même</span>}
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="truncate text-[13px] font-semibold leading-tight">{t.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted">{textileSummary(t)}</p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </dialog>
  );
}
