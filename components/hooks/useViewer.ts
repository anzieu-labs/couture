"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { GarmentViewer } from "@/lib/viewer/GarmentViewer";

export type ViewerStatus = "loading" | "ready" | "error";

/** Creates the 3D viewer in `container` (three.js is loaded on the client only). */
export function useViewer(container: RefObject<HTMLDivElement | null>) {
  const viewerRef = useRef<GarmentViewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [backend, setBackend] = useState("");
  const [simProgress, setSimProgress] = useState(0);
  const [simBackend, setSimBackend] = useState<"gpu" | "cpu" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let viewer: GarmentViewer | null = null;
    import("@/lib/viewer/GarmentViewer")
      .then(({ GarmentViewer }) => GarmentViewer.create(container.current!))
      .then((v) => {
        if (cancelled) return v.dispose();
        viewer = v;
        viewerRef.current = v;
        v.onSimProgress = setSimProgress;
        v.onSimBackend = setSimBackend;
        setBackend(v.backend);
        setStatus("ready");
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, [container]);

  return { viewerRef, status, backend, simProgress, simBackend };
}
