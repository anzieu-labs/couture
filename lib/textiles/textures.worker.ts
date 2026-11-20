/// <reference lib="webworker" />
import type { Textile } from "./catalog";
import { generateTextileMaps, type TextileColors } from "./generate";

/** Procedural textile maps off the main thread (up to ~130 ms at 512²). */

export interface TextureRequest {
  id: number;
  textile: Textile;
  colors: TextileColors;
  size: number;
}

export interface TextureResponse {
  id: number;
  albedo: Uint8ClampedArray<ArrayBuffer>;
  normal: Uint8ClampedArray<ArrayBuffer>;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let pending: TextureRequest | null = null;

ctx.onmessage = (e: MessageEvent<TextureRequest>) => {
  // Coalesce bursts (e.g. dragging a colour picker): only the latest request runs.
  const idle = pending === null;
  pending = e.data;
  if (idle) setTimeout(process, 0);
};

function process() {
  const req = pending!;
  pending = null;
  const { albedo, normal } = generateTextileMaps(req.textile, req.colors, req.size);
  ctx.postMessage({ id: req.id, albedo, normal } satisfies TextureResponse, [albedo.buffer, normal.buffer]);
}
