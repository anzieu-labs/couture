import { axisAngle, identityBones, type Mat3, mul3, type Pose, rotX, rotY, rotZ, type Skeleton, type Vec3 } from "./skeleton";

/**
 * Mannequin motions, as a deterministic function of time (the same timeline
 * drives the rendered body and the cloth collisions, on the CPU or the GPU):
 *
 *  - walk: walking in place on the plinth (looped), faded in and out, at an
 *    adjustable cadence (the stride grows a little with it);
 *  - turn: one full turn on the spot, eased in and out, back facing the front;
 *  - arms: spread of the arms (angle from the body, in the frontal plane),
 *    eased towards its target; also held when the body is still.
 *
 * The walk is driven by the feet (as on a treadmill): in stance the foot is
 * on the floor and slides backwards at constant speed (heel strike, flat
 * foot, heel rise onto the toes); in swing it comes back forward on an arc.
 * Two-bone inverse kinematics (hip, knee) places the ankle, the ankle sets the
 * foot's pitch, and the pelvis comes down at double support just enough for
 * the front leg to reach the floor (the natural bob). Being consistent with the
 * leg lengths of any morphology, both feet touch the floor together: driving
 * the joints with fixed angle curves made one foot float while the other sank,
 * and the body bounced from one to the other — a hop at every step. Plus
 * pelvis rotation and list (cancelled at the hips and the lumbar spine: the
 * legs stay vertical, the thorax upright), a small weight shift over the stance
 * foot (the feet staying put), counter-rotation of the thorax and arm swing.
 * Times are seconds on the caller's clock.
 */

/**
 * Motions start this long after the seams are closed, once the garment has
 * fallen onto the body and self-collisions are on (sim/model.ts SELF_DELAY) (s).
 */
export const MOTION_DELAY = 0.8;
/** Simulated time left to the cloth to settle once the body stops (s). */
export const SETTLE_TIME = 3;

const DEG = Math.PI / 180;
/** Fade in / out of the walk (s). */
const BLEND = 0.6;
/** Steps per minute: default (one gait cycle = two steps), and the slider range. */
export const CADENCE = { default: 110, min: 60, max: 150 };
/** Arm spread (degrees from the body) offered by the slider; below ~20° the skinned shoulder collapses and pinches the sleeve. */
export const ARM_SPREAD = { min: 20, max: 70 };
/** Easing of an arm spread or stride change (s). */
const ARM_TIME = 0.8;
/** One turn (s). */
const TURN_TIME = 6;
/** Elbows straightened while walking (the rest pose's forearms point forward). */
const ELBOW_EXTENSION = 25 * DEG;
/** Legs brought closer while walking (the rest pose stands with feet apart). */
const LEG_ADDUCTION = 4 * DEG;
const SPINE = ["spine04", "spine03", "spine02", "spine01"];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (x: number) => x * x * (3 - 2 * x);
const smootherstep = (x: number) => x * x * x * (x * (6 * x - 15) + 10);
/** Fraction of the gait cycle a foot is on the floor (from heel strike). */
const STANCE = 0.6;
/** Ankle travel relative to the pelvis over a stance (m), at stride factor 1. */
const STRIDE = 0.42;
/** Ankle lift at mid-swing (m). */
const CLEARANCE = 0.08;
/** Foot pitch (degrees, toes up > 0): at heel strike, and at toe-off. */
const PITCH = { strike: 10, toeOff: -25 };
/** The front leg reaches the floor with the knee slightly bent: fraction of the leg length. */
const REACH = 0.985;
/** Lateral shift of the body towards the stance foot, at its mid-stance (m). */
const SWAY = 0.015;
/** Share of the pelvic list cancelled by each lower spine joint (sums to 1: the thorax stays upright over the pelvis). */
const LIST_SPINE: [string, number][] = [["spine05", 0.4], ["spine04", 0.3], ["spine03", 0.2], ["spine02", 0.1]];

