import { measureForPattern, type TorsoFrame } from "../../lib/avatar/bodyMeasures";
import { measureBody } from "../../lib/avatar/measure";
import { Animator, CADENCE, MOTION_DELAY, standingBody, type Posture } from "../../lib/avatar/motion";
import { BONE_STRIDE, Skeleton, skinVertices } from "../../lib/avatar/skeleton";
import { prepareGarment } from "../../lib/garment/prepare";
import type { DressRequest } from "../../lib/garment/protocol";
import { garmentDef } from "../../lib/pattern/garments";
import { withBelts } from "../../lib/pattern/belt";
import { NO_EDITS, type Belt, type BodyMeasures, type Clasp } from "../../lib/pattern/types";
import { BodySdf } from "../../lib/sim/bodySdf";
import { CpuClothSolver } from "../../lib/sim/cloth";
import { grabPoint, selectGrab } from "../../lib/sim/grab";
import { floorAt, RestDetector, SELF_DELAY, type ClothParams } from "../../lib/sim/model";
import { TEXTILES } from "../../lib/textiles/catalog";
import { loadMannequin, vertexNormals } from "./mannequin";
import { crossings, penetration, segmentsThrough, skinThrough, speed, strain, type Strain } from "./metrics";

const FRAME_DT = 1 / 60;
/** Frames timed at the end of a run: the drape at rest, or the motion under way. */
const TIMED_FRAMES = 120;

export interface Body {
  request: DressRequest["body"];
  measures: BodyMeasures;
  torso: TorsoFrame;
}

/**
 * The mannequin as the app builds it (GarmentViewer.setBody + dress): the default one, or with
 * some of its parameters changed (lib/avatar/anny.ts Phenotype, e.g. { weight: 0 }: thin).
 */
export function loadBody(root: string, phenotype: Record<string, number> = {}): Body {
  const anny = loadMannequin(root);
  const shape = anny.compute({ ...anny.defaults(), ...phenotype });
  const normals = vertexNormals(shape.positions, anny.indices);
  const { measures, torso } = measureForPattern(shape, anny.indices, measureBody(shape, anny.indices));
  const { labels, parents } = anny.meta.bones;
  return { request: { positions: shape.positions, normals, indices: anny.indices, joints: shape.joints, skin: anny.skin, rig: { labels, parents } }, measures, torso };
}

export interface Scenario {
  name: string;
  /** A garment of the catalogue (lib/pattern/garments.ts): its id, or its style — then in the men's cut. */
  garment: string;
  /** Textile id (lib/textiles/catalog.ts). */
  textile: string;
  /** Mesh and solver preset: the app's GPU settings (fine) or its CPU fallback's (coarse). */
  mode: "gpu" | "cpu";
  /** Simulated seconds. */
  duration: number;
  /** Starts once the garment is sewn and has settled, as in the app. */
  walk?: boolean;
  /** Steps per minute (default: a walk; a run above motion.ts RUN_CADENCE). */
  cadence?: number;
  /** The whole simulation even when the body runs: no motion mode (lib/sim/tether.ts), to compare. */
  untethered?: boolean;
  /** Held pose taken once the garment is sewn. */
  posture?: Posture;
  /** Solver parameter overrides. */
  cloth?: Partial<ClothParams>;
  /** Garment settings other than the defaults (lib/pattern/garments.ts), e.g. { flare: 20 }. */
  garmentParams?: Record<string, number>;
  /** Clasps on the pattern (lib/pattern/clasp.ts), instead of those the garment comes with; []: none. */
  clasps?: Clasp[];
  /** Belts on the pattern (lib/pattern/belt.ts), likewise; []: none — a skirt with no waistband. */
  belts?: Belt[];
  /** Mannequin parameters other than the defaults (loadBody), e.g. { weight: 0 }: a thin body. */
  phenotype?: Record<string, number>;
  /**
   * A hand takes hold of the cloth (lib/sim/grab.ts) at `at` s, at the front of the hem or
   * on the chest, pulls it by `pull` (m) in `ramp` s, holds it for `hold` s and lets go.
   */
  grab?: { where: "hem" | "chest"; at: number; pull: [number, number, number]; ramp: number; hold: number };
}

