import { meshPattern } from "../../lib/pattern/mesh";
import type { Pattern } from "../../lib/pattern/types";
import { BodySdf } from "../../lib/sim/bodySdf";
import { CpuClothSolver } from "../../lib/sim/cloth";
import { buildClothModel, DEFAULT_CLOTH, floorAt, PLINTH, tensileModuli, type ClothModel, type ClothParams } from "../../lib/sim/model";
import { TEXTILES } from "../../lib/textiles/catalog";
import { VBD_DEFAULTS, VbdClothSolver, type VbdOptions } from "./vbd";

/**
 * Checks of the cloth solver against closed-form physics, on a bare strip of
 * fabric (no body, no seams):
 *
 *  - hanging strip: pinned along its top edge, a strip of length L stretches under
 *    its own weight by ρ g L² / (2 Y) (surface density ρ, tensile modulus Y along
 *    the strip). An XPBD solver that has not converged stretches much more — the
 *    excess grows with the number of mesh rows — so this isolates the solver's
 *    error from the fabric's real elasticity. The overshoot when the strip is let
 *    go from its unstretched state tells whether the solver rings;
 *  - cantilever: how far a strip held by one end bends, against the solver's converged answer;
 *  - fall: a piece of fabric dropped on the floor comes to rest on it, without going through.
 *
 *   npm run bench:physics
 *   npm run bench:physics -- --vbd     the same checks on a Vertex Block Descent prototype (vbd.ts), against XPBD
 */

const FRAME_DT = 1 / 60;

function strip(width: number, length: number, spacing: number) {
  const w = width * 100, l = length * 100;
  // One rectangular piece, top edge on y = 0, warp (pattern y) along the length.
  const piece = {
    id: "strip",
    edges: [
      { id: "top", pts: [[w / 2, 0], [-w / 2, 0]], allowance: "none" },
      { id: "left", pts: [[-w / 2, 0], [-w / 2, -l]], allowance: "none" },
      { id: "bottom", pts: [[-w / 2, -l], [w / 2, -l]], allowance: "none" },
      { id: "right", pts: [[w / 2, -l], [w / 2, 0]], allowance: "none" },
    ],
  };
  const mesh = meshPattern({ kind: "tshirt", pieces: [piece], seams: [] } as unknown as Pattern, spacing);
  const n = mesh.rest.length / 2;
  const initial = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) initial.set([mesh.rest[2 * i], mesh.rest[2 * i + 1], 0], 3 * i);
  return { mesh, initial };
}

/** A collision field with nothing in it. */
const emptyField = () => new BodySdf(new Float32Array(0), new Float32Array(0), [10, 10, 10], [10.02, 10.02, 10.02]);

/** What a check needs of a solver, and how to make one for a model. */
interface Solver {
  pos: Float32Array | Float64Array;
  step(dt: number): void;
  /**
   * Passes a substep takes on a GPU, each solving one colour in parallel: what the solver costs
   * there (the CPU times of this bench count the arithmetic instead).
   */
  passes: number;
}
type Make = (model: ClothModel, initial: Float32Array) => Solver;
const xpbd: Make = (model, initial) => {
  const solver = new CpuClothSolver(model, initial, emptyField());
  const p = model.params;
  return { pos: solver.pos, step: (dt) => solver.step(dt), passes: p.stretchSweeps * model.edgeColors.length + p.bendSweeps * model.bendColors.length };
};
const vbd = (opts: Partial<VbdOptions>): Make => (model, initial) => {
  const solver = new VbdClothSolver(model, initial, opts);
  return { pos: solver.pos, step: (dt) => solver.step(dt), passes: (opts.iterations ?? VBD_DEFAULTS.iterations) * solver.colours };
};

interface Hang {
  /** Elongation of the strip once still (% of its length), and the closed-form value. */
  elongation: number;
  expected: number;
  /** Largest elongation on the way (%): above the final one, the strip bounced. */
  peak: number;
  /** Largest vertex speed over the last half second (mm/s). */
  jitter: number;
  ms: number;
  /** GPU passes per simulated frame (Solver.passes × substeps). */
  passes: number;
}

