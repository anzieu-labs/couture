import type { SkinWeights } from "./anny";
import { armIK, restPole } from "./armIK";
import { axisAngle, BONE_STRIDE, composeBones, identityBones, invertBones, type Mat3, mul3, type Pose, rotX, rotY, rotZ, type Skeleton, skinVertices, type Vec3 } from "./skeleton";

/**
 * Mannequin motions, as a deterministic function of time (the same timeline
 * drives the rendered body and the cloth collisions, on the CPU or the GPU):
 *
 *  - walk: walking in place on the plinth (looped), faded in and out, at an
 *    adjustable cadence (the stride grows a little with it);
 *  - turn: one full turn on the spot, eased in and out, back facing the front;
 *  - arms: along the body (ARM_SPREAD, in the frontal plane), always: the rest pose's A is
 *    never shown;
 *  - hands: a wrist target per arm (dragged in the 3D view), reached by
 *    two-bone inverse kinematics (armIK.ts); it overrides the spread and the
 *    walk's swing for that arm, eased in and out;
 *  - run: above a cadence threshold the walk turns into a run (see RUN);
 *  - posture: standing, seated or squatting (held poses, eased in and out).
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
 *
 * Reference pose: the body as it stands (arms along the body, nothing else), not the
 * morphology's own rest pose (an A-pose, only measured and skinned from). The bone transforms
 * handed out (Animator.sample) go from the standing pose to the pose at time t, and
 * `standingBody` gives the vertices and joints they apply to. Standing still, they are the
 * identity: the body shown is then exactly the one the cloth collides with. Cloth collisions
 * are solved in that reference pose (lib/sim/posedBody.ts), by an approximation that grows
 * with how far the bones have moved from it — solved in the A-pose, the cloth lying on the
 * shoulders of the standing mannequin was up to 7 mm off the skin as shown, on either side
 * of it: the skin showed through.
 */

/**
 * Motions start this long after the seams are closed, once the garment has
 * fallen onto the body and self-collisions are on (sim/model.ts SELF_DELAY) (s).
 */
export const MOTION_DELAY = 0.8;

const DEG = Math.PI / 180;
export type Side = "L" | "R";
/** Fade in / out of the walk (s). */
const BLEND = 0.6;
/** Steps per minute: default (one gait cycle = two steps), and the slider range. */
export const CADENCE = { default: 110, min: 60, max: 180 };
/** Cadence (steps per minute) at which the walk turns into a run: a walk below `from`, a run above `to`. */
export const RUN_CADENCE = { from: 135, to: 155 };
/** Standing, or held poses the legs are placed in (the feet stay on the floor). */
export type Posture = "standing" | "sitting" | "squatting";
/** Easing from one posture to another (s). */
const POSTURE_TIME = 1.4;
/**
 * Arm spread (degrees from the body): the arms hang along the body, from the start — the
 * garment is sewn in that pose (the mannequin's own rest pose is an A-pose, arms at ~40°).
 * Below ~20° the skinned shoulder collapses and pinches the sleeve.
 */
export const ARM_SPREAD = 20;
/** Easing of an arm spread or stride change (s). */
const ARM_TIME = 0.8;
/** Easing of a hand target while it is dragged (s): smooth, yet follows the pointer. */
const HAND_TIME = 0.2;
/** One turn (s). */
const TURN_TIME = 6;
/** Elbows straightened while walking (the rest pose's forearms point forward). */
const ELBOW_EXTENSION = 25 * DEG;
/**
 * Elbows straightened as the arms come down from the rest pose (full at the lowest
 * spread): the rest pose's elbows are bent by ~44°, forearms pointing forward, which
 * looks stiff with the arms along the body; straightened, they hang (~9° left).
 */
const ELBOW_RELAX = 35 * DEG;
/**
 * Distance of each ankle from the body's mid-plane while walking (m): a natural step is
 * about 10 cm wide between the heels, the rest pose stands with its feet 40 cm apart.
 */
const STEP_HALF_WIDTH = 0.055;
/**
 * Running, as changes to the walk (blended in between the RUN_CADENCE thresholds): a shorter
 * stance (below half the cycle: both feet leave the floor), longer strides on bent knees, the
 * feet lifted high behind and landing nearly on one line, the pelvis lowest at mid-stance and
 * rising in flight, the trunk leaning forward, the elbows bent and swinging wider.
 */
