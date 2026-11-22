"use client";

import { useSyncExternalStore } from "react";
import type { FreePattern } from "@/lib/pattern/free";
import type { Belt, Clasp } from "@/lib/pattern/types";

/**
 * The user's own patterns, beside the catalogue's: what the assistant drew for them, kept to
 * be worn again — in this browser's local storage, no account, like the conversations and the
 * workshop's settings (hooks/useAssistant.ts, Studio.tsx).
 *
 * A saved pattern is a drawing (lib/pattern/free.ts) with its accessories. It is drawn in
 * centimetres for the body it was asked for: worn on another body it keeps its sizes. Wearing
 * one gives a copy to work on; changing that copy saves a variant under another name (the
 * garment hook does: hooks/useGarment.ts), so that what is in the library stays what it was.
 */
export interface SavedPattern {
  id: string;
  name: string;
  /** What it is, in a sentence (the pattern maker's note). */
  note: string;
  /** When it was drawn, and last changed (ms since the epoch). */
  createdAt: number;
  updatedAt: number;
  free: FreePattern;
  clasps: Clasp[];
  belts: Belt[];
}

const STORE = "couture.library.v1";
/** Patterns kept: the oldest left unchanged is forgotten first. */
const KEPT = 60;
const NONE: readonly SavedPattern[] = [];

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(36).slice(2)}`);

/** The library as a store React reads (useSyncExternalStore): read from the storage once, written back at each change. */
const store = (() => {
  let patterns: readonly SavedPattern[] | null = null;
  const listeners = new Set<() => void>();
  const read = (): readonly SavedPattern[] => {
    if (patterns) return patterns;
    let kept: SavedPattern[] = [];
    try {
      const stored = JSON.parse(localStorage.getItem(STORE) ?? "null") as unknown;
      if (Array.isArray(stored))
        kept = stored.filter(
          (p): p is SavedPattern => !!p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.free?.pieces) && p.free.pieces.length > 0 && Array.isArray(p.free.seams) && Array.isArray(p.clasps) && Array.isArray(p.belts),
        );
    } catch {
      // Unreadable: an empty library.
    }
    return (patterns = kept);
  };
  const write = (next: readonly SavedPattern[]) => {
    patterns = [...next].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEPT);
    try {
      localStorage.setItem(STORE, JSON.stringify(patterns));
    } catch {
      // Storage full or refused: the library lasts as long as the page.
    }
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read,
    /** A pattern more; its name is made its own when another has it already ("Robe" → "Robe 2"). Returns its id. */
    add(pattern: Pick<SavedPattern, "name" | "note" | "free" | "clasps" | "belts">): string {
      const taken = new Set(read().map((p) => p.name.toLowerCase()));
      const base = pattern.name.trim() || "Patron";
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
      const id = newId(), now = Date.now();
      write([{ ...pattern, id, name, createdAt: now, updatedAt: now }, ...read()]);
      return id;
    },
    /** The drawing of a pattern brought up to date. */
    update(id: string, drawing: Pick<SavedPattern, "free" | "clasps" | "belts">) {
      if (!read().some((p) => p.id === id)) return;
      write(read().map((p) => (p.id === id ? { ...p, ...drawing, updatedAt: Date.now() } : p)));
    },
    remove(id: string) {
      write(read().filter((p) => p.id !== id));
    },
  };
})();

/** The saved patterns, the latest first, and how to change them. */
export function useLibrary() {
  const patterns = useSyncExternalStore(store.subscribe, store.read, () => NONE);
  return { patterns, add: store.add, update: store.update, remove: store.remove };
}

export type Library = ReturnType<typeof useLibrary>;

/** Text as it is searched: lower case, without accents. */
export const searchable = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