function hang(textileId: string, substeps: number, spacing: number, length = 0.6, seconds = 4, overrides: Partial<ClothParams> = {}, make = xpbd): Hang {
  const textile = TEXTILES.find((t) => t.id === textileId)!;
  const params: ClothParams = {
    ...DEFAULT_CLOTH,
    density: textile.weight / 1000,
    bending: textile.bending,
    stretchWarp: textile.stretch.warp,
    stretchWeft: textile.stretch.weft,
    thickness: textile.thickness / 1000,
    substeps,
    sewTime: 0,
    selfInterval: 0,
    ...overrides,
  };
  const { mesh, initial } = strip(0.12, length, spacing);
  const model = buildClothModel(mesh, initial, params);
  const bottom: number[] = [];
  for (let i = 0; i < model.vertexCount; i++) {
    if (mesh.rest[2 * i + 1] > -1e-6) model.invMass[i] = 0; // pinned
    if (mesh.rest[2 * i + 1] < -length + 1e-6) bottom.push(i);
  }
  const solver = make(model, initial);
  const elongation = () => (100 * (-bottom.reduce((s, v) => s + solver.pos[3 * v + 1], 0) / bottom.length - length)) / length;
  const frames = Math.round(seconds / FRAME_DT);
  const last = new Float32Array(solver.pos.length);
  let peak = 0, jitter = 0;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    last.set(solver.pos);
    solver.step(FRAME_DT);
    peak = Math.max(peak, elongation());
    if (f >= frames - 30)
      for (let i = 0; i < last.length; i += 3)
        jitter = Math.max(jitter, (1000 * Math.hypot(solver.pos[i] - last[i], solver.pos[i + 1] - last[i + 1], solver.pos[i + 2] - last[i + 2])) / FRAME_DT);
  }
  const expected = (100 * (params.density * 9.81 * length * length)) / (2 * tensileModuli(params).warp) / length;
  return { elongation: elongation(), expected, peak, jitter, ms: (performance.now() - t0) / frames, passes: solver.passes * substeps };
}

/**
 * Cantilever: a strip held horizontally by one end bends under its own weight. Returns how
 * far its tip comes down (cm) — against the same run with 8× the substeps (the solver's
 * converged answer), a solver that under-solves bending droops more.
 */
function droop(textileId: string, substeps: number, length: number, overrides: Partial<ClothParams> = {}, make = xpbd): number {
  const textile = TEXTILES.find((t) => t.id === textileId)!;
  const params: ClothParams = {
    ...DEFAULT_CLOTH,
    density: textile.weight / 1000,
    bending: textile.bending,
    stretchWarp: textile.stretch.warp,
    stretchWeft: textile.stretch.weft,
    thickness: textile.thickness / 1000,
    substeps,
    sewTime: 0,
    selfInterval: 0,
    damping: 4,
    ...overrides,
  };
  const { mesh, initial } = strip(0.08, length + 0.03, 1);
  // Horizontal, the first 3 cm clamped.
  for (let i = 0; i < initial.length / 3; i++) initial.set([mesh.rest[2 * i], 0, -mesh.rest[2 * i + 1]], 3 * i);
  const model = buildClothModel(mesh, initial, params);
  const tip: number[] = [];
  for (let i = 0; i < model.vertexCount; i++) {
    if (mesh.rest[2 * i + 1] > -0.03) model.invMass[i] = 0;
    if (mesh.rest[2 * i + 1] < -(length + 0.03) + 1e-6) tip.push(i);
  }
  const solver = make(model, initial);
  for (let f = 0; f < 6 / FRAME_DT; f++) solver.step(FRAME_DT);
  return (-100 * tip.reduce((s, v) => s + solver.pos[3 * v + 1], 0)) / tip.length;
}

/**
 * Fall: a square of fabric dropped flat from 30 cm, half of it over the edge of the plinth.
 * It must come to rest on the floor — the top of the plinth, the ground 4 cm lower beyond its
 * radius — and never go through. Returns the lowest height above the ground reached during
 * the fall, the height of the highest vertex at the end (cm) and the largest speed left (mm/s).
 */
