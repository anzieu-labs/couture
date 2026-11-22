import type { SkinWeights } from "./anny";

/**
 * Animation rig of the mannequin: the key joints of Anny's skeleton
 * (tools/mannequin/export.py merges the skin weights of every other bone —
 * fingers, toes, twist bones — into them), forward kinematics and linear blend
 * skinning.
 *
 * Joint rotations are expressed in the rest pose's world axes (X: the
 * mannequin's left, Y: up, Z: front) about each joint's rest position, so the
 * rig only needs the joint positions of the current morphology.
 *
 * Bone transforms are 3×4 affine matrices, row-major, BONE_STRIDE floats per
 * bone: a point rigidly attached to bone k moves from x (rest) to B_k·x.
 * Shared by the viewer (rendering), the CPU solver (worker) and the GPU solver.
 */

export type Vec3 = [number, number, number];
/** 3×3 rotation, row-major. */
export type Mat3 = Float64Array;

export const BONE_STRIDE = 12;

export interface Pose {
  /** Rotation of each joint about its rest position (rest-world axes); null: none. */
  rotations: (Mat3 | null)[];
  /**
   * Lifts or lowers the body so that the soles of the feet carrying it stay at
   * rest height (walking in place): weight of each foot ("foot.L", "foot.R");
   * null: no grounding. Weights summing to less than 1 ground the body only that much (flight).
   */
  ground: Partial<Record<string, number>> | null;
  /** Translation of the whole body (m), e.g. the lateral weight shift of the walk; applied before grounding. */
  offset?: Vec3 | null;
}

// --- Rotations -------------------------------------------------------------------

export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return Float64Array.of(
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  );
}

export const rotX = (a: number) => axisAngle([1, 0, 0], a);
export const rotY = (a: number) => axisAngle([0, 1, 0], a);
export const rotZ = (a: number) => axisAngle([0, 0, 1], a);

/** a·b: applies b first. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return o;
}

/** Identity transforms for `count` bones. */
export function identityBones(count: number, out: Float32Array = new Float32Array(count * BONE_STRIDE)): Float32Array {
  out.fill(0);
  for (let k = 0; k < count; k++) {
    const o = k * BONE_STRIDE;
    out[o] = out[o + 5] = out[o + 10] = 1;
  }
  return out;
}

// --- Skeleton ----------------------------------------------------------------------

export class Skeleton {
  readonly count: number;
  readonly index: Record<string, number>;
  /** Rest joint positions, 3 per bone. */
  readonly heads: Float64Array;
  /** Parents before children. */
  private readonly order: number[];
  /** Heel, toe, inner and outer edge of each foot (rest positions), for grounding. */
  readonly soles: { label: string; bone: number; points: Vec3[] }[] = [];
  /** Height of the floor under the rest pose (lowest sole point). */
  readonly soleHeight: number;
  private readonly world: Float64Array;

