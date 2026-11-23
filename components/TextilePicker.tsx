"use client";

import { useEffect, useRef, useState } from "react";
import { CUSTOM_TEXTILE, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import { searchable } from "./hooks/useLibrary";
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
 * The textile picker, the garment picker's twin (GarmentPicker.tsx): it takes the place of the
 * workshop's side panel while a textile is chosen (Studio.tsx). A search, then small cards,
 * each with a swatch of the textile in its colours, its name and what it is. Escape goes back.
 */
export function TextilePicker({ open, textiles, current, colorsById, onSelect, onClose }: Props) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  // The swatches are drawn the first time the picker opens, not with the panel.
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  // Search: the textiles whose name or description (family, weave, composition, drape) has every word typed.
  const [query, setQuery] = useState("");
  const words = searchable(query).split(/\s+/).filter(Boolean);
  const found = textiles.filter((t) => {
    const text = searchable(`${t.name} ${t.family} ${t.structure} ${t.composition} ${t.drape} ${t.weight} g`);
    return words.every((w) => text.includes(w));
  });
  // Nothing of the library answers the search: the user's own textile, to be set to what they were looking for.
  const none = words.length > 0 && !found.length;
  const shown = none ? textiles.filter((t) => t.id === CUSTOM_TEXTILE) : found;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" role="region" aria-labelledby="textile-picker-title">
      <header className="border-b border-line px-5 pb-3 pt-3 md:pt-4">
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
          <h2 id="textile-picker-title" className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            Choisir un tissu
          </h2>
        </div>
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher un tissu…"
          aria-label="Rechercher un tissu"
          className="mt-2.5 w-full rounded-full border border-line bg-white/80 px-3.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-ink"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-3 text-[11px] leading-snug text-muted">Son aspect, et sa mécanique : grammage, rigidité, élasticité. Le vêtement est recousu dedans.</p>
        {seen && none && (
          <p className="mb-3 rounded-xl border border-line bg-white/50 p-3 text-xs text-muted">
            Aucun tissu de la bibliothèque ne correspond à « {query.trim()} ». Définissez-le vous-même : grammage, épaisseur, rigidité, élasticité.
          </p>
        )}
        {seen && (
          <ul className="grid grid-cols-2 gap-2.5">
            {shown.map((t) => {
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
    </div>
  );
}