const RUN = {
  stance: 0.38,
  /** × the walk's stride. */
  stride: 1.1,
  clearance: 0.22,
  strike: 3,
  toeOff: -40,
  reach: 0.985,
  halfWidth: 0.025,
  /** Pelvis drop at mid-stance, and rise at mid-flight (m). */
  dip: 0.03,
  hop: 0.03,
  /** Degrees: trunk lean, arm swing amplitude (the walk's is 14), elbow flexion. */
  lean: 8,
  armSwing: 30,
  elbow: 55,
};
/**
 * Seated (on an invisible stool) and squatting: where the ankle is put from the hip, as
 * fractions of the shank / thigh (seated: thighs level, shanks upright) or of the leg
 * (squatting: hips just above the heels); trunk lean and arms forward (degrees); how far back
 * the pelvis moves so that the feet stay near the middle of the plinth (× thigh).
 */
const SIT = { shin: 0.98, thigh: 0.97, lean: 0, arms: 12, back: 0.5 };
const SQUAT = { height: 0.25, forward: 0.12, lean: 30, arms: 55, back: 0.25 };
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

/**
 * Ankle path of a leg at phase p of its cycle (0 = heel strike), for a stance lasting the share
 * `stance` of the cycle: forward offset (× stride), lift (× clearance), foot pitch (deg) between
 * its values at heel strike and at toe-off.
 */
function footPath(p: number, stance: number, strike: number, toeOff: number): { z: number; lift: number; pitch: number } {
  p -= Math.floor(p);
  if (p < stance) {
    // Heel strike, flat foot, heel rise onto the toes.
    const flat = (0.08 / STANCE) * stance, rise = (0.4 / STANCE) * stance;
    const pitch = p < flat ? strike * (1 - smoothstep(p / flat)) : p < rise ? 0 : toeOff * smoothstep((p - rise) / (stance - rise));
    return { z: 0.5 - p / stance, lift: 0, pitch };
  }
  // Swing: the foot leaves and lands at the speed it has on the floor (it trails behind, then
  // reaches ahead and comes back to meet the ground) — a cubic through both ends with the
  // stance's slope; coming to a stop at each end made the feet jerk, all the more when running.
  const u = (p - stance) / (1 - stance);
  const slope = -(1 - stance) / stance;
  const u2 = u * u, u3 = u2 * u;
  const z = -0.5 * (2 * u3 - 3 * u2 + 1) + slope * (u3 - 2 * u2 + u) + 0.5 * (3 * u2 - 2 * u3) + slope * (u3 - u2);
  return { z, lift: Math.sin(Math.PI * u) ** 2, pitch: toeOff + (strike - toeOff) * smoothstep(u) };
}

interface Leg {
  hip: Vec3;
  ankle: Vec3;
  /** Thigh and shank (rest) in the sagittal plane: (y, z). */
  thigh: [number, number];
  shank: [number, number];
  /** Sole points (heel, toe, inner and outer edge) relative to the ankle: (y, z). */
  sole: [number, number][];
  /** Hip → ankle distance, hip distance from the mid-plane (m), and how far out the rest leg leans (rad). */
  length: number;
  hipX: number;
  out: number;
}

/** Forward angle of a sagittal vector (y, z): 0 pointing down, > 0 towards the front. */
const angleOf = (y: number, z: number) => Math.atan2(z, -y);
/** rotX(θ) in the sagittal plane (turns a vector by −θ in angleOf). */
const turn2 = ([y, z]: [number, number], a: number): [number, number] => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];

/** Distance below the leg's longest reach over which a moving leg slows down into full extension (m). */
const SOFT_REACH = 0.02;

/**
 * Hip and knee rotations (rotX, rest-world axes) bringing the ankle to (ty, tz)
 * relative to the hip, the knee bending backwards; returns [hip, knee]. `soft` (0..1, the
 * level of the gait): the leg eases into its longest reach instead of stopping dead there.
 */