  constructor(
    readonly labels: string[],
    readonly parents: number[],
    joints: Record<string, Vec3>,
    positions: Float32Array,
    skin: SkinWeights,
  ) {
    const n = (this.count = labels.length);
    this.index = Object.fromEntries(labels.map((l, i) => [l, i]));
    this.heads = new Float64Array(3 * n);
    labels.forEach((l, i) => this.heads.set(joints[l], 3 * i));
    const depth = (k: number): number => (parents[k] < 0 ? 0 : 1 + depth(parents[k]));
    this.order = labels.map((_, i) => i).sort((a, b) => depth(a) - depth(b));
    this.world = new Float64Array(n * BONE_STRIDE);

    // Sole: the lowest vertices mostly driven by each foot bone.
    let soleHeight = Infinity;
    for (const label of ["foot.L", "foot.R"]) {
      const bone = this.index[label];
      if (bone === undefined) continue;
      const verts: number[] = [];
      let lo = Infinity;
      for (let v = 0; v < positions.length / 3; v++) {
        if (skin.index[4 * v] !== bone || skin.weight[4 * v] < 128) continue;
        verts.push(v);
        lo = Math.min(lo, positions[3 * v + 1]);
      }
      const sole = verts.filter((v) => positions[3 * v + 1] < lo + 0.01);
      if (!sole.length) continue;
      const pick = (axis: number, sign: number) =>
        sole.reduce((best, v) => (sign * positions[3 * v + axis] > sign * positions[3 * best + axis] ? v : best));
      const points = [pick(2, -1), pick(2, 1), pick(0, -1), pick(0, 1)].map(
        (v): Vec3 => [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]],
      );
      this.soles.push({ label, bone, points });
      soleHeight = Math.min(soleHeight, ...points.map((p) => p[1]));
    }
    this.soleHeight = soleHeight;
  }

  head(label: string): Vec3 {
    const i = this.index[label];
    return [this.heads[3 * i], this.heads[3 * i + 1], this.heads[3 * i + 2]];
  }

  /** Bone transforms of a pose (forward kinematics), written into `out` (float32). */
  pose(pose: Pose, out: Float32Array): Float32Array {
    const { world: W, heads: H, parents } = this;
    for (const k of this.order) {
      const R = pose.rotations[k];
      const o = k * BONE_STRIDE;
      const hx = H[3 * k], hy = H[3 * k + 1], hz = H[3 * k + 2];
      // Local: rotation about the rest head, [R | h − R·h].
      const l = new Float64Array(BONE_STRIDE);
      if (R) {
        for (let i = 0; i < 3; i++) {
          l[4 * i] = R[3 * i]; l[4 * i + 1] = R[3 * i + 1]; l[4 * i + 2] = R[3 * i + 2];
          l[4 * i + 3] = H[3 * k + i] - (R[3 * i] * hx + R[3 * i + 1] * hy + R[3 * i + 2] * hz);
        }
      } else {
        l[0] = l[5] = l[10] = 1;
      }
      const p = parents[k];
      if (p < 0) {
        W.set(l, o);
        continue;
      }
      // World = parent ∘ local.
      const q = p * BONE_STRIDE;
      for (let i = 0; i < 3; i++) {
        const a0 = W[q + 4 * i], a1 = W[q + 4 * i + 1], a2 = W[q + 4 * i + 2];
        for (let j = 0; j < 4; j++) W[o + 4 * i + j] = a0 * l[j] + a1 * l[4 + j] + a2 * l[8 + j];
        W[o + 4 * i + 3] += W[q + 4 * i + 3];
      }
    }
    if (pose.offset)
      for (let k = 0; k < this.count; k++)
        for (let i = 0; i < 3; i++) W[k * BONE_STRIDE + 4 * i + 3] += pose.offset[i];
    if (pose.ground) {
      // Weighted mean of the lifts that put each carrying foot's lowest sole point on the floor.
      let lift = 0, total = 0;
      for (const { label, bone, points } of this.soles) {
        const w = pose.ground[label] ?? 0;
        if (w <= 0) continue;
        const o = bone * BONE_STRIDE;
        let lo = Infinity;
        for (const [x, y, z] of points) lo = Math.min(lo, W[o + 4] * x + W[o + 5] * y + W[o + 6] * z + W[o + 7]);
        lift += w * (this.soleHeight - lo);
        total += w;
      }
      // Fades with the total weight below 1: as a runner's foot leaves or meets the floor the
      // correction comes and goes smoothly, instead of the whole body jumping by what was left of it.
      if (total > 0) for (let k = 0; k < this.count; k++) W[k * BONE_STRIDE + 7] += (lift / total) * Math.min(1, total);
    }
    for (let i = 0; i < W.length; i++) out[i] = W[i];
    return out;
  }
}

// --- Skinning ----------------------------------------------------------------------

/**
 * Linear blend skinning of positions and normals (normals use the blended
 * linear part, renormalized).
 */
export function skinVertices(
  rest: Float32Array,
  restNormals: Float32Array,
  skin: SkinWeights,
  bones: Float32Array,
  out: Float32Array,
  outNormals: Float32Array,
) {
  const m = new Float64Array(BONE_STRIDE);
  for (let v = 0, n = rest.length / 3; v < n; v++) {
    m.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = skin.weight[4 * v + k] / 255;
      if (!w) continue;
      const o = skin.index[4 * v + k] * BONE_STRIDE;
      for (let e = 0; e < BONE_STRIDE; e++) m[e] += w * bones[o + e];
    }
    const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
    out[3 * v] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[3 * v + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[3 * v + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    const a = restNormals[3 * v], b = restNormals[3 * v + 1], c = restNormals[3 * v + 2];
    const nx = m[0] * a + m[1] * b + m[2] * c, ny = m[4] * a + m[5] * b + m[6] * c, nz = m[8] * a + m[9] * b + m[10] * c;
    const l = Math.hypot(nx, ny, nz) || 1;
    outNormals[3 * v] = nx / l;
    outNormals[3 * v + 1] = ny / l;
    outNormals[3 * v + 2] = nz / l;
  }
}
