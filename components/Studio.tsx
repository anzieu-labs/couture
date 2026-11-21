"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FEMALE, MALE } from "@/lib/avatar/morphology";
import { CADENCE, DEFAULT_ARM_SPREAD } from "@/lib/avatar/motion";
import type { ExportOptions } from "@/lib/pattern/export";
import { DEFAULT_ALLOWANCES } from "@/lib/pattern/markings";
import { TEXTILES, type Textile } from "@/lib/textiles/catalog";
import type { TextileColors } from "@/lib/textiles/generate";
import type { FitMode } from "@/lib/viewer/fitMap";
import type { ViewPreset } from "@/lib/viewer/GarmentViewer";
import { FitLegend } from "./FitLegend";
import { useGarment } from "./hooks/useGarment";
import { useMorphology } from "./hooks/useMorphology";
import { useViewer } from "./hooks/useViewer";
import { MorphologyPanel } from "./MorphologyPanel";
import { PatternEditor } from "./PatternEditor";
import { PatternPanel } from "./PatternPanel";
import { PosePanel } from "./PosePanel";
import { TextilePanel } from "./TextilePanel";

type Tab = "morpho" | "pose" | "patron" | "tissu";

const TABS: [Tab, string][] = [
  ["morpho", "Morphologie"],
  ["pose", "Pose"],
  ["patron", "Patron"],
  ["tissu", "Tissu"],
];

const VIEW_LABELS: { id: ViewPreset; label: string }[] = [
  { id: "face", label: "Face" },
  { id: "profil", label: "Profil" },
  { id: "dos", label: "Dos" },
  { id: "buste", label: "Buste" },
];

const PRESETS = { Homme: MALE, Femme: FEMALE };

const DISPLAY_MODES: { id: FitMode | null; label: string; title: string }[] = [
  { id: null, label: "Tissu", title: "Rendu du tissu" },
  { id: "tension", label: "Tension", title: "Carte de tension (N/m) : où le vêtement serre" },
  { id: "stretch", label: "Étirement", title: "Carte d'étirement (%) du tissu" },
];

const defaultColors = (t: Textile): TextileColors => ({ primary: t.defaultColor, secondary: t.secondary?.default });

