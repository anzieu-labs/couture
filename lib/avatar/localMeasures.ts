import { convexHullPerimeter, MeshSlicer } from "../geometry/slice";
import type { AnnyModel, BodyShape } from "./anny";
import { upperArmGirth } from "./bodyMeasures";
import { chestSection, hipJointY, hipsGirth, torsoSection, waistGirth } from "./measure";
import { toPhenotype, type Morphology } from "./morphology";

/**
 * The local changes ("ajustements de couture", morphology.ts LOCAL_CHANGE_LABELS) in
 * centimetres. Their own unit, −1 to 1, says nothing of what one does to the body; each is
 * named after a tape measure, so it is shown as that measure on the body: taken on the body
 * as it is once the sliders rest (localTapes), and followed while one moves by what the
 * change adds to it (localSpans). The girths are taken as the measurements shown above them
 * are (measure.ts), the lengths between the joints of the skeleton.
 */

type Joints = BodyShape["joints"];

interface Tape {
  /** What is measured, told to the user. */
  what: string;
  /** The measure on a body (m). */
  measure: (shape: BodyShape, slicer: MeshSlicer, model: AnnyModel) => number;
}

/** Distance between two joints. */
const between = (a: string, b: string): Tape["measure"] => ({ joints: j }) =>
  Math.hypot(j[a][0] - j[b][0], j[a][1] - j[b][1], j[a][2] - j[b][2]);

/** Girth of the torso at a height read on the skeleton. */
const girthAt = (y: (j: Joints) => number): Tape["measure"] => (shape, slicer) => torsoSection(slicer, y(shape.joints)).girth;

const bust: Tape["measure"] = (shape, slicer) => chestSection(slicer, shape.joints).chest.girth;
const waist: Tape["measure"] = (shape, slicer) => waistGirth(slicer, shape.joints);
const hips: Tape["measure"] = (shape, slicer) => hipsGirth(slicer, shape.joints);

/** The waist on the skeleton: the joint the narrowest girth is found around (measure.ts waistGirth). */
const WAIST_JOINT = "spine03";

/** How far under the crotch the thigh is measured (m), and the step of the search for the crotch. */
const THIGH_BELOW_CROTCH = 0.02;
const CROTCH_STEP = 0.005;

/** Girth of the left thigh at its fullest, just under the crotch: the first height, down from the hip joints, where the legs are apart. */
const thigh: Tape["measure"] = ({ joints: j }, slicer) => {
  let y = hipJointY(j);
  while (y > j["lowerleg01.L"][1] && torsoSection(slicer, y).girth) y -= CROTCH_STEP;
  let girth = 0;
  for (const loop of slicer.horizontal(y - THIGH_BELOW_CROTCH)) {
    let x = 0;
    for (const p of loop.pts) x += p[0] / loop.pts.length;
    // The left leg: neither the right one nor a hand, which hangs at this height.
    if (x > 0 && x < 2 * j["upperleg01.L"][0]) girth = Math.max(girth, convexHullPerimeter(loop.pts));
  }
  return girth;
};

/** Between the two points a change named after a width moves the most (anny.ts localChangePeak). */
const across = (label: string): Tape["measure"] => ({ positions: p }, _slicer, model) => {
  const [a, b] = model.localChangePeak(label);
  return Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
};