function fall(textileId: string, substeps: number, overrides: Partial<ClothParams> = {}, make = xpbd) {
  const textile = TEXTILES.find((t) => t.id === textileId)!;
  const params: ClothParams = {
    ...DEFAULT_CLOTH,
    density: textile.weight / 1000,
    bending: textile.bending,
    stretchWarp: textile.stretch.warp,
    stretchWeft: textile.stretch.weft,
    thickness: textile.thickness / 1000,
    friction: textile.friction,
    substeps,
    sewTime: 0,
    selfInterval: 0,
    floorY: 0,
    ...overrides,
  };
  const { mesh, initial } = strip(0.3, 0.3, 1.5);
  // Flat, 30 cm above the floor, centred on the edge of the plinth.
  for (let i = 0; i < initial.length / 3; i++) initial.set([mesh.rest[2 * i] + PLINTH.radius, 0.3, mesh.rest[2 * i + 1] + 0.15], 3 * i);
  const solver = make(buildClothModel(mesh, initial, params), initial);
  const last = new Float32Array(solver.pos.length);
  let lowest = Infinity;
  const t0 = performance.now();
  for (let f = 0; f < 4 / FRAME_DT; f++) {
    last.set(solver.pos);
    solver.step(FRAME_DT);
    for (let i = 0; i < last.length; i += 3) lowest = Math.min(lowest, solver.pos[i + 1] - floorAt(0, solver.pos[i], solver.pos[i + 2]));
  }
  let highest = -Infinity, speed = 0;
  for (let i = 0; i < last.length; i += 3) {
    highest = Math.max(highest, solver.pos[i + 1]);
    speed = Math.max(speed, Math.hypot(solver.pos[i] - last[i], solver.pos[i + 1] - last[i + 1], solver.pos[i + 2] - last[i + 2]) / FRAME_DT);
  }
  return { lowest: 100 * lowest, highest: 100 * highest, speed: 1000 * speed, halfThickness: 50 * params.thickness, ms: ((performance.now() - t0) * FRAME_DT) / 4 };
}

const args = process.argv.slice(2);
/** Solver overrides, e.g. '{"stretchSweeps":2,"bendSweeps":2}'. */
const overrides: Partial<ClothParams> = JSON.parse(args.find((a) => a.startsWith("{")) ?? "{}");

function checkXpbd() {
  console.log("Hanging strip, 60 cm, pinned at the top: elongation under its own weight (% of the length)\n");
  console.log("textile  spacing  substeps   measured   closed form   peak     jitter mm/s   ms/frame");
  for (const textile of ["denim", "jersey"])
    for (const [spacing, substeps] of [[1.5, 10], [1, 20], [1, 40]] as const) {
      const r = hang(textile, substeps, spacing, 0.6, 4, overrides);
      console.log(
        `${textile.padEnd(8)} ${spacing.toFixed(1).padStart(4)} cm ${String(substeps).padStart(8)} ${r.elongation.toFixed(3).padStart(10)} ${r.expected.toFixed(3).padStart(12)} ${r.peak.toFixed(3).padStart(8)} ${r.jitter.toFixed(2).padStart(11)} ${r.ms.toFixed(1).padStart(10)}`,
      );
    }

  console.log("\nCantilever, 12 cm past the clamp: how far the tip comes down (cm)\n");
  console.log("textile  substeps   measured   converged (8x substeps)");
  for (const textile of ["denim", "wool", "linen"])
    for (const substeps of [10, 20]) {
      const measured = droop(textile, substeps, 0.12, overrides);
      const converged = droop(textile, 8 * substeps, 0.12, overrides);
      console.log(`${textile.padEnd(8)} ${String(substeps).padStart(8)} ${measured.toFixed(2).padStart(10)} ${converged.toFixed(2).padStart(11)}`);
    }

  console.log("\nFall onto the floor from 30 cm, half over the plinth's edge (cm above the ground; half thickness = resting height)\n");
  console.log("textile  substeps   lowest ever   half thickness   highest at the end   speed left mm/s");
  for (const textile of ["denim", "jersey"])
    for (const substeps of [10, 20]) {
      const r = fall(textile, substeps, overrides);
      console.log(`${textile.padEnd(8)} ${String(substeps).padStart(8)} ${r.lowest.toFixed(3).padStart(13)} ${r.halfThickness.toFixed(3).padStart(16)} ${r.highest.toFixed(2).padStart(20)} ${r.speed.toFixed(1).padStart(17)}`);
    }
}