/** Ankle path of a leg at phase p of its cycle (0 = heel strike): forward offset (× stride), lift (× clearance), foot pitch (deg). */
function footPath(p: number): { z: number; lift: number; pitch: number } {
  p -= Math.floor(p);
  if (p < STANCE) {
    const pitch =
      p < 0.08 ? PITCH.strike * (1 - smoothstep(p / 0.08)) : p < 0.4 ? 0 : PITCH.toeOff * smoothstep((p - 0.4) / (STANCE - 0.4));
    return { z: 0.5 - p / STANCE, lift: 0, pitch };
  }
  const u = (p - STANCE) / (1 - STANCE);
  return { z: smootherstep(u) - 0.5, lift: Math.sin(Math.PI * u), pitch: PITCH.toeOff + (PITCH.strike - PITCH.toeOff) * smoothstep(u) };
}

interface Leg {
  hip: Vec3;
  ankle: Vec3;
  /** Thigh and shank (rest) in the sagittal plane: (y, z). */
  thigh: [number, number];
  shank: [number, number];
  /** Heel and toe relative to the ankle: (y, z). */
  heel: [number, number];
  toe: [number, number];
}

/** Forward angle of a sagittal vector (y, z): 0 pointing down, > 0 towards the front. */
const angleOf = (y: number, z: number) => Math.atan2(z, -y);
/** rotX(θ) in the sagittal plane (turns a vector by −θ in angleOf). */
const turn2 = ([y, z]: [number, number], a: number): [number, number] => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];

/**
 * Hip and knee rotations (rotX, rest-world axes) bringing the ankle to (ty, tz)
 * relative to the hip, the knee bending backwards; returns [hip, knee].
 */
function legIK(leg: Leg, ty: number, tz: number): [number, number] {
  const t = leg.thigh, s = leg.shank;
  const a = Math.hypot(t[0], t[1]), b = Math.hypot(s[0], s[1]);
  const c = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, Math.hypot(ty, tz)));
  const bend = -Math.acos(Math.min(1, Math.max(-1, (c * c - a * a - b * b) / (2 * a * b))));
  const knee = angleOf(s[0], s[1]) - angleOf(t[0], t[1]) - bend;
  const [sy, sz] = turn2(s, knee);
  const hip = angleOf(t[0] + sy, t[1] + sz) - angleOf(ty, tz);
  return [hip, knee];
}

/** Weight of a foot in carrying the body: 1 in stance, 0 in swing, blended over double support. */
const stanceWeight = (phase: number) => {
  const p = phase - Math.floor(phase);
  if (p < 0.08) return smoothstep(0.5 + p / 0.16);
  if (p > 0.92) return smoothstep((p - 0.92) / 0.16);
  return p < 0.54 ? 1 : smoothstep(clamp01((0.66 - p) / 0.12));
};

export class Animator {
  /** Gait phase = phase0 + (t − time0) / period (kept continuous across cadence changes). */
  private walk: { phase0: number; time0: number; rampStart: number; stop: number } | null = null;
  private period = 120 / CADENCE.default;
  /** Stride amplitude factor, eased from `from` to `to` (cadence changes). */
  private stride = { from: 1, to: 1, start: -Infinity };
  private turn: { start: number } | null = null;
  /** Arm adduction from the rest pose (rad), eased from `from` to `to` starting at `start`. */
  private arms = { from: 0, to: 0, start: -Infinity };
  /** Requested arm spread (degrees from the body); null: rest pose. */
  private armSpread: number | null = null;
  private notBefore = -Infinity;
  private elbowAxes: Record<"L" | "R", Vec3> = { L: [1, 0, 0], R: [1, 0, 0] };
  private legs = {} as Record<"L" | "R", Leg>;
  /** Arm spread of the rest pose (degrees from the body). */
  restArmSpread = 40;

  constructor(private skel: Skeleton) {
    this.skeleton = skel;
  }

  get skeleton(): Skeleton {
    return this.skel;
  }