export default function Studio() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { viewerRef, status, backend, simProgress, simBackend } = useViewer(viewportRef);
  const ready = status === "ready";

  const [tab, setTab] = useState<Tab>("morpho");
  const [view, setView] = useState<ViewPreset>("face");
  const [autoRotate, setAutoRotate] = useState(false);
  const [walking, setWalking] = useState(false);
  const [cadence, setCadence] = useState(CADENCE.default);
  const [armSpread, setArmSpread] = useState<number | null>(DEFAULT_ARM_SPREAD);
  const [fitMode, setFitMode] = useState<FitMode | null>(null);
  const [cutting, setCutting] = useState<ExportOptions>({ allowances: DEFAULT_ALLOWANCES, fold: true });
  const [editorOpen, setEditorOpen] = useState(false);
  const closeEditor = useCallback(() => setEditorOpen(false), []);

  // Fabric
  const [textileId, setTextileId] = useState(TEXTILES[0].id);
  const [colorsById, setColorsById] = useState<Record<string, TextileColors>>(() =>
    Object.fromEntries(TEXTILES.map((t) => [t.id, defaultColors(t)])),
  );
  const [scale, setScale] = useState(1);
  const textile = TEXTILES.find((t) => t.id === textileId)!;
  const colors = colorsById[textileId];

  const body = useMorphology(viewerRef, ready);
  const garment = useGarment(viewerRef, ready, body.measurements, textile);

  useEffect(() => {
    if (ready) viewerRef.current?.setFabric(textile, colors, scale);
  }, [ready, textile, colors, scale, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setAutoRotate(autoRotate);
  }, [ready, autoRotate, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setFitMap(fitMode);
  }, [ready, fitMode, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setWalking(walking);
  }, [ready, walking, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setCadence(cadence);
  }, [ready, cadence, viewerRef]);

  useEffect(() => {
    if (ready) viewerRef.current?.setArmSpread(armSpread);
  }, [ready, armSpread, viewerRef]);

  // Wrist handles: shown in the Pose tab only; which arms are placed by hand.
  const [handsPlaced, setHandsPlaced] = useState(false);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    viewer.onHandsChange = (placed) => setHandsPlaced(placed.L || placed.R);
    return () => {
      viewer.onHandsChange = undefined;
    };
  }, [ready, viewerRef]);
  useEffect(() => {
    if (ready) viewerRef.current?.setHandlesVisible(tab === "pose");
  }, [ready, tab, viewerRef]);

  const turn = () => {
    setWalking(false);
    viewerRef.current?.turn();
  };

  const goTo = (v: ViewPreset) => {
    setView(v);
    viewerRef.current?.goTo(v);
  };

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-canvas text-ink md:flex-row">
      {/* ------------------------------------------------------------ 3D */}
      <section className="relative flex h-[58dvh] shrink-0 md:h-full md:flex-1" aria-label="Aperçu 3D">
        {editorOpen && garment.measures && (
          // Desktop: beside the 3D view (which follows the edits live); mobile: over it.
          <div className="absolute inset-0 z-20 md:static md:z-auto md:w-1/2 md:shrink-0 md:border-r md:border-line">
            <PatternEditor
              key={garment.kind}
              garment={garment.garment}
              measures={garment.measures}
              params={garment.params}
              edits={garment.edits}
              onCommit={garment.commit}
              onUndo={garment.undo}
              onRedo={garment.redo}
              canUndo={garment.canUndo}
              canRedo={garment.canRedo}
              allowances={cutting.allowances}
              onClose={closeEditor}
            />
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          <div ref={viewportRef} className="absolute inset-0" />

          <div className="absolute left-4 top-4 flex flex-col items-start gap-3 md:left-6 md:top-5">
            <div className="pointer-events-none flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink">Couture</span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted">Atelier 3D</span>
            </div>
            {simBackend && (
              <div className="flex items-center gap-1 rounded-full border border-line bg-white/80 p-1 shadow-sm backdrop-blur" role="group" aria-label="Affichage du vêtement">
                {DISPLAY_MODES.map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    title={m.title}
                    onClick={() => setFitMode(m.id)}
                    aria-pressed={fitMode === m.id}
                    className="rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {fitMode && <FitLegend mode={fitMode} />}
          </div>

          <div className="absolute right-4 top-4 flex flex-col items-end gap-1.5 md:right-6 md:top-5">
            {backend && (
              <span
                className="rounded-full border border-line bg-white/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur"
                title={backend === "WebGPU" ? "Rendu accéléré WebGPU" : "WebGPU indisponible : repli automatique sur WebGL 2"}
              >
                Rendu {backend}
              </span>
            )}
            {simBackend && (
              <span
                className="rounded-full border border-line bg-white/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur"
                title={
                  simBackend === "gpu"
                    ? "Tissu simulé sur la carte graphique (WebGPU compute)"
                    : "WebGPU indisponible pour le calcul : simulation sur le processeur"
                }
              >
                Simulation {simBackend.toUpperCase()}
              </span>
            )}
          </div>

          {!ready && (
            <div className="absolute inset-0 grid place-items-center">
              <p className="text-sm text-muted">
                {status === "loading" ? "Chargement du mannequin…" : "Impossible d'initialiser le rendu 3D sur ce navigateur."}
              </p>
            </div>
          )}

          <div className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-4 md:bottom-6">
            <div className="flex items-center gap-1 rounded-full border border-line bg-white/80 p-1 shadow-sm backdrop-blur">
              {VIEW_LABELS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => goTo(v.id)}
                  aria-pressed={view === v.id}
                  className="rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
                >
                  {v.label}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-line" aria-hidden />
              <button
                type="button"
                onClick={() => setAutoRotate((a) => !a)}
                aria-pressed={autoRotate}
                aria-label="Rotation automatique"
                title="Rotation automatique"
                className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
              >
                <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" strokeLinecap="round" />
                  <path d="M15 2.5v3.3h-3.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- Panel */}
      <aside className="flex min-h-0 flex-1 flex-col border-line bg-panel md:h-full md:w-[360px] md:flex-none md:border-l">
        <header className="border-b border-line px-5 pt-4 md:pt-5">
          <h1 className="text-lg font-semibold tracking-tight">Atelier</h1>
          <p className="text-xs text-muted">{garment.garment.name} · mannequin paramétrique</p>
          <div role="tablist" className="mt-3 flex gap-5">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className="-mb-px border-b-2 border-transparent pb-2.5 text-sm font-medium text-muted transition-colors hover:text-ink aria-selected:border-ink aria-selected:text-ink"
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5" role="tabpanel">
          {tab === "morpho" && (
            <MorphologyPanel
              value={body.morph}
              onChange={body.setMorph}
              measurements={body.measurements}
              presets={PRESETS}
              onPreset={body.reset}
              targets={body.targets}
              onTargets={body.setTargets}
              saturated={body.saturated}
              fitting={body.fitting}
            />
          )}
          {tab === "pose" && (
            <PosePanel
              armSpread={armSpread}
              // eslint-disable-next-line react-hooks/refs -- depends on the morphology, re-read on each render
              restArmSpread={viewerRef.current?.restArmSpread ?? 40}
              onArmSpread={(v) => {
                viewerRef.current?.releaseHands();
                setArmSpread(v);
              }}
              cadence={cadence}
              onCadence={setCadence}
              walking={walking}
              onWalking={setWalking}
              onTurn={turn}
              handsPlaced={handsPlaced}
              onReleaseHands={() => viewerRef.current?.releaseHands()}
            />
          )}
          {tab === "patron" && (
            <PatternPanel
              pattern={garment.pattern}
              params={garment.params}
              onParams={garment.setParams}
              garment={garment.garment}
              onGarment={garment.setKind}
              measures={garment.measures}
              progress={simProgress}
              onResew={garment.resew}
              cutting={cutting}
              onCutting={setCutting}
              editorOpen={editorOpen}
              onEditor={setEditorOpen}
              editCount={Object.keys(garment.edits).length}
              onResetEdits={() => garment.commit({})}
              issues={garment.issues.map((i) => i.message)}
            />
          )}
          {tab === "tissu" && (
            <TextilePanel
              textile={textile}
              onTextile={setTextileId}
              colorsById={colorsById}
              onColor={(key, hex) => setColorsById((prev) => ({ ...prev, [textileId]: { ...prev[textileId], [key]: hex } }))}
              scale={scale}
              onScale={setScale}
            />
          )}
        </div>

        <footer className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-muted">
          Corps : modèle Anny (NAVER LABS Europe, Apache 2.0) issu de MakeHuman (CC0).
        </footer>
      </aside>
    </main>
  );
}