export const LOCAL_TAPES: Record<string, Tape> = {
  "measure-shoulder-dist-incr": { what: "D'une épaule à l'autre", measure: between("upperarm01.L", "upperarm01.R") },
  "measure-frontchest-dist-incr": { what: "D'une emmanchure à l'autre, devant", measure: across("measure-frontchest-dist-incr") },
  "torso-vshape-incr": { what: "Écart entre le tour de poitrine et le tour de taille", measure: (...at) => bust(...at) - waist(...at) },
  "measure-bust-circ-incr": { what: "Tour de poitrine", measure: bust },
  "measure-underbust-circ-incr": {
    what: "Tour sous la poitrine",
    measure: girthAt((j) => (j["spine01"][1] + j["spine02"][1]) / 2),
  },
  "measure-waist-circ-incr": { what: "Tour de taille", measure: waist },
  "measure-hips-circ-incr": { what: "Tour de hanches", measure: hips },
  "buttocks-volume-incr": { what: "Tour de hanches, fessiers compris", measure: hips },
  "stomach-pregnant-incr": {
    what: "Tour à hauteur du ventre",
    measure: girthAt((j) => (j[WAIST_JOINT][1] + j["spine04"][1]) / 2),
  },
  "measure-napetowaist-dist-incr": { what: "De la base du cou à la taille", measure: ({ joints: j }) => j["neck01"][1] - j[WAIST_JOINT][1] },
  "measure-waisttohip-dist-incr": { what: "De la taille aux hanches", measure: ({ joints: j }) => j[WAIST_JOINT][1] - hipJointY(j) },
  "measure-neck-circ-incr": { what: "Tour à la base du cou", measure: girthAt((j) => j["neck01"][1] + 0.015) },
  "measure-upperarm-circ-incr": { what: "Tour du bras, au biceps", measure: ({ joints }, slicer) => upperArmGirth(slicer, joints, "L") },
  "measure-upperarm-length-incr": { what: "De l'épaule au coude", measure: between("upperarm01.L", "lowerarm01.L") },
  "measure-lowerarm-length-incr": { what: "Du coude au poignet", measure: between("lowerarm01.L", "wrist.L") },
  "measure-thigh-circ-incr": { what: "Tour de cuisse, sous l'entrejambe", measure: thigh },
  "measure-upperleg-height-incr": { what: "De la hanche au genou", measure: between("upperleg01.L", "lowerleg01.L") },
  "measure-lowerleg-height-incr": { what: "Du genou à la cheville", measure: between("lowerleg01.L", "foot.L") },
};

/** The body of a morphology at the stature asked for, as it is built (useMorphology), with what the tapes take. */
function bodyOf(model: AnnyModel, m: Morphology, local: Record<string, number>, out: Float32Array) {
  const ph = toPhenotype(m);
  ph.height = model.solveHeight(ph, local, m.statureCm / 100);
  const shape = model.compute(ph, local, out);
  return [shape, new MeshSlicer(shape.positions, model.indices), model] as const;
}

/** Every tape on a morphology as it is, local changes included (cm), one at a time: 40 ms in all. */
export function* localTapes(model: AnnyModel, m: Morphology): Generator<[key: string, cm: number]> {
  const body = bodyOf(model, m, m.local, new Float32Array(model.vertexCount * 3));
  for (const [key, tape] of Object.entries(LOCAL_TAPES)) yield [key, tape.measure(...body) * 100];
}

/** What a local change adds to its measure at −1, −½, ½ and 1 (cm; the first two are usually negative). */
export type LocalSpan = [minus: number, halfMinus: number, halfPlus: number, plus: number];

/**
 * What a local change set to `v` adds to its measure (cm). Each side of 0 is its own
 * blendshape, which moves the skin in proportion; a length follows in proportion too, a girth
 * nearly so — the tape bridges the hollows — hence the parabola through the half-way sample.
 */
export function localChangeCm(span: LocalSpan, v: number): number {
  const t = Math.abs(v), half = span[v < 0 ? 1 : 2], full = span[v < 0 ? 0 : 3];
  return t * (4 * half - full) + t * t * (2 * full - 4 * half);
}

/**
 * The span of every local change on a morphology, one at a time — each takes four bodies and
 * a few cuts through them, 15 to 50 ms: the caller spreads them over as many tasks. They are
 * taken from the morphology without its other local changes, which shift them by a few percent
 * only, and at the stature asked for, as the body is built (a longer thigh makes the rest shorter).
 */
export function* localSpans(model: AnnyModel, m: Morphology): Generator<[key: string, span: LocalSpan]> {
  const neutral = bodyOf(model, m, {}, new Float32Array(model.vertexCount * 3));
  const scratch = new Float32Array(model.vertexCount * 3);
  for (const [key, tape] of Object.entries(LOCAL_TAPES)) {
    const at0 = tape.measure(...neutral);
    const at = (v: number) => (tape.measure(...bodyOf(model, m, { [key]: v }, scratch)) - at0) * 100;
    yield [key, [at(-1), at(-0.5), at(0.5), at(1)]];
  }
}