  /** New rest skeleton (morphology change); the timeline is kept. */
  set skeleton(s: Skeleton) {
    this.skel = s;
    let spread = 0;
    for (const side of ["L", "R"] as const) {
      const a = s.head(`upperarm01.${side}`), b = s.head(`lowerarm01.${side}`);
      // Rest arm spread: upper arm angle from the vertical, in the frontal plane.
      spread += Math.atan2(Math.abs(b[0] - a[0]), a[1] - b[1]) / DEG / 2;
      // Elbow flexion axis: perpendicular to the upper arm and to the front.
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const axis: Vec3 = [d[1], -d[0], 0]; // d × Z
      const l = Math.hypot(...axis) || 1;
      this.elbowAxes[side] = [axis[0] / l, axis[1] / l, 0];
    }
    this.restArmSpread = spread;
    for (const side of ["L", "R"] as const) {
      const hip = s.head(`upperleg01.${side}`), knee = s.head(`lowerleg01.${side}`), ankle = s.head(`foot.${side}`);
      const sole = s.soles.find((x) => x.label === `foot.${side}`);
      const rel = (q: Vec3 | undefined): [number, number] => (q ? [q[1] - ankle[1], q[2] - ankle[2]] : [s.soleHeight - ankle[1], 0]);
      this.legs[side] = {
        hip,
        ankle,
        thigh: [knee[1] - hip[1], knee[2] - hip[2]],
        shank: [ankle[1] - knee[1], ankle[2] - knee[2]],
        heel: rel(sole?.points[0]),
        toe: rel(sole?.points[1]),
      };
    }
  }

  /** Ankle target (y, z relative to the hip) for a point of the foot path, the floor `floor` m above rest. */
  private ankleTarget(leg: Leg, z: number, lift: number, pitch: number, floor: number): [number, number] {
    // Lowest of heel and toe once the foot is pitched (rotX(−pitch)).
    const c = Math.cos(pitch), sn = Math.sin(pitch);
    const low = Math.min(leg.heel[0] * c + leg.heel[1] * sn, leg.toe[0] * c + leg.toe[1] * sn);
    const y = this.skel.soleHeight + floor - low + lift;
    return [y - leg.hip[1], leg.ankle[2] + z - leg.hip[2]];
  }

  /** Back to the rest pose at once, nothing scheduled (the requested arm spread is kept). */
  reset() {
    this.walk = this.turn = null;
    this.arms = { from: 0, to: 0, start: -Infinity };
    this.notBefore = -Infinity;
  }

  /** Motions requested before `time` will start at `time` (e.g. while the garment is sewn). */
  holdUntil(time: number) {
    this.notBefore = time;
  }

  /** Whether the walk is on (requested, possibly not started yet). */
  get walking(): boolean {
    return !!this.walk && this.walk.stop === Infinity;
  }

  private walkLevel(t: number): number {
    const w = this.walk;
    if (!w) return 0;
    return clamp01(Math.min((t - w.rampStart) / BLEND, 1 - (t - w.stop) / BLEND));
  }

  private armAdduction(t: number): number {
    const { from, to, start } = this.arms;
    return from + (to - from) * smoothstep(clamp01((t - start) / ARM_TIME));
  }

  /** Arm spread in degrees from the body (null: rest pose), eased in from time t. */
  setArmSpread(degrees: number | null, t: number) {
    this.armSpread = degrees;
    const to = degrees === null ? 0 : (this.restArmSpread - degrees) * DEG;
    if (to === this.arms.to) return;
    this.arms = { from: this.armAdduction(t), to, start: Math.max(t, this.notBefore) };
  }

  /** Re-applies the requested arm spread from time t (after a reset, or with a new skeleton). */
  restoreArmSpread(t: number) {
    this.setArmSpread(this.armSpread, t);
  }

  /** Eases back to the rest pose from time t (walk and arms), keeping the requested arm spread. */
  fadeToRest(t: number) {
    this.setWalking(false, t);
    const from = this.armAdduction(t);
    if (from !== 0 || this.arms.to !== 0) this.arms = { from, to: 0, start: t };
  }

  /** Walking cadence (steps per minute), from time t. */
  setCadence(stepsPerMinute: number, t: number) {
    const period = 120 / stepsPerMinute;
    const w = this.walk;
    if (w && t > w.time0) {
      w.phase0 += (t - w.time0) / this.period;
      w.time0 = t;
    }
    this.period = period;
    // Longer strides at a higher cadence.
    const to = Math.min(1.25, Math.max(0.75, 0.45 + (0.55 * stepsPerMinute) / CADENCE.default));
    if (to !== this.stride.to) this.stride = { from: this.strideAt(t), to, start: t };
  }

