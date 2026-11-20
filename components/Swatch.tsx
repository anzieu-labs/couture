"use client";

import { useEffect, useRef } from "react";
import type { Textile } from "@/lib/textiles/catalog";
import { generateTextileMaps, type TextileColors } from "@/lib/textiles/generate";

const SIZE = 128;

/** Small preview of a textile, rendered from the same generator as the 3D maps. */
export function Swatch({ textile, colors, className }: { textile: Textile; colors: TextileColors; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { primary, secondary } = colors;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const maps = generateTextileMaps(textile, { primary, secondary }, SIZE);
    canvas.getContext("2d")!.putImageData(new ImageData(maps.albedo, SIZE, SIZE), 0, 0);
  }, [textile, primary, secondary]);

  return <canvas ref={ref} width={SIZE} height={SIZE} className={className} aria-hidden />;
}
