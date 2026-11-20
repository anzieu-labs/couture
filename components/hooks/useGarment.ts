"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { TorsoFrame } from "@/lib/avatar/bodyMeasures";
import type { BodyMeasurement } from "@/lib/avatar/measure";
import { DEFAULT_TSHIRT, draftTShirt, type Pattern, type TShirtParams } from "@/lib/pattern/tshirt";
import type { Textile } from "@/lib/textiles/catalog";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

const DRESS_DELAY = 250;

/** Pattern drafted from the measured body, then sewn & draped with the textile's mechanics. */
export function useGarment(
  viewerRef: RefObject<GarmentViewer | null>,
  ready: boolean,
  measurements: BodyMeasurement | null,
  textile: Textile,
) {
  const [params, setParams] = useState<TShirtParams>(DEFAULT_TSHIRT);
  const [pattern, setPattern] = useState<Pattern | null>(null);
  const [autoLength, setAutoLength] = useState<number | null>(null);
  const [sewCount, setSewCount] = useState(0);
  const torso = useRef<TorsoFrame | null>(null);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !measurements) return;
    const inputs = viewer.patternInputs(measurements);
    if (!inputs) return;
    torso.current = inputs.torso;
    setAutoLength(inputs.measures.hpsToHip + 10);
    setPattern(draftTShirt(inputs.measures, params));
  }, [ready, measurements, params, viewerRef]);

  // Only the mechanical properties matter here: re-sew on textile changes, not colours.
  const { weight, bending, stretch, thickness, friction } = textile;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !pattern || !torso.current) return;
    const timer = setTimeout(() => {
      viewer.dress(pattern, torso.current!, {
        density: weight / 1000,
        bending,
        stretchWarp: stretch.warp,
        stretchWeft: stretch.weft,
        thickness: thickness / 1000,
        friction,
      });
    }, DRESS_DELAY);
    return () => clearTimeout(timer);
  }, [ready, pattern, weight, bending, stretch, thickness, friction, sewCount, viewerRef]);

  return { params, setParams, pattern, autoLength, resew: () => setSewCount((c) => c + 1) };
}