  private strideAt(t: number): number {
    const { from, to, start } = this.stride;
    return from + (to - from) * smoothstep(clamp01((t - start) / ARM_TIME));
  }

  private get turnEnd(): number {
    return this.turn ? this.turn.start + TURN_TIME : -Infinity;
  }

  setWalking(on: boolean, t: number) {
    const w = this.walk;
    if (on) {
      if (w && w.stop === Infinity) return;
      if (w && t < w.stop + BLEND) {
        // Resume while fading out: same phase, continuous level.
        w.rampStart = t - this.walkLevel(t) * BLEND;
        w.stop = Infinity;
        return;
      }
      const start = Math.max(t, this.notBefore, this.turnEnd);
      this.walk = { phase0: 0, time0: start, rampStart: start, stop: Infinity };
    } else if (w && w.stop === Infinity) {
      if (t <= w.rampStart) this.walk = null; // not started yet
      else w.stop = t - (1 - this.walkLevel(t)) * BLEND;
    }
  }

  /** Starts one full turn (after the walk has faded out). Ignored while turning. */
  startTurn(t: number) {
    if (this.turn && t < this.turnEnd) return;
    let start = Math.max(t, this.notBefore);
    this.setWalking(false, t);
    if (this.walk) start = Math.max(start, this.walk.stop + BLEND);
    this.turn = { start };
  }

  /** Whether the body moves at time t. */
  moving(t: number): boolean {
    const w = this.walk;
    return (
      (!!w && t > w.rampStart && t < w.stop + BLEND) ||
      (!!this.turn && t > this.turn.start && t < this.turnEnd) ||
      (this.arms.from !== this.arms.to && t > this.arms.start && t < this.arms.start + ARM_TIME)
    );
  }

  /** Whether a motion is under way or scheduled at time t or later. */
  pending(t: number): boolean {
    return (
      (!!this.walk && t < this.walk.stop + BLEND) ||
      (!!this.turn && t < this.turnEnd) ||
      (this.arms.from !== this.arms.to && t < this.arms.start + ARM_TIME)
    );
  }