function legIK(leg: Leg, ty: number, tz: number, soft = 0): [number, number] {
  const t = leg.thigh, s = leg.shank;
  const a = Math.hypot(t[0], t[1]), b = Math.hypot(s[0], s[1]);
  // Never straighter than the rest pose: the knee angle is singular at full extension (its
  // slope is infinite there), and a leg locking out at mid-stance made the knee jump several
  // millimetres within one substep — a jolt for any garment resting on the thigh, at every step.
  const reach = Math.hypot(t[0] + s[0], t[1] + s[1]);
  const d = Math.hypot(ty, tz);
  // Eased into the limit (not at rest, soft = 0: the rest pose itself is at the limit): a leg
  // reaching it at speed still whipped the knee back, at a brisk walk and when running.
  const knee0 = reach - SOFT_REACH;
  const eased = d <= knee0 ? d : knee0 + SOFT_REACH * Math.tanh((d - knee0) / SOFT_REACH);
  const hard = Math.min(reach, d);
  const c = Math.max(Math.abs(a - b) + 1e-6, hard + (eased - hard) * soft);
  const bend = -Math.acos(Math.min(1, Math.max(-1, (c * c - a * a - b * b) / (2 * a * b))));
  const knee = angleOf(s[0], s[1]) - angleOf(t[0], t[1]) - bend;
  const [sy, sz] = turn2(s, knee);
  const hip = angleOf(t[0] + sy, t[1] + sz) - angleOf(ty, tz);
  return [hip, knee];
}

/** Share of the cycle over which a foot takes or gives up the body's weight when there is no double support. */
const EDGE = 0.04;

/**
 * Weight of a foot in carrying the body, for a stance lasting the share `stance` of the cycle:
 * 1 in stance, 0 in swing, blended over double support (walking). With little or no double
 * support (running), the foot carries the body from just after its strike to just before its
 * toe-off: the weights then sum to less than 1 around the flight, and the body is grounded
 * only that much (Skeleton.pose).
 */
const stanceWeight = (phase: number, stance: number) => {
  const p = phase - Math.floor(phase);
  const e = 0.8 * Math.min(0.1, Math.max(0, stance - 0.5));
  if (e <= EDGE) return smoothstep(clamp01(p / EDGE)) * smoothstep(clamp01((stance - p) / EDGE));
  if (p < e) return smoothstep(0.5 + p / (2 * e));
  if (p > 1 - e) return smoothstep((p - (1 - e)) / (2 * e));
  return p < stance - 0.75 * e ? 1 : smoothstep(clamp01((stance + 0.75 * e - p) / (1.5 * e)));
};

/** Share of each held pose in the current posture (both 0: standing). */
interface PostureWeights {
  sit: number;
  squat: number;
}
const POSTURES: Record<Posture, PostureWeights> = { standing: { sit: 0, squat: 0 }, sitting: { sit: 1, squat: 0 }, squatting: { sit: 0, squat: 1 } };

