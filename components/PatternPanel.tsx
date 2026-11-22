"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { download, exportDxf, exportPdf, exportSvg, type ExportOptions } from "@/lib/pattern/export";
import { cutPieces } from "@/lib/pattern/markings";
import { layoutRow, pieceBlock, type Prim } from "@/lib/pattern/sheet";
import { CUT_LABELS, type GarmentDef, type GarmentParams } from "@/lib/pattern/garments";
import type { DxfImport, DxfUnits } from "@/lib/pattern/import/dxf";
import type { BodyMeasures, Pattern } from "@/lib/pattern/types";
import { GarmentPicker } from "./GarmentPicker";
import { RangeField } from "./RangeField";
import { seamColor, seamLegend } from "./seamColors";
import { Section } from "./Section";

interface Props {
  pattern: Pattern | null;
  garment: GarmentDef;
  onGarment: (id: string) => void;
  /** A pattern of the user's own is started (from simple shapes, or as a copy of the garment worn) and worn. */
  onDraw: (source: "simple" | "copy") => void;
  /** A pattern of the user's own is read from a DXF file and worn; throws when it cannot be read. */
  onImport: (text: string, units: DxfUnits) => DxfImport;
  /** There is a drawing already; the garment worn can be copied into one. */
  hasDrawing: boolean;
  canCopy: boolean;
  params: GarmentParams;
  onParams: (p: GarmentParams) => void;
  measures: BodyMeasures | null;
  progress: number;
  cutting: ExportOptions;
  onCutting: (o: ExportOptions) => void;
  editorOpen: boolean;
  onEditor: (open: boolean) => void;
  /** Number of edited points. */
  editCount: number;
  onResetEdits: () => void;
  /** Problems of the edited pattern (it cannot be sewn or exported). */
  issues: string[];
}

const pts = (p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

function PreviewPrim({ p }: { p: Prim }) {
  if (p.kind === "text") return null;
  const d = `M${pts(p.pts).replaceAll(" ", "L")}${p.closed || p.fill ? "Z" : ""}`;
  switch (p.role) {
    case "cut":
      return <path d={d} fill="white" stroke="var(--color-ink)" strokeWidth={0.3} strokeLinejoin="round" />;
    case "seam": {
      const c = seamColor(p.seam);
      return c ? (
        <path d={d} fill="none" stroke={c} strokeWidth={0.8} strokeLinecap="round" />
      ) : (
        <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.3} strokeDasharray="1 0.7" />
      );
    }
    case "notch":
      return <path d={d} stroke="var(--color-ink)" strokeWidth={0.4} />;
    case "fold":
      return <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.35} strokeDasharray="2.4 0.8 0.4 0.8" />;
    case "grain":
      return p.fill ? <path d={d} fill="var(--color-muted)" /> : <path d={d} fill="none" stroke="var(--color-muted)" strokeWidth={0.3} />;
    default:
      return null;
  }
}

/** Cut pieces side by side: cutting line, stitching line coloured by seam, notches, grain / fold. */
function PatternSvg({ pattern, cutting }: { pattern: Pattern; cutting: ExportOptions }) {
  const sheet = useMemo(() => {
    const pieces = cutPieces(pattern, cutting.allowances, { fold: cutting.fold });
    return { pieces, ...layoutRow(pieces.map((p) => pieceBlock(p, "preview")), 6) };
  }, [pattern, cutting]);
  const { width, height, prims, slots, pieces } = sheet;
  return (
    <svg viewBox={`-3 -3 ${width + 6} ${height + 12}`} className="w-full" role="img" aria-label={`Patron : ${pattern.name}`}>
      {prims.map((p, i) => (
        <PreviewPrim key={i} p={p} />
      ))}
      {pieces.map((piece, i) => (
        <text key={piece.id} x={slots[i].x + slots[i].w / 2} y={height + 7} textAnchor="middle" fontSize={3.4} fill="var(--color-ink)">
          {piece.name}
          {piece.quantity > 1 ? ` ×${piece.quantity}` : ""}
          {piece.onFold ? " (pli)" : ""}
        </text>
      ))}
    </svg>
  );
}

/** File name from the pattern name: "Cape à capuche" → "cape-a-capuche". */
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const EXPORTS = [
  { id: "pdf", label: "PDF A4", title: "PDF à l'échelle 1, tuilé sur pages A4 à assembler", run: exportPdf, ext: "pdf" },
  { id: "svg", label: "SVG 1:1", title: "Planche unique à l'échelle 1 (traceur, découpe)", run: exportSvg, ext: "svg" },
  { id: "dxf", label: "DXF AAMA", title: "DXF AAMA / ASTM, pièces entières (CLO, Gerber, Optitex…)", run: exportDxf, ext: "dxf" },
] as const;