export interface Result {
  name: string;
  vertices: number;
  /** Wall-clock milliseconds per simulated frame (1/60 s), median over the last 2 s; and of each solver phase (mean). */
  msPerFrame: number;
  phases: Record<string, number>;
  /** Edge elongation (%) at the end, and the worst 99th percentile seen once sewn. */
  strain: Strain;
  strainP99Max: number;
  /** Self-intersections: at the end, mean and max over the samples once self-collisions are on. */
  crossings: { end: number; mean: number; max: number };
  /** Worst body penetration over the samples. */
  penetration: { count: number; depth: number; close: number };
  /**
   * Skin showing through the cloth (metrics.ts skinThrough): body vertices standing out of it at
   * the end, the most over the samples, and how far the worst one stood out (mm).
   */
  skinThrough: { end: number; max: number; depth: number };
  /** How far the top of the garment came down since it was sewn (cm): > a few cm, it slid off. */
  drop: number;
  /**
   * Limbs through the cloth: share of the samples (%) where a forearm, a hand, a shank or a foot
   * crosses a cloth triangle, and the mean number of triangles crossed. A limb under a garment
   * crosses none (it may come out by an opening).
   */
  limbsThrough: { samples: number; triangles: number };
  /** Lowest vertex above the ground under it, over the whole run (cm): negative, the cloth went through the floor. */
  aboveFloor: number;
  /** Vertex speed at the end (mm/s): what is left of the motion, or jitter at rest. */
  speedEnd: { mean: number; max: number };
  /** Simulated time at which the rest detector fired (s); null: never. */
  restAt: number | null;
  finite: boolean;
  /**
   * Scenario.grab: how far the held point followed the hand (cm, at the end of the hold: `moved`
   * of the `asked` pull), the worst strain while held (%), and how far the held point ends from
   * where it was taken once let go (cm).
   */
  grab?: { vertices: number; asked: number; moved: number; strainP99: number; strainMax: number; back: number };
}

/** Wraps the solver's phases with timers (private methods: this is a bench). */
function instrument(solver: CpuClothSolver): Record<string, number> {
  const time: Record<string, number> = {};
  const wrap = (target: Record<string, unknown>, method: string, label: string) => {
    const fn = target[method] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== "function") return;
    time[label] = 0;
    target[method] = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      const out = fn.apply(this, args);
      time[label] += performance.now() - t0;
      return out;
    };
  };
  const s = solver as unknown as Record<string, unknown>;
  wrap(s, "solveStretch", "stretch");
  wrap(s, "solveBending", "bending");
  wrap(s, "solveSeams", "seams");
  wrap(s, "solveContacts", "contacts");
  if (s.self) wrap(s.self as Record<string, unknown>, "solve", "self");
  return time;
}