export class Animator {
  /** Gait phase = phase0 + (t − time0) / period (kept continuous across cadence changes). */
  private walk: { phase0: number; time0: number; rampStart: number; stop: number } | null = null;
  private period = 120 / CADENCE.default;
  /** Stride amplitude factor, eased from `from` to `to` (cadence changes). */
  private stride = { from: 1, to: 1, start: -Infinity };
  /** Walk (0) to run (1), eased like the stride (cadence changes). */
  private run = { from: 0, to: 0, start: -Infinity };
  /** Posture, eased from `from` to `to` over POSTURE_TIME from `start`; the requested one is kept across a reset. */
  private posture = { from: POSTURES.standing, to: POSTURES.standing, start: -Infinity };
  private postureRequest: Posture = "standing";
  private turn: { start: number } | null = null;
  /** Arm adduction from the rest pose (rad): fixed (ARM_SPREAD), set with the skeleton. */
  private arms = { from: 0, to: 0, start: -Infinity };
  /**
   * Wrist target per arm (rest frame), eased from `from` to `to` over `time` from `start`;
   * `release`: easing back to the arm-spread pose, after which the arm is no longer driven.
   */
  private hands: Record<Side, { from: Vec3; to: Vec3; start: number; time: number; release: boolean } | null> = { L: null, R: null };
  /** Requested wrist targets (kept across a reset, restored like the arm spread). */
  private handRequest: Record<Side, Vec3 | null> = { L: null, R: null };
  private notBefore = -Infinity;
  private elbowAxes: Record<"L" | "R", Vec3> = { L: [1, 0, 0], R: [1, 0, 0] };
  private legs = {} as Record<"L" | "R", Leg>;
  /** Arm spread of the rest pose (degrees from the body). */
  restArmSpread = 40;
  /**
   * The pose the mannequin stands in (arms along the body), as bone transforms from the
   * morphology's rest pose: the reference of the transforms `sample` gives (see `standingBody`).
   */
  standing: Float32Array = new Float32Array(0);
  /** From the standing pose back to the rest pose. */
  private fromStanding: Float64Array = new Float64Array(0);

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
    const lowered = (spread - ARM_SPREAD) * DEG;
    this.arms = { from: lowered, to: lowered, start: -Infinity };
    const rot: (Mat3 | null)[] = new Array(s.count).fill(null);
    this.lowerArms(rot, lowered);
    this.standing = s.pose({ rotations: rot, ground: null }, new Float32Array(s.count * BONE_STRIDE));
    this.fromStanding = invertBones(this.standing);
    for (const side of ["L", "R"] as const) {
      const hip = s.head(`upperleg01.${side}`), knee = s.head(`lowerleg01.${side}`), ankle = s.head(`foot.${side}`);
      const sole = s.soles.find((x) => x.label === `foot.${side}`);
      const rel = (q: Vec3 | undefined): [number, number] => (q ? [q[1] - ankle[1], q[2] - ankle[2]] : [s.soleHeight - ankle[1], 0]);
      this.legs[side] = {
        hip,
        ankle,
        thigh: [knee[1] - hip[1], knee[2] - hip[2]],
        shank: [ankle[1] - knee[1], ankle[2] - knee[2]],
        sole: sole ? sole.points.map((q) => rel(q)) : [rel(undefined)],
        length: Math.hypot(ankle[0] - hip[0], ankle[1] - hip[1], ankle[2] - hip[2]),
        hipX: Math.abs(hip[0]),
        out: 0,
      };
      this.legs[side].out = Math.asin(clamp01((Math.abs(ankle[0]) - Math.abs(hip[0])) / this.legs[side].length));
    }
  }

  /**
   * Arms lowered from the rest pose by `adduction` (rad, in the frontal plane: applied before
   * any rotation the upper arm already has), elbows relaxed in proportion (none when raised).
   */
  private lowerArms(rot: (Mat3 | null)[], adduction: number) {
    const s = this.skel;
    const lowest = (this.restArmSpread - ARM_SPREAD) * DEG;
    const relax = lowest > 0 ? ELBOW_RELAX * clamp01(adduction / lowest) : 0;
    for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
      const iu = s.index[`upperarm01.${side}`], il = s.index[`lowerarm01.${side}`];
      if (adduction !== 0 && iu !== undefined) rot[iu] = rot[iu] ? mul3(rot[iu]!, rotZ(-sign * adduction)) : rotZ(-sign * adduction);
      if (relax > 0 && il !== undefined) {
        const r = axisAngle(this.elbowAxes[side], -relax);
        rot[il] = rot[il] ? mul3(r, rot[il]!) : r;
      }
    }
  }

  /**
   * Ankle target (y, z relative to the hip) for a point of the foot path, the floor `floor` m
   * above rest, at walk level `level` (0: the rest pose's own ankle).
   */
  private ankleTarget(leg: Leg, z: number, lift: number, pitch: number, floor: number, level: number): [number, number] {
    // Lowest point of the sole once the foot is pitched (rotX(−pitch)): the very points the
    // skeleton grounds the body on, so that a foot put down by the leg is exactly on the floor
    // (a mismatch made the whole body jump at each strike of a run, when the grounding resumes).
    const c = Math.cos(pitch), sn = Math.sin(pitch);
    let low = Infinity, lowRest = Infinity;
    for (const [y, z] of leg.sole) {
      low = Math.min(low, y * c + z * sn);
      lowRest = Math.min(lowRest, y);
    }
    // The rest pose may stand a little higher than a foot put down on its sole points (the other
    // foot's are lower): faded out as the walk fades in. Applied at once, the legs snapped
    // straight (knees 3 cm back) on the walk's first substep.
    const rest = leg.ankle[1] + lowRest - this.skel.soleHeight;
    const y = this.skel.soleHeight + floor - low + lift + (1 - level) * rest;
    return [y - leg.hip[1], leg.ankle[2] + z - leg.hip[2]];
  }

  /** Standing still at once, nothing scheduled (the requested hand targets and posture are kept). */
  reset() {
    this.walk = this.turn = null;
    this.hands = { L: null, R: null };
    this.posture = { from: POSTURES.standing, to: POSTURES.standing, start: -Infinity };
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

  /** Re-applies the requested hand targets and posture from time t (after a reset, or with a new skeleton). */
  restore(t: number) {
    for (const side of ["L", "R"] as const) {
      const target = this.handRequest[side];
      if (target) this.setHandTarget(side, target, t, ARM_TIME);
    }
    this.setPosture(this.postureRequest, t);
  }

  /** Requested wrist targets (rest frame); null: the arm follows the spread. */
  get handTargets(): Record<Side, Vec3 | null> {
    return { ...this.handRequest };
  }

  /**
   * Drives an arm's wrist to `target` (rest frame, m) from time t, eased over
   * `time`; null releases it back to the arm-spread pose.
   */
  setHandTarget(side: Side, target: Vec3 | null, t: number, time = HAND_TIME) {
    this.handRequest[side] = target;
    const current = this.wristTarget(side, t) ?? this.spreadWrist(side, this.armAdduction(t));
    if (!target) {
      if (this.hands[side]) this.hands[side] = { from: current, to: this.spreadWrist(side, this.arms.to), start: t, time: ARM_TIME, release: true };
      return;
    }
    this.hands[side] = { from: current, to: [...target], start: Math.max(t, this.notBefore), time, release: false };
  }

  /** Wrist target of a driven arm at time t (null: not driven). */
  private wristTarget(side: Side, t: number): Vec3 | null {
    const h = this.hands[side];
    if (!h) return null;
    const k = smoothstep(clamp01((t - h.start) / h.time));
    if (h.release && k >= 1) return null;
    return [h.from[0] + (h.to[0] - h.from[0]) * k, h.from[1] + (h.to[1] - h.from[1]) * k, h.from[2] + (h.to[2] - h.from[2]) * k];
  }

  /** Wrist of the arm-spread pose (rest frame) for an adduction (rad): where a released hand goes. */
  private spreadWrist(side: Side, adduction: number): Vec3 {
    const s = this.skel;
    const S = s.head(`upperarm01.${side}`), E = s.head(`lowerarm01.${side}`), W = s.head(`wrist.${side}`);
    const sign = side === "L" ? 1 : -1;
    const lowest = (this.restArmSpread - ARM_SPREAD) * DEG;
    const relax = lowest > 0 ? ELBOW_RELAX * clamp01(adduction / lowest) : 0;
    const ra = rotZ(-sign * adduction), re = axisAngle(this.elbowAxes[side], -relax);
    const apply = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const f = apply(re, [W[0] - E[0], W[1] - E[1], W[2] - E[2]]);
    const w = apply(ra, [E[0] - S[0] + f[0], E[1] - S[1] + f[1], E[2] - S[2] + f[2]]);
    return [S[0] + w[0], S[1] + w[1], S[2] + w[2]];
  }

  private handsMoving(t: number): boolean {
    return (["L", "R"] as const).some((side) => {
      const h = this.hands[side];
      return !!h && t > h.start && t < h.start + h.time;
    });
  }

  /** Eases back to standing still from time t (walk, posture, placed hands). */
  fadeToRest(t: number) {
    this.setWalking(false, t);
    if (this.posture.to !== POSTURES.standing) this.posture = { from: this.postureAt(t), to: POSTURES.standing, start: t };
    for (const side of ["L", "R"] as const) {
      const current = this.wristTarget(side, t);
      if (current) this.hands[side] = { from: current, to: this.spreadWrist(side, this.arms.to), start: t, time: ARM_TIME, release: true };
    }
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
    const run = smoothstep(clamp01((stepsPerMinute - RUN_CADENCE.from) / (RUN_CADENCE.to - RUN_CADENCE.from)));
    if (run !== this.run.to) this.run = { from: this.runAt(t), to: run, start: t };
  }

  private runAt(t: number): number {
    const { from, to, start } = this.run;
    return from + (to - from) * smoothstep(clamp01((t - start) / ARM_TIME));
  }

  private postureAt(t: number): PostureWeights {
    const { from, to, start } = this.posture;
    const k = smoothstep(clamp01((t - start) / POSTURE_TIME));
    return { sit: from.sit + (to.sit - from.sit) * k, squat: from.squat + (to.squat - from.squat) * k };
  }

  /** Posture taken from time t (eased); sitting or squatting stops the walk first. */
  setPosture(posture: Posture, t: number) {
    this.postureRequest = posture;
    const to = POSTURES[posture];
    if (to === this.posture.to) return;
    let start = Math.max(t, this.notBefore);
    if (posture !== "standing") {
      this.setWalking(false, t);
      if (this.walk) start = Math.max(start, this.walk.stop + BLEND);
    }
    this.posture = { from: this.postureAt(t), to, start };
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
      // Stand up first.
      if (this.posture.to !== POSTURES.standing) this.setPosture("standing", t);
      const standing = this.posture.from === this.posture.to ? -Infinity : this.posture.start + POSTURE_TIME;
      const start = Math.max(t, this.notBefore, this.turnEnd, standing);
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
      (this.arms.from !== this.arms.to && t > this.arms.start && t < this.arms.start + ARM_TIME) ||
      (this.posture.from !== this.posture.to && t > this.posture.start && t < this.posture.start + POSTURE_TIME) ||
      this.handsMoving(t)
    );
  }

  /** Whether a motion is under way or scheduled at time t or later. */
  pending(t: number): boolean {
    return (
      (!!this.walk && t < this.walk.stop + BLEND) ||
      (!!this.turn && t < this.turnEnd) ||
      (this.arms.from !== this.arms.to && t < this.arms.start + ARM_TIME) ||
      (this.posture.from !== this.posture.to && t < this.posture.start + POSTURE_TIME) ||
      (["L", "R"] as const).some((side) => !!this.hands[side] && t < this.hands[side]!.start + this.hands[side]!.time)
    );
  }

  /**
   * Bone transforms at time t into `out`, from the standing pose (see the header: they apply
   * to `standingBody`). Returns false (identity transforms) when the body stands still.
   */
  sample(t: number, out: Float32Array): boolean {
    const s = this.skel;
    const adduction = this.armAdduction(t);
    const driven = { L: this.wristTarget("L", t), R: this.wristTarget("R", t) };
    const posture = this.postureAt(t);
    const held = posture.sit + posture.squat;
    if (!this.moving(t) && adduction === this.arms.to && !driven.L && !driven.R && held === 0) {
      identityBones(s.count, out);
      return false;
    }
    const rot: (Mat3 | null)[] = new Array(s.count).fill(null);
    const set = (label: string, r: Mat3) => {
      const i = s.index[label];
      if (i !== undefined) rot[i] = rot[i] ? mul3(r, rot[i]!) : r;
    };

    const level = t > (this.walk?.rampStart ?? Infinity) ? smoothstep(this.walkLevel(t)) : 0;
    // Arms lowered from the rest pose: elbows relaxed in proportion (none when raised).
    const lowest = (this.restArmSpread - ARM_SPREAD) * DEG;
    const relax = lowest > 0 ? ELBOW_RELAX * clamp01(adduction / lowest) : 0;
    let offset: Vec3 | null = null;
    let ground: Pose["ground"] = null;
    if (level > 0) {
      const w = this.walk!;
      const phase = w.phase0 + (t - w.time0) / this.period;
      const c = Math.cos(2 * Math.PI * phase), sn = Math.sin(2 * Math.PI * phase);
      // Walk (0) to run (1): every parameter of the gait is blended (see RUN).
      const run = this.runAt(t);
      const mix = (a: number, b: number) => a + (b - a) * run;
      const stance = mix(STANCE, RUN.stance);
      const strike = mix(PITCH.strike, RUN.strike), toeOff = mix(PITCH.toeOff, RUN.toeOff);
      const k = level * this.strideAt(t) * DEG;
      // Pelvis: rotation (swing side forward) and list (swing side drops); thorax counter-rotates.
      // The list is the pelvis's alone: the lumbar spine and the hips cancel it, so that the
      // thorax stays upright and the legs vertical (inheriting it, the feet slid sideways on the
      // floor and the torso swayed over them, away from the stance foot). The hips cancel the
      // rotation of the pelvis too: the feet keep pointing forward and stay put.
      const yaw = -4 * c * k, list = 3 * sn * k * (1 - 0.5 * run);
      const pelvis = mul3(rotY(yaw), rotZ(list));
      set("root", pelvis);
      for (const b of SPINE) set(b, rotY((7 * c * k) / SPINE.length));
      for (const [b, share] of LIST_SPINE) set(b, rotZ(-share * list));
      if (run > 0) set("spine05", rotX(RUN.lean * DEG * run * level));
      // Weight shift: the body moves over the stance foot (left at its mid-stance, phase 0.3),
      // the feet staying where they are on the floor. A runner's feet land under the body instead.
      const shift = SWAY * level * (1 - run) * Math.sin(2 * Math.PI * (phase - 0.05));
      const root = s.head("root");
      // Pelvis drop at heel strike, so that the front leg reaches the floor.
      const stride = STRIDE * this.strideAt(t) * mix(1, RUN.stride) * level;
      const reachShare = 1 - (1 - mix(REACH, RUN.reach)) * level;
      let drop = 0;
      for (const leg of [this.legs.L, this.legs.R]) {
        const [ty, tz] = this.ankleTarget(leg, stride / 2, 0, strike * level * DEG, 0, level);
        // Faded in with the walk: at full reach from the start, the pelvis dropped ~1 cm and the
        // knees bent within a single substep as the walk began (the rest pose's legs are straight),
        // and that jolt threw the garment off the body.
        const reach = reachShare * (Math.hypot(...leg.thigh) + Math.hypot(...leg.shank));
        if (Math.hypot(ty, tz) > reach) drop = Math.max(drop, -ty - Math.sqrt(Math.max(0, reach * reach - tz * tz)));
      }
      // Height of the pelvis below rest, over a step (0 at each foot strike). Walking: lowest at
      // the strikes, highest at mid-stance. Running: at `drop` when a foot strikes and when it
      // leaves, lower at mid-stance (bent knee), higher in flight. Applied as the floor rising
      // under the feet (the grounding then lowers the body onto the stance foot) and, for the
      // flight, when no foot carries the body, as the body's own height.
      const step = 2 * phase - Math.floor(2 * phase);
      // Share of a step with a foot on the floor; the rest is flight (none above half a cycle of
      // stance: the hop grows with the flight).
      const share = Math.min(1, 2 * stance);
      const hop = RUN.hop * clamp01((0.5 - stance) / (0.5 - RUN.stance));
      const walkDip = drop * (0.5 + 0.5 * Math.cos(2 * Math.PI * step));
      const runDip =
        step < share
          ? drop + RUN.dip * level * Math.sin((Math.PI * step) / share) ** 2
          : drop - hop * level * Math.sin((Math.PI * (step - share)) / (1 - share)) ** 2;
      const floor = mix(walkDip, runDip);
      offset = [shift, -floor, 0];
      const halfWidth = mix(STEP_HALF_WIDTH, RUN.halfWidth);
      for (const [side, p, sign] of [["L", phase, 1], ["R", phase + 0.5, -1]] as const) {
        const leg = this.legs[side];
        const f = footPath(p, stance, strike, toeOff);
        const pitch = f.pitch * level * DEG;
        const [ty, tz] = this.ankleTarget(leg, f.z * stride, f.lift * mix(CLEARANCE, RUN.clearance) * level, pitch, floor, level);
        // Hip displacement by the pelvis (the list raises the stance hip and lowers the swing one).
        const r = [leg.hip[0] - root[0], leg.hip[1] - root[1], leg.hip[2] - root[2]];
        const d = [0, 1, 2].map((i) => pelvis[3 * i] * r[0] + pelvis[3 * i + 1] * r[1] + pelvis[3 * i + 2] * r[2] - r[i]);
        const hy = ty - d[1];
        const [hip, knee] = legIK(leg, hy, tz - d[2], level);
        // Thigh flexed in the sagittal plane, then brought in — the rest pose stands with its feet
        // far apart, a step is narrow: the ankle comes `halfWidth` from the mid-plane — and tilted
        // against the weight shift (the ankle, |hy| below the hip, stays put); the rotation of the
        // pelvis cancelled.
        const adduction = leg.out + Math.asin(Math.min(1, Math.max(-1, (leg.hipX - halfWidth) / leg.length)));
        const roll = -sign * adduction * level - Math.asin((shift + d[0]) / Math.max(0.1, -hy));
        set(`upperleg01.${side}`, mul3(rotZ(-list), mul3(rotY(-yaw), mul3(rotZ(roll), rotX(hip)))));
        set(`lowerleg01.${side}`, rotX(knee));
        // Pitch only: the sole stays flat across (no roll from the thigh).
        set(`foot.${side}`, mul3(rotX(-hip - knee), mul3(rotZ(-roll), rotX(-pitch))));
        // The arm swings with the opposite leg (swing > 0: arm forward, elbow a little more bent);
        // the elbow straightens from the rest pose, whose forearms point forward — or bends, running.
        const swing = -Math.cos(2 * Math.PI * p);
        set(`upperarm01.${side}`, rotX(-(2 + mix(14, RUN.armSwing) * swing) * k));
        // Straightened by the larger of the walk's and the lowered arms' extension (the latter below).
        set(
          `lowerarm01.${side}`,
          axisAngle(this.elbowAxes[side], (6 + 5 * swing) * k + RUN.elbow * DEG * run * level - Math.max(0, ELBOW_EXTENSION * level * (1 - run) - relax)),
        );
      }
      ground = { "foot.L": stanceWeight(phase, stance), "foot.R": stanceWeight(phase + 0.5, stance) };
    }

    // Held poses (never while walking: each waits for the other to fade out): the ankles are
    // put where the pose wants them from the hips, by the same leg inverse kinematics; the feet
    // stay flat on the floor and carry the body.
    if (held > 0 && level === 0) {
      for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
        const leg = this.legs[side];
        const thigh = Math.hypot(...leg.thigh), shank = Math.hypot(...leg.shank);
        const restY = leg.ankle[1] - leg.hip[1], restZ = leg.ankle[2] - leg.hip[2];
        const ty = restY + posture.sit * (-SIT.shin * shank - restY) + posture.squat * (-SQUAT.height * (thigh + shank) - restY);
        const tz = restZ + posture.sit * (SIT.thigh * thigh - restZ) + posture.squat * (SQUAT.forward * (thigh + shank) - restZ);
        const [hip, knee] = legIK(leg, ty, tz);
        // Legs parallel (the rest pose's lean out).
        const roll = -sign * leg.out * held;
        set(`upperleg01.${side}`, mul3(rotZ(roll), rotX(hip)));
        set(`lowerleg01.${side}`, rotX(knee));
        set(`foot.${side}`, mul3(rotX(-hip - knee), rotZ(-roll)));
        set(`upperarm01.${side}`, rotX(-(SIT.arms * posture.sit + SQUAT.arms * posture.squat) * DEG));
      }
      set("spine05", rotX((SIT.lean * posture.sit + SQUAT.lean * posture.squat) * DEG));
      offset = [0, 0, -(SIT.back * posture.sit + SQUAT.back * posture.squat) * Math.hypot(...this.legs.L.thigh)];
      ground = { "foot.L": 1, "foot.R": 1 };
    }

    // Arm spread, before the swing (rotation about Z: towards the body).
    this.lowerArms(rot, adduction);

    // Driven hands: inverse kinematics replaces the spread and the swing of that arm.
    for (const side of ["L", "R"] as const) {
      const target = driven[side];
      if (!target) continue;
      const S = s.head(`upperarm01.${side}`), E = s.head(`lowerarm01.${side}`), W = s.head(`wrist.${side}`);
      const { upper, fore } = armIK(S, E, W, target, restPole(S, E, W));
      const iu = s.index[`upperarm01.${side}`], il = s.index[`lowerarm01.${side}`];
      if (iu !== undefined) rot[iu] = upper;
      if (il !== undefined) rot[il] = fore;
    }

    if (this.turn && t > this.turn.start && t < this.turnEnd)
      set("root", rotY(2 * Math.PI * smootherstep((t - this.turn.start) / TURN_TIME)));

    // From the rest pose (the skeleton's), brought back to the standing pose.
    composeBones(s.pose({ rotations: rot, ground, offset }, out), this.fromStanding);
    return true;
  }
}

/**
 * The body as it stands (see the header): the vertices, normals and joints of the morphology's
 * rest pose brought to the standing pose — what the animator's bone transforms apply to, what
 * is shown when the mannequin stands still, and what the cloth is placed around and collides with.
 */
export function standingBody(
  animator: Animator,
  rest: { positions: Float32Array; normals: Float32Array; joints: Record<string, Vec3> },
  skin: SkinWeights,
): { positions: Float32Array; normals: Float32Array; joints: Record<string, Vec3> } {
  const bones = animator.standing;
  const positions = new Float32Array(rest.positions.length), normals = new Float32Array(rest.normals.length);
  skinVertices(rest.positions, rest.normals, skin, bones, positions, normals);
  const joints = { ...rest.joints };
  animator.skeleton.labels.forEach((label, k) => {
    const [x, y, z] = rest.joints[label], o = k * BONE_STRIDE;
    joints[label] = [0, 1, 2].map((r) => bones[o + 4 * r] * x + bones[o + 4 * r + 1] * y + bones[o + 4 * r + 2] * z + bones[o + 4 * r + 3]) as Vec3;
  });
  return { positions, normals, joints };
}