function ExportSection({ pattern, cutting, onCutting }: { pattern: Pattern | null; cutting: ExportOptions; onCutting: (o: ExportOptions) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const al = cutting.allowances;
  const run = (e: (typeof EXPORTS)[number]) => {
    if (!pattern) return;
    setBusy(e.id);
    // Let the button repaint before the (synchronous) layout search.
    setTimeout(() => {
      try {
        download(e.run(pattern, cutting, pattern.sizeNote), `${slug(pattern.name)}.${e.ext}`);
      } finally {
        setBusy(null);
      }
    }, 0);
  };
  return (
    <Section title="Marges et export">
      <div className="space-y-4">
        <RangeField
          label="Marges de couture"
          min={0}
          max={2}
          step={0.1}
          value={al.seam}
          display={`${al.seam.toLocaleString("fr-FR")} cm`}
          onChange={(v) => onCutting({ ...cutting, allowances: { ...al, seam: v } })}
        />
        <RangeField
          label="Ourlets (bas et manches)"
          min={0}
          max={5}
          step={0.5}
          value={al.hem}
          display={`${al.hem.toLocaleString("fr-FR")} cm`}
          onChange={(v) => onCutting({ ...cutting, allowances: { ...al, hem: v } })}
        />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={cutting.fold} onChange={(e) => onCutting({ ...cutting, fold: e.target.checked })} className="accent-ink" />
          <span className="font-medium">Pièces symétriques au pli</span>
          <span className="text-muted">(demi-pièces)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {EXPORTS.map((e) => (
            <button
              key={e.id}
              type="button"
              title={e.title}
              disabled={!pattern || busy !== null}
              onClick={() => run(e)}
              className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium transition-colors hover:border-ink disabled:opacity-50"
            >
              {busy === e.id ? "…" : e.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Les crans se font face d&apos;une pièce à l&apos;autre (doubles côté dos). Le DXF contient toujours les pièces entières.
        </p>
      </div>
    </Section>
  );
}

export function PatternPanel({
  pattern, garment, onGarment, onDraw, onImport, hasDrawing, canCopy, params, onParams, measures, progress, cutting, onCutting, editorOpen, onEditor, editCount, onResetEdits, issues,
}: Props) {
  const simulating = progress > 0 && progress < 1;
  const [picking, setPicking] = useState(false);
  // What the last DXF import read, told under the garment until dismissed or until another garment is worn.
  const [imported, setImported] = useState<{ read: DxfImport; garment: string } | null>(null);
  const read = imported?.garment === garment.id ? imported.read : null;
  // Pieces to cut, as printed (a piece listed twice for the simulation is one piece cut ×2).
  const pieceCount = pattern ? new Set(pattern.pieces.map((p) => p.name)).size : 0;
  return (
    <>
      <Section title="Vêtement">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-white/60 p-2 pr-3">
          {garment.image ? (
            <Image src={garment.image} alt="" width={48} height={64} className="h-16 w-12 shrink-0 rounded-lg bg-canvas object-cover" />
          ) : (
            <span className="grid h-16 w-12 shrink-0 place-items-center rounded-lg bg-canvas text-muted" aria-hidden>
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                <path d="M5 20 4 9l4-5h8l4 5-1 11z" />
                <circle cx="8" cy="4" r="1.2" fill="currentColor" />
                <circle cx="16" cy="4" r="1.2" fill="currentColor" />
              </svg>
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {garment.name} {garment.image && <span className="font-normal text-muted">· {CUT_LABELS[garment.cut].toLowerCase()}</span>}
            </p>
            <p className="truncate text-[11px] text-muted">{garment.description}</p>
          </div>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="shrink-0 rounded-full border border-ink px-3 py-1.5 text-xs font-medium transition-colors hover:bg-ink hover:text-white"
          >
            Changer
          </button>
        </div>
        <GarmentPicker
          open={picking}
          current={garment.id}
          onSelect={(kind) => {
            onGarment(kind);
            setPicking(false);
          }}
          onDraw={(source) => {
            onDraw(source);
            setPicking(false);
            setImported(null);
          }}
          onImport={(text, units) => {
            setImported({ read: onImport(text, units), garment: "free" });
            setPicking(false);
          }}
          hasDrawing={hasDrawing}
          canCopy={canCopy}
          onClose={() => setPicking(false)}
        />
      </Section>

      {read && (
        <div className="rounded-lg border border-line bg-white/70 p-3 text-[11px] leading-relaxed" role="status">
          <p className="flex items-start justify-between gap-2 font-semibold">
            <span>
              DXF importé : {read.pieces.length} pièce{read.pieces.length > 1 ? "s" : ""}
            </span>
            <button type="button" onClick={() => setImported(null)} aria-label="Fermer" className="-mt-0.5 text-muted hover:text-ink">
              ×
            </button>
          </p>
          <p className="mt-1 text-muted">
            Lu en {{ mm: "millimètres", cm: "centimètres", in: "pouces" }[read.units]}
            {read.guessed ? " (unité devinée d'après les tailles)" : ""}, sur {{ sew: "la ligne de couture", cut: "la ligne de coupe (marges comprises, s'il y en a)", other: "le plus grand contour fermé" }[read.line]} :{" "}
            {read.pieces.map((p) => `${p.name} ${p.width.toFixed(0)} × ${p.height.toFixed(0)} cm`).join(", ")}.
          </p>
          <p className="mt-1">
            Un DXF ne dit ni les coutures ni où se porte chaque pièce : dans l&apos;éditeur 2D, vérifiez la zone et la hauteur de chaque pièce (liste « Pièces »), puis cousez les bords avec
            l&apos;outil « Couture ».
          </p>
        </div>
      )}

      <Section title="Patron" aside={pattern ? `${pieceCount} pièces` : undefined}>
        <div className="rounded-lg border border-line bg-white/60 p-3">
          {pattern ? <PatternSvg pattern={pattern} cutting={cutting} /> : <p className="text-xs text-muted">Calcul…</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            {pattern && seamLegend(pattern).map((l) => <Legend key={l.label} color={l.color} label={l.label} />)}
            <Legend color="var(--color-ink)" label="Coupe (marges incluses)" thin />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => onEditor(!editorOpen)}
            aria-pressed={editorOpen}
            className="rounded-full border border-ink px-3 py-1.5 text-xs font-medium transition-colors hover:bg-ink hover:text-white aria-pressed:bg-ink aria-pressed:text-white"
          >
            {editorOpen ? "Fermer l'éditeur 2D" : "Éditer le patron en 2D"}
          </button>
          {editCount > 0 && (
            <span className="text-[11px] text-muted">
              {editCount} point{editCount > 1 ? "s" : ""} modifié{editCount > 1 ? "s" : ""} ·{" "}
              <button type="button" onClick={onResetEdits} className="underline underline-offset-2 hover:text-ink">
                rétablir le tracé
              </button>
            </span>
          )}
        </div>
        {issues.length > 0 && (
          <p className="mt-2 text-[11px] text-[#b2442f]" role="alert">
            {issues[0]} La 3D garde la dernière version valide ; exports suspendus.
          </p>
        )}
      </Section>

      {pattern && (
        <Section title="Cotes">
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center text-xs">
            {pattern.dims.map(({ label, value }) => (
              <div key={label} className="bg-panel px-1 py-2">
                <dt className="text-[10px] text-muted">{label}</dt>
                <dd className="font-semibold tabular-nums">{value.toFixed(1)} cm</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="Coupe">
        <div className="space-y-4">
          {garment.params.map((s) => {
            const v = params[s.key] ?? garment.defaults[s.key];
            const unit = s.unit ?? "cm";
            // Automatic settings (value 0): shown at the value worked out from the body.
            const auto = s.auto && v <= 0 ? (measures ? s.auto(measures) : null) : null;
            return (
              <RangeField
                key={s.key}
                label={s.label}
                min={s.min}
                max={s.max}
                step={s.step}
                value={auto ?? (v > 0 || !s.auto ? v : s.min)}
                display={s.auto && v <= 0 ? `auto · ${auto?.toFixed(0) ?? "—"} ${unit}` : s.maxLabel && v >= s.max ? s.maxLabel : `${v} ${unit}`}
                ends={s.ends}
                onChange={(x) => onParams({ ...params, [s.key]: x })}
                onDoubleClick={s.auto ? () => onParams({ ...params, [s.key]: 0 }) : undefined}
              />
            );
          })}
        </div>
      </Section>

      <ExportSection pattern={issues.length ? null : pattern} cutting={cutting} onCutting={onCutting} />

      {/* The garment is sewn again by itself whenever the pattern, the body or the fabric changes. */}
      <p className="text-[11px] text-muted">{simulating ? `Couture et drapé… ${Math.round(progress * 100)} %` : "Le patron suit la morphologie du mannequin."}</p>
    </>
  );
}

function Legend({ color, label, thin }: { color: string; label: string; thin?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`${thin ? "h-px" : "h-0.5"} w-3 rounded`} style={{ background: color }} />
      {label}
    </span>
  );
}