export function runScenario(body: Body, sc: Scenario, log: (line: string) => void = () => {}): Result {
  const textile = TEXTILES.find((t) => t.id === sc.textile);
  if (!textile) throw new Error(`unknown textile ${sc.textile}`);
  const def = garmentDef(sc.garment);
  const pattern = withBelts({ ...def.draft(body.measures, { ...def.defaults, ...sc.garmentParams }, NO_EDITS), clasps: sc.clasps ?? def.clasps }, sc.belts ?? def.belts ?? []);
  const cloth: Partial<ClothParams> = {
    density: textile.weight / 1000,
    bending: textile.bending,
    stretchWarp: textile.stretch.warp,
    stretchWeft: textile.stretch.weft,
    thickness: textile.thickness / 1000,
    friction: textile.friction,
    ...sc.cloth,
  };
  const { initial, sdf, params, model } = prepareGarment({ mode: sc.mode, pattern, body: body.request, torso: body.torso, cloth });
  const b = body.request;
  const skeleton = new Skeleton(b.rig.labels, b.rig.parents, b.joints, b.positions, b.skin);
  const animator = new Animator(skeleton);
  // The body as shown: standing, then posed from there by the animator's bone transforms.
  const stand = standingBody(animator, b, b.skin);
  const motionStart = params.sewTime + params.settleTime + MOTION_DELAY;
  animator.holdUntil(motionStart);
  animator.setCadence(sc.cadence ?? CADENCE.default, 0);
  if (sc.posture) animator.setPosture(sc.posture, 0);
  if (sc.walk) animator.setWalking(true, 0);

  const solver = new CpuClothSolver(model, initial, sdf, skeleton.count);
  const phaseTime = instrument(solver);
  const poseAt = (t: number, out: Float32Array) => animator.sample(t, out);
  const bones = new Float32Array(skeleton.count * BONE_STRIDE);
  const posed = new Float32Array(b.positions.length), posedNormals = new Float32Array(b.normals.length);
  const clearance = params.skinGap + params.thickness / 2;

  /** Independent distance field of the body as posed at time t (the body as shown), around the garment. */
  const bodyField = (t: number, pos: Float32Array) => {
    const moved = animator.sample(t, bones);
    if (moved) skinVertices(stand.positions, stand.normals, b.skin, bones, posed, posedNormals);
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], pos[i + a] - 0.03);
        max[a] = Math.max(max[a], pos[i + a] + 0.03);
      }
    // Exact distances to the skin's triangles (BodySdf EXACT_BAND), on a finer grid than the solver's.
    return new BodySdf(moved ? posed : stand.positions, moved ? posedNormals : stand.normals, min, max, 0.008, 0.04, undefined, undefined, [], b.indices);
  };

  const frames = Math.round(sc.duration / FRAME_DT);
  const frameMs: number[] = [];
  const rest = new RestDetector();
  const last = Float32Array.from(solver.pos), before = Float32Array.from(solver.pos);
  let restAt: number | null = null, movedAt = -Infinity;
  let top: number[] | null = null, topY0 = 0;
  const topY = () => top!.reduce((s, v) => s + solver.pos[3 * v + 1], 0) / top!.length;
  const cross: number[] = [];
  let strainP99Max = 0;
  const pen = { count: 0, depth: 0, close: 0 };
  const skin = { end: 0, max: 0, depth: 0 };
  const halfThickness = Math.max(0.0005, params.thickness) / 2; // as rendered (viewer/shellTopology.ts)
  // Limb segments: joint to joint, and from the wrist / ankle to the farthest point of the hand / foot.
  const tip = (label: string) => {
    const k = skeleton.index[label], h = stand.joints[label];
    let best = -1, far = 0;
    for (let v = 0; v < stand.positions.length / 3; v++) {
      if (b.skin.index[4 * v] !== k || b.skin.weight[4 * v] < 128) continue;
      const d = Math.hypot(stand.positions[3 * v] - h[0], stand.positions[3 * v + 1] - h[1], stand.positions[3 * v + 2] - h[2]);
      if (d > far) [far, best] = [d, v];
    }
    return best;
  };
  const limbs = (["L", "R"] as const).flatMap((s) => [
    { from: `lowerarm01.${s}`, to: `wrist.${s}`, tip: tip(`wrist.${s}`) },
    { from: `lowerleg01.${s}`, to: `foot.${s}`, tip: tip(`foot.${s}`) },
  ]);
  const limbSegments = (moved: boolean) => {
    const joint = (label: string) => {
      const h = stand.joints[label], o = skeleton.index[label] * BONE_STRIDE;
      return moved ? [0, 1, 2].map((r) => bones[o + 4 * r] * h[0] + bones[o + 4 * r + 1] * h[1] + bones[o + 4 * r + 2] * h[2] + bones[o + 4 * r + 3]) : [...h];
    };
    const body = moved ? posed : stand.positions;
    return limbs.flatMap((l) => {
      const a = joint(l.from), c = joint(l.to);
      return [[...a, ...c], [...c, body[3 * l.tip], body[3 * l.tip + 1], body[3 * l.tip + 2]]];
    });
  };
  const through = { samples: 0, triangles: 0, count: 0 };
  // The hand (Scenario.grab).
  const hand = sc.grab && { ...sc.grab, patch: null as ReturnType<typeof selectGrab>, origin: [0, 0, 0], held: [0, 0, 0], moved: 0, strainP99: 0, strainMax: 0, vertices: 0 };
  const sampleEvery = Math.round(0.5 / FRAME_DT);
  let aboveFloor = Infinity;

  for (let f = 1; f <= frames; f++) {
    before.set(solver.pos);
    if (hand) {
      const t = solver.time, pos = solver.pos;
      if (!hand.patch && !hand.vertices && t >= hand.at) {
        // The front of the garment on the body's axis: its lowest point (hem), or at 3/4 of its height (chest).
        let lo = Infinity, hi = -Infinity;
        for (let i = 1; i < pos.length; i += 3) [lo, hi] = [Math.min(lo, pos[i]), Math.max(hi, pos[i])];
        const y = hand.where === "hem" ? lo : lo + 0.75 * (hi - lo);
        let best = 0, score = Infinity;
        for (let v = 0; v < model.vertexCount; v++) {
          const d = Math.abs(pos[3 * v + 1] - y) + Math.abs(pos[3 * v]) - 0.5 * pos[3 * v + 2];
          if (d < score) [score, best] = [d, v];
        }
        let triangle = 0;
        while (model.triangles[3 * triangle] !== best && model.triangles[3 * triangle + 1] !== best && model.triangles[3 * triangle + 2] !== best) triangle++;
        hand.origin = [pos[3 * best], pos[3 * best + 1], pos[3 * best + 2]];
        hand.patch = selectGrab(model, pos, triangle, hand.origin as [number, number, number]);
        hand.vertices = hand.patch?.indices.length ?? 0;
        solver.setGrab(hand.patch, hand.origin as [number, number, number]);
      }
      if (hand.patch) {
        const k = Math.min(1, (t + FRAME_DT - hand.at) / hand.ramp);
        solver.moveGrab([0, 1, 2].map((a) => hand.origin[a] + hand.pull[a] * k) as [number, number, number]);
        if (t >= hand.at + hand.ramp + hand.hold) {
          grabPoint(pos, hand.patch, hand.held);
          hand.moved = Math.hypot(hand.held[0] - hand.origin[0], hand.held[1] - hand.origin[1], hand.held[2] - hand.origin[2]);
          solver.setGrab(null);
          hand.at = Infinity; // let go
        } else {
          const s = strain(pos, model);
          hand.strainP99 = Math.max(hand.strainP99, s.p99);
          hand.strainMax = Math.max(hand.strainMax, s.max);
        }
      }
    }
    const t0 = performance.now();
    // Motion mode, as the app does it: the garment is fastened to the skeleton while the body
    // still stands (here, just before it moves), and held by its tethers while it runs.
    if (!sc.untethered && !solver.bound && solver.time >= motionStart - 2 * FRAME_DT) solver.bind();
    solver.tethered = !sc.untethered && solver.bound && animator.running(solver.time);
    solver.step(FRAME_DT, poseAt);
    const ms = performance.now() - t0;
    const t = solver.time;
    if (f > frames - TIMED_FRAMES) frameMs.push(ms);
    else for (const k in phaseTime) phaseTime[k] = 0;
    if (animator.moving(t) || (hand?.patch && hand.at !== Infinity)) {
      movedAt = t;
      rest.reset();
    }
    if (rest.update(solver.pos, FRAME_DT, t > model.fastenedAt + 0.5 && t > movedAt + 0.5) && restAt === null) restAt = t;
    // The garment's top: the highest 5 % of the vertices just after sewing.
    if (!top && t >= params.sewTime + 0.3) {
      const order = Array.from({ length: model.vertexCount }, (_, i) => i).sort((i, j) => solver.pos[3 * j + 1] - solver.pos[3 * i + 1]);
      top = order.slice(0, Math.max(1, Math.round(0.05 * model.vertexCount)));
      topY0 = topY();
    }
    if (f % sampleEvery === 0 || f === frames) {
      const v = speed(solver.pos, before, FRAME_DT);
      const c = crossings(solver.pos, model);
      const s = strain(solver.pos, model);
      if (t > params.sewTime + SELF_DELAY + 0.3) {
        cross.push(c);
        strainP99Max = Math.max(strainP99Max, s.p99);
        const field = bodyField(t, solver.pos);
        const p = penetration(solver.pos, field, clearance);
        // (bodyField has just posed the body at t.)
        const shown = animator.sample(t, bones);
        const showing = skinThrough(solver.pos, model.triangles, shown ? posed : stand.positions, shown ? posedNormals : stand.normals, field, halfThickness, b.indices);
        skin.end = showing.count;
        skin.max = Math.max(skin.max, showing.count);
        skin.depth = Math.max(skin.depth, showing.depth);
        const hits = segmentsThrough(solver.pos, model.triangles, limbSegments(animator.moving(t) || animator.sample(t, bones)));
        through.count++;
        through.triangles += hits;
        if (hits) through.samples++;
        if (p.count > pen.count) pen.count = p.count;
        pen.depth = Math.max(pen.depth, p.depth);
        pen.close = Math.max(pen.close, p.close);
      }
      log(`  t=${t.toFixed(1)}s  ${ms.toFixed(0)} ms/frame  strain p99 ${s.p99.toFixed(2)} % max ${s.max.toFixed(1)} %  crossings ${c}  top ${top ? ((topY() - topY0) * 100).toFixed(1) : "–"} cm  speed ${v.mean.toFixed(0)} mm/s (max ${v.max.toFixed(0)})`);
    }
    for (let i = 0; i < solver.pos.length; i += 3)
      aboveFloor = Math.min(aboveFloor, solver.pos[i + 1] - floorAt(params.floorY, solver.pos[i], solver.pos[i + 2]));
    if (f === frames - 1) last.set(solver.pos);
  }

  let finite = true;
  for (const x of solver.pos) if (!Number.isFinite(x)) finite = false;
  const phases: Record<string, number> = {};
  for (const [k, v] of Object.entries(phaseTime)) phases[k] = v / frameMs.length;
  const sorted = frameMs.slice().sort((x, y) => x - y);
  return {
    name: sc.name,
    vertices: model.vertexCount,
    msPerFrame: sorted[Math.floor(sorted.length / 2)] ?? 0,
    phases,
    strain: strain(solver.pos, model),
    strainP99Max,
    crossings: { end: cross[cross.length - 1] ?? 0, mean: cross.reduce((s, x) => s + x, 0) / Math.max(1, cross.length), max: Math.max(0, ...cross) },
    penetration: pen,
    skinThrough: skin,
    drop: top ? (topY0 - topY()) * 100 : 0,
    limbsThrough: { samples: (100 * through.samples) / Math.max(1, through.count), triangles: through.triangles / Math.max(1, through.count) },
    aboveFloor: aboveFloor * 100,
    speedEnd: speed(solver.pos, last, FRAME_DT),
    restAt,
    finite,
    ...(hand?.patch && {
      grab: (() => {
        const end = [0, 0, 0];
        grabPoint(solver.pos, hand.patch, end);
        return {
          vertices: hand.vertices,
          asked: Math.hypot(...hand.pull) * 100,
          moved: hand.moved * 100,
          strainP99: hand.strainP99,
          strainMax: hand.strainMax,
          back: Math.hypot(end[0] - hand.origin[0], end[1] - hand.origin[1], end[2] - hand.origin[2]) * 100,
        };
      })(),
    }),
  };
}