  /**
   * Bone transforms at time t into `out`. Returns false (identity transforms)
   * when the body is at rest.
   */
  sample(t: number, out: Float32Array): boolean {
    const s = this.skel;
    const adduction = this.armAdduction(t);
    if (!this.moving(t) && adduction === 0) {
      identityBones(s.count, out);
      return false;
    }
    const rot: (Mat3 | null)[] = new Array(s.count).fill(null);
    const set = (label: string, r: Mat3) => {
      const i = s.index[label];
      if (i !== undefined) rot[i] = rot[i] ? mul3(r, rot[i]!) : r;
    };

    const level = t > (this.walk?.rampStart ?? Infinity) ? smoothstep(this.walkLevel(t)) : 0;
    let offset: Vec3 | null = null;
    if (level > 0) {
      const w = this.walk!;
      const phase = w.phase0 + (t - w.time0) / this.period;
      const c = Math.cos(2 * Math.PI * phase), sn = Math.sin(2 * Math.PI * phase);
      const k = level * this.strideAt(t) * DEG;
      // Pelvis: rotation (swing side forward) and list (swing side drops); thorax counter-rotates.
      // The list is the pelvis's alone: the lumbar spine and the hips cancel it, so that the
      // thorax stays upright and the legs vertical (inheriting it, the feet slid sideways on the
      // floor and the torso swayed over them, away from the stance foot). The hips cancel the
      // rotation of the pelvis too: the feet keep pointing forward and stay put.
      const yaw = -4 * c * k, list = 3 * sn * k;
      const pelvis = mul3(rotY(yaw), rotZ(list));
      set("root", pelvis);
      for (const b of SPINE) set(b, rotY((7 * c * k) / SPINE.length));
      for (const [b, share] of LIST_SPINE) set(b, rotZ(-share * list));
      // Weight shift: the body moves over the stance foot (left at its mid-stance, phase 0.3),
      // the feet staying where they are on the floor.
      const shift = SWAY * level * Math.sin(2 * Math.PI * (phase - 0.05));
      offset = [shift, 0, 0];
      const root = s.head("root");
      // Pelvis drop at heel strike, so that the front leg reaches the floor.
      const stride = STRIDE * this.strideAt(t) * level;
      let drop = 0;
      for (const leg of [this.legs.L, this.legs.R]) {
        const [ty, tz] = this.ankleTarget(leg, stride / 2, 0, PITCH.strike * level * DEG, 0);
        const reach = REACH * (Math.hypot(...leg.thigh) + Math.hypot(...leg.shank));
        if (Math.hypot(ty, tz) > reach) drop = Math.max(drop, -ty - Math.sqrt(Math.max(0, reach * reach - tz * tz)));
      }
      // Lowest at each heel strike (phases 0 and ½), highest at mid-stance.
      const floor = drop * (0.5 + 0.5 * Math.cos(4 * Math.PI * phase));
      for (const [side, p, sign] of [["L", phase, 1], ["R", phase + 0.5, -1]] as const) {
        const leg = this.legs[side];
        const f = footPath(p);
        const pitch = f.pitch * level * DEG;
        const [ty, tz] = this.ankleTarget(leg, f.z * stride, f.lift * CLEARANCE * level, pitch, floor);
        // Hip displacement by the pelvis (the list raises the stance hip and lowers the swing one).
        const r = [leg.hip[0] - root[0], leg.hip[1] - root[1], leg.hip[2] - root[2]];
        const d = [0, 1, 2].map((i) => pelvis[3 * i] * r[0] + pelvis[3 * i + 1] * r[1] + pelvis[3 * i + 2] * r[2] - r[i]);
        const hy = ty - d[1];
        const [hip, knee] = legIK(leg, hy, tz - d[2]);
        // Thigh flexed in the sagittal plane, then brought in (the rest pose stands with feet apart)
        // and tilted against the weight shift (the ankle, |hy| below the hip, stays put); the
        // rotation of the pelvis cancelled.
        const roll = -sign * LEG_ADDUCTION * level - Math.asin((shift + d[0]) / Math.max(0.1, -hy));
        set(`upperleg01.${side}`, mul3(rotZ(-list), mul3(rotY(-yaw), mul3(rotZ(roll), rotX(hip)))));
        set(`lowerleg01.${side}`, rotX(knee));
        // Pitch only: the sole stays flat across (no roll from the thigh).
        set(`foot.${side}`, mul3(rotX(-hip - knee), mul3(rotZ(-roll), rotX(-pitch))));
        // The arm swings with the opposite leg (swing > 0: arm forward, elbow a little more bent);
        // the elbow straightens from the rest pose, whose forearms point forward.
        const swing = -Math.cos(2 * Math.PI * p);
        set(`upperarm01.${side}`, rotX(-(2 + 14 * swing) * k));
        set(`lowerarm01.${side}`, axisAngle(this.elbowAxes[side], (6 + 5 * swing) * k - ELBOW_EXTENSION * level));
      }
    }

    // Arm spread, before the swing (rotation about Z: towards the body).
    if (adduction !== 0)
      for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
        const i = s.index[`upperarm01.${side}`];
        if (i !== undefined) rot[i] = rot[i] ? mul3(rot[i]!, rotZ(-sign * adduction)) : rotZ(-sign * adduction);
      }

    if (this.turn && t > this.turn.start && t < this.turnEnd)
      set("root", rotY(2 * Math.PI * smootherstep((t - this.turn.start) / TURN_TIME)));

    const pose: Pose = { rotations: rot, ground: null, offset };
    if (level > 0) {
      const w = this.walk!;
      const phase = w.phase0 + (t - w.time0) / this.period;
      pose.ground = { "foot.L": stanceWeight(phase), "foot.R": stanceWeight(phase + 0.5) };
    }
    s.pose(pose, out);
    return true;
  }
}
