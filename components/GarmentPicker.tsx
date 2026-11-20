"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { GARMENTS } from "@/lib/pattern/garments";
import type { GarmentKind } from "@/lib/pattern/types";

/** Thumbnail size (tools/thumbnails captures them at this ratio). */
const THUMB = { w: 480, h: 640 };

interface Props {
  open: boolean;
  current: GarmentKind;
  onSelect: (kind: GarmentKind) => void;
  onClose: () => void;
}

/**
 * Full-page garment picker: one card per garment, with a picture of it draped on
 * the mannequin and its name. A native modal dialog (focus kept inside, Escape
 * closes); a click outside the cards closes it too.
 */
export function GarmentPicker({ open, current, onSelect, onClose }: Props) {
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
      aria-labelledby="garment-picker-title"
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-y-auto bg-canvas/95 p-0 text-ink backdrop:bg-ink/30 backdrop:backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-10" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <header className="mb-6 flex items-start justify-between gap-4 md:mb-8">
          <div>
            <h2 id="garment-picker-title" className="text-xl font-semibold tracking-tight md:text-2xl">
              Choisir un vêtement
            </h2>
            <p className="mt-1 text-sm text-muted">Le patron est tracé sur les mesures du mannequin, puis cousu et drapé en 3D.</p>
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

        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {GARMENTS.map((g) => {
            const selected = g.id === current;
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onSelect(g.id)}
                  aria-pressed={selected}
                  className="group flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ink hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink aria-pressed:ring-1 aria-pressed:ring-ink"
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden bg-canvas">
                    <Image
                      src={g.image}
                      alt=""
                      width={THUMB.w}
                      height={THUMB.h}
                      sizes="(min-width: 1024px) 360px, (min-width: 640px) 45vw, 90vw"
                      className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                    {selected && (
                      <span className="absolute left-3 top-3 rounded-full bg-ink px-2.5 py-1 text-[11px] font-medium text-white">Actuel</span>
                    )}
                  </div>
                  <div className="px-4 py-3.5">
                    <p className="font-semibold">{g.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{g.description}</p>
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
