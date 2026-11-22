"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { SharedDrawing, SharedPattern } from "@/lib/library/store";

/**
 * The shared library of patterns as the page knows it (lib/library/store.ts, app/api/library):
 * what the assistant drew, for every visitor. Listed once the page is there and again when a
 * pattern is added; a pattern's drawing is fetched when it is worn. Nothing here is ever
 * changed from the page.
 */
const NONE: readonly SharedPattern[] = [];

const store = (() => {
  let patterns: readonly SharedPattern[] = NONE;
  let asked: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const load = () =>
    (asked ??= fetch("/api/library")
      .then((r) => (r.ok ? (r.json() as Promise<{ patterns?: SharedPattern[] }>) : null))
      .then((listed) => {
        if (!Array.isArray(listed?.patterns)) return;
        patterns = listed.patterns;
        for (const listener of listeners) listener();
      })
      .catch(() => {
        // Out of reach: the catalogue and the visitor's own patterns remain.
      })
      .finally(() => {
        asked = null;
      }));
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read: () => patterns,
    load,
  };
})();

/** The drawing of a pattern of the shared library; throws, with a message for the user, when it cannot be had. */
export async function fetchShared(id: string): Promise<SharedDrawing & { name: string; note: string }> {
  const response = await fetch(`/api/library/${encodeURIComponent(id)}`).catch(() => null);
  const drawing = (await response?.json().catch(() => null)) as (SharedDrawing & { name: string; note: string; error?: string }) | null;
  if (!response?.ok || !drawing?.free) throw new Error(drawing?.error ?? "La bibliothèque commune n'a pas répondu. Réessayez dans un instant.");
  return drawing;
}

/** The patterns of the shared library, the latest first, and how to list them again (after one was added). */
export function useSharedLibrary() {
  const patterns = useSyncExternalStore(store.subscribe, store.read, () => NONE);
  useEffect(() => void store.load(), []);
  return { patterns, refresh: store.load };
}