/**
 * The same checks on the Vertex Block Descent prototype (vbd.ts), next to the XPBD solver as
 * the application runs it (CPU fallback: 10 substeps; GPU: 20). Both minimise the same
 * energies: what differs is how close a given budget gets to the answer. The budgets are
 * told two ways — milliseconds on this CPU (the arithmetic), and passes per frame on a GPU
 * (each pass solves one colour in parallel: what it costs there).
 */
function checkVbd() {
  /** Solver, substeps, VBD iterations per substep, Chebyshev radius, start of the iterations (vbd.ts). */
  type Config = { name: string; substeps: number; make: Make };
  const x = (substeps: number): Config => ({ name: `XPBD ${substeps} × (4 + 1)`, substeps, make: xpbd });
  const v = (substeps: number, iterations: number, rho = 0, start: VbdOptions["start"] = "inertial"): Config => ({
    name: `VBD  ${substeps} × ${iterations}${rho ? `, ρ ${rho}` : ""}${start === "adaptive" ? ", adaptive" : ""}`,
    substeps,
    make: vbd({ iterations, rho, start }),
  });
  const configs = [
    x(10), x(20), x(40),
    v(1, 100), v(1, 100, 0.95), v(4, 25), v(4, 25, 0.95), v(10, 10, 0.8), v(20, 5), v(20, 5, 0.7), v(20, 10, 0.8), v(40, 2), v(40, 5, 0.6),
    v(1, 20, 0, "adaptive"), v(1, 100, 0, "adaptive"), v(1, 100, 0.95, "adaptive"), v(20, 5, 0, "adaptive"), v(40, 2, 0, "adaptive"),
  ];

  console.log("Hanging strip, 60 cm, 1 cm mesh, pinned at the top: elongation under its own weight (% of the length)\n");
  console.log("textile  solver (substeps × sweeps)        measured   closed form   peak     jitter mm/s   ms/frame   GPU passes/frame");
  for (const textile of ["denim", "jersey"]) {
    for (const c of configs) {
      const r = hang(textile, c.substeps, 1, 0.6, 4, overrides, c.make);
      console.log(
        `${textile.padEnd(8)} ${c.name.padEnd(31)} ${r.elongation.toFixed(3).padStart(10)} ${r.expected.toFixed(3).padStart(12)} ${r.peak.toFixed(3).padStart(8)} ${r.jitter.toFixed(2).padStart(11)} ${r.ms.toFixed(1).padStart(10)} ${String(r.passes).padStart(12)}`,
      );
    }
    console.log();
  }

  const few = [x(10), x(20), v(1, 100, 0.95), v(4, 25, 0.95), v(20, 5), v(20, 5, 0.7), v(40, 2), v(1, 100, 0.95, "adaptive")];
  console.log("Cantilever, 12 cm past the clamp: how far the tip comes down (cm); converged: XPBD with 160 substeps, VBD with 20 × 50\n");
  console.log("textile  solver (substeps × sweeps)        measured");
  for (const textile of ["denim", "wool", "linen"]) {
    for (const c of [...few, { ...x(160), name: "XPBD converged" }, { ...v(20, 50), name: "VBD  converged" }])
      console.log(`${textile.padEnd(8)} ${c.name.padEnd(31)} ${droop(textile, c.substeps, 0.12, overrides, c.make).toFixed(2).padStart(10)}`);
    console.log();
  }

  console.log("Fall onto the floor from 30 cm, half over the plinth's edge (cm above the ground; half thickness = resting height)\n");
  console.log("textile  solver (substeps × sweeps)        lowest ever   half thickness   highest at the end   speed left mm/s   ms/frame");
  for (const textile of ["denim", "jersey"]) {
    for (const c of few) {
      const r = fall(textile, c.substeps, overrides, c.make);
      console.log(
        `${textile.padEnd(8)} ${c.name.padEnd(31)} ${r.lowest.toFixed(3).padStart(13)} ${r.halfThickness.toFixed(3).padStart(16)} ${r.highest.toFixed(2).padStart(20)} ${r.speed.toFixed(1).padStart(17)} ${r.ms.toFixed(1).padStart(10)}`,
      );
    }
    console.log();
  }
}

if (args.includes("--vbd")) checkVbd();
else checkXpbd();
