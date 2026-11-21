import { axisAngle, type Mat3, type Vec3 } from "./skeleton";

/**
 * Two-bone inverse kinematics of an arm (shoulder S, elbow E, wrist W at rest):
 * the rotations of the upper arm (about S) and of the forearm (about E), in the
 * rest pose's axes (skeleton.ts convention: world = parent ∘ local), that bring
 * the wrist to a target T expressed in the same frame.
 *
 * The elbow bends towards `pole` (a direction, e.g. where the elbow sits at rest
 * relative to the shoulder–wrist line: slightly back and out), so the arm keeps
 * a natural posture. Out-of-reach targets are brought onto the reachable shell.
 * At T = W with the rest pole, both rotations are the identity.
 */

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

/** Any unit vector perpendicular to u. */
function perpendicular(u: Vec3): Vec3 {
  const c = cross(u, Math.abs(u[2]) < 0.9 ? [0, 0, -1] : [1, 0, 0]);
  return unit(c);
}

/** Rotation (row-major) taking the orthonormal frame (a0, b0, c0) onto (a1, b1, c1). */
function frameRotation(a0: Vec3, b0: Vec3, c0: Vec3, a1: Vec3, b1: Vec3, c1: Vec3): Mat3 {
  const m = new Float64Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[3 * r + c] = a1[r] * a0[c] + b1[r] * b0[c] + c1[r] * c0[c];
  return m;
}

/** Where the elbow sits at rest relative to the shoulder–wrist line (unit vector). */
export function restPole(S: Vec3, E: Vec3, W: Vec3): Vec3 {
  const u = unit(sub(W, S));
  const e = sub(E, S);
  const p = sub(e, scale(u, dot(e, u)));
  return len(p) > 1e-6 ? unit(p) : perpendicular(u);
}

export function armIK(S: Vec3, E: Vec3, W: Vec3, T: Vec3, pole: Vec3): { upper: Mat3; fore: Mat3 } {
  const a = len(sub(E, S)), b = len(sub(W, E));
  const toT = sub(T, S);
  const u = len(toT) > 1e-6 ? unit(toT) : unit(sub(W, S));
  // Reachable distance (a hair short of full extension keeps the bend plane defined).
  const d = Math.min(Math.max(len(toT), Math.abs(a - b) + 1e-3), a + b - 1e-4);
  let v = sub(pole, scale(u, dot(pole, u)));
  v = len(v) > 1e-6 ? unit(v) : perpendicular(u);
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);

  // Target posture: upper arm direction u1, bend plane normal n1 (= v × u, also when straight).
  const u1: Vec3 = [cosA * u[0] + sinA * v[0], cosA * u[1] + sinA * v[1], cosA * u[2] + sinA * v[2]];
  const n1 = unit(cross(v, u));
  const w1 = cross(u1, n1);
  const E1: Vec3 = [S[0] + a * u1[0], S[1] + a * u1[1], S[2] + a * u1[2]];
  const W1: Vec3 = [S[0] + d * u[0], S[1] + d * u[1], S[2] + d * u[2]];
  const f1 = unit(sub(W1, E1));

  // Rest posture: same construction from the rest joints.
  const u0 = unit(sub(E, S)), f0 = unit(sub(W, E));
  let n0 = cross(u0, f0);
  n0 = len(n0) > 1e-6 ? unit(n0) : unit(cross(restPole(S, E, W), u0));
  const w0 = cross(u0, n0);

  // Upper arm: rest frame onto target frame (aligns the bend planes, no extra twist).
  const upper = frameRotation(u0, n0, w0, u1, n1, w1);
  // Forearm, in the rest axes (its parent's rotation comes on top): about the hinge n0,
  // from f0 to upperᵀ·f1.
  const g: Vec3 = [
    upper[0] * f1[0] + upper[3] * f1[1] + upper[6] * f1[2],
    upper[1] * f1[0] + upper[4] * f1[1] + upper[7] * f1[2],
    upper[2] * f1[0] + upper[5] * f1[1] + upper[8] * f1[2],
  ];
  const angle = Math.atan2(dot(cross(f0, g), n0), dot(f0, g));
  return { upper, fore: axisAngle(n0, angle) };
}
