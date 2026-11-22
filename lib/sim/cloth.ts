import { BONE_STRIDE } from "../avatar/skeleton";
import { LIMB_STRIDE, type BodySdf } from "./bodySdf";
import { GRAB, selfInterval, solveGrab, type GrabPatch } from "./grab";
import { assembling, bandLimit, BELT, PLINTH, substepState, sweepPlan, type ClothModel, type Sweep } from "./model";
import { applyAffine, applyInverse, blendAt, IMPACT_MARGIN, IMPACT_SPEED, POSE_TOLERANCE } from "./posedBody";
import { bindTethers, TETHER_STRIDE } from "./tether";
import { SelfCollider, UNTANGLE_INTERVAL } from "./selfCollision";
import { findTangles } from "./untangle";

/**
 * Body pose at a simulated time: writes the bone transforms into `out`, from the pose the
 * collision field was built in (the standing pose: avatar/motion.ts), and returns false when
 * the body is in that pose.
 */
export type PoseAt = (time: number, out: Float32Array) => boolean;


/** Squared distance from the point (x, y, z) to the segment whose ends are at `a` and `b` in `ends`. */
function toSegment2(x: number, y: number, z: number, ends: ArrayLike<number>, a: number, b: number): number {
  const ex = ends[b] - ends[a], ey = ends[b + 1] - ends[a + 1], ez = ends[b + 2] - ends[a + 2];
  const px = x - ends[a], py = y - ends[a + 1], pz = z - ends[a + 2];
  const l2 = ex * ex + ey * ey + ez * ez;
  const t = l2 > 0 ? Math.min(1, Math.max(0, (px * ex + py * ey + pz * ez) / l2)) : 0;
  const dx = px - t * ex, dy = py - t * ey, dz = pz - t * ez;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Reference CPU implementation of the XPBD solver ("small steps": many
 * substeps; symmetric Gauss-Seidel over the colour-sorted constraints).
 * Used when WebGPU is unavailable, and as the ground truth for the GPU solver.
 */
export class CpuClothSolver {
  readonly pos: Float32Array;
  time = 0;
  private readonly prev: Float32Array;
  private readonly vel: Float32Array;
  private readonly edgeLambda: Float32Array;
  private readonly bendLambda: Float32Array;
  private readonly grad = new Float32Array(3);
  /** Position of each vertex in the collision field's pose at the end of the last substep (animated body). */
  private readonly restPos: Float32Array;
  private readonly blend = new Float64Array(12);
  private readonly blend0 = new Float64Array(12);
  /** Scratch: a limb's bone transform, and the blended transform of the deepest limb contact. */
  private readonly limbBone = new Float64Array(12);
  private readonly limbBlend = new Float64Array(12);
  /** Scratch: the two ends of each limb's capsule as posed (6 per limb). */
  private readonly limbEnds: Float64Array;
  private readonly q = new Float64Array(3);
  private readonly q0 = new Float64Array(3);
  /** Current bone transforms (when posed). */
  readonly bones: Float32Array | null;
  private readonly self: SelfCollider | null;
  private untangledAt = -Infinity;
  private readonly sweeps: { assembling: Sweep[][]; draping: Sweep[][] };
  /** The cloth held by hand (grab.ts): the patch, and where the hand goes during the next step. */
  private grab: { patch: GrabPatch; from: [number, number, number]; to: [number, number, number] } | null = null;
  /** Simulated time until which the cloth let go is still falling back. */
  private heldUntil = -Infinity;

  /** `initial`: where the cloth starts, around the body the collision field `sdf` was built from. */
  constructor(private readonly m: ClothModel, initial: Float32Array, private readonly sdf: BodySdf, boneCount = 0) {
    this.pos = Float32Array.from(initial);
    this.prev = Float32Array.from(initial);
    this.restPos = Float32Array.from(initial);
    this.bones = sdf.skin && boneCount ? new Float32Array(12 * boneCount) : null;
    this.limbEnds = new Float64Array((6 * sdf.limbs.length) / LIMB_STRIDE);
    this.self = m.self ? new SelfCollider(m.self, m.triangles, initial) : null;
    this.vel = new Float32Array(initial.length);
    this.edgeLambda = new Float32Array(m.edgeRest.length);
    this.bendLambda = new Float32Array(m.bendCompliance.length * 3);
    this.sweeps = {
      assembling: [sweepPlan(m.params, 0, true), sweepPlan(m.params, 1, true)],
      draping: [sweepPlan(m.params, 0, false), sweepPlan(m.params, 1, false)],
    };
  }

  /** Takes hold of the cloth by `patch` (grab.ts), the hand at `target`; null lets go. */
  setGrab(patch: GrabPatch | null, target: readonly [number, number, number] = [0, 0, 0]) {
    if (this.grab && !patch) this.heldUntil = this.time + GRAB.settle;
    this.grab = patch && { patch, from: [...target], to: [...target] };
  }

  /** Moves the hand: it gets there during the next step. */
  moveGrab(target: readonly [number, number, number]) {
    if (this.grab) this.grab.to = [...target];
  }

  /** Motion mode's tethers (tether.ts), as bound by bind(); whether they hold the cloth. */
  private tethers: Float32Array | null = null;
  tethered = false;

  /** Fastens the garment as it hangs now to the skeleton (tether.ts): to be called while the body stands still. */
  bind() {
    const p = this.m.params;
    this.tethers = bindTethers(this.m, this.pos, this.sdf, p.skinGap + p.thickness / 2);
  }

  /** Whether the garment has been fastened to the skeleton. */
  get bound(): boolean {
    return !!this.tethers;
  }

  /** Each vertex kept within its reach of its support, where the bones take it (tether.ts). */
  private solveTethers(posed: boolean) {
    const { pos, sdf, blend: M } = this;
    const T = this.tethers!, invMass = this.m.invMass;
    const a = this.q;
    for (let i = 0, o = 0; o < T.length; i++, o += TETHER_STRIDE) {
      const reach = T[o + 3];
      if (reach < 0 || !invMass[i]) continue;
      if (posed) {
        blendAt(sdf, this.bones!, T[o + 4], T[o + 5], T[o + 6], M);
        applyAffine(M, T[o], T[o + 1], T[o + 2], a);
      } else {
        a[0] = T[o]; a[1] = T[o + 1]; a[2] = T[o + 2];
      }
      const dx = pos[3 * i] - a[0], dy = pos[3 * i + 1] - a[1], dz = pos[3 * i + 2] - a[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= reach) continue;
      const k = reach / d;
      pos[3 * i] = a[0] + dx * k; pos[3 * i + 1] = a[1] + dy * k; pos[3 * i + 2] = a[2] + dz * k;
    }
  }

  /** Advances `dt` seconds; `poseAt` animates the body (bone transforms at each substep). */
  step(dt: number, poseAt?: PoseAt) {
    const { m, pos, prev, vel, grab } = this;
    const p = m.params, invMass = m.invMass;
    const h = dt / p.substeps;
    const damp = Math.exp(-p.damping * h);
    const plans = assembling(p, this.time) ? this.sweeps.assembling : this.sweeps.draping;
    const selfEvery = selfInterval(p, !!grab || this.time < this.heldUntil);
    for (let s = 0; s < p.substeps; s++) {
      const { gravity, sewK, sewing, selfActive, claspGoal } = substepState(p, this.time);
      const posed = !!(poseAt && this.bones && poseAt(this.time + h, this.bones));
      for (let i = 0; i < m.vertexCount; i++) {
        if (!invMass[i]) continue;
        vel[3 * i + 1] += gravity * h;
        for (let a = 0; a < 3; a++) {
          prev[3 * i + a] = pos[3 * i + a];
          pos[3 * i + a] += vel[3 * i + a] * damp * h;
        }
      }
      if (grab) {
        // An external force: applied to the predicted positions, the hand moving evenly over the step.
        const k = (s + 1) / p.substeps, { from, to } = grab;
        solveGrab(pos, grab.patch, from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k, h);
      }
      this.edgeLambda.fill(0);
      this.bendLambda.fill(0);
      // Symmetric Gauss-Seidel: sweeps alternately forward and backward (see sweepPlan).
      for (const { reverse, bending } of plans[s & 1]) {
        this.solveStretch(h, reverse);
        if (bending) this.solveBending(h, reverse);
        this.solveSeams(sewK, claspGoal, reverse);
      }
      this.solveBands(this.time);
      // Motion mode (tether.ts): the cloth held by its tethers to the skeleton, no self-collision.
      const tethered = this.tethered && !!this.tethers;
      if (tethered) this.solveTethers(posed);
      else if (this.self && (s + 1) % selfEvery === 0) {
        if (selfActive && this.time - this.untangledAt >= UNTANGLE_INTERVAL) {
          this.untangledAt = this.time;
          findTangles(pos, m.triangles, m.self!, this.self.tangle);
        }
        this.self.solve(pos, invMass, selfActive);
      }
      this.solveContacts(sewing, posed, h);
      for (let i = 0; i < pos.length; i++) vel[i] = (pos[i] - prev[i]) / h;
      this.time += h;
    }
    if (grab) grab.from = grab.to;
  }

  private solveStretch(h: number, reverse: boolean) {
    const { pos, edgeLambda } = this;
    const { invMass, edges, edgeRest, edgeCompliance } = this.m;
    const ih2 = 1 / (h * h);
    const n = edgeRest.length;
    for (let it = 0; it < n; it++) {
      const c = reverse ? n - 1 - it : it;
      const a = edges[2 * c], b = edges[2 * c + 1];
      const wa = invMass[a], wb = invMass[b], w = wa + wb;
      if (!w) continue;
      const dx = pos[3 * a] - pos[3 * b], dy = pos[3 * a + 1] - pos[3 * b + 1], dz = pos[3 * a + 2] - pos[3 * b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const alpha = edgeCompliance[c] * ih2;
      const dl = (-(len - edgeRest[c]) - alpha * edgeLambda[c]) / (w + alpha);
      edgeLambda[c] += dl;
      const sx = (dx / len) * dl, sy = (dy / len) * dl, sz = (dz / len) * dl;
      pos[3 * a] += sx * wa; pos[3 * a + 1] += sy * wa; pos[3 * a + 2] += sz * wa;
      pos[3 * b] -= sx * wb; pos[3 * b + 1] -= sy * wb; pos[3 * b + 2] -= sz * wb;
    }
  }

  private solveBending(h: number, reverse: boolean) {
    const { pos, bendLambda } = this;
    const { invMass, bendIdx, bendK, bendCompliance } = this.m;
    const ih2 = 1 / (h * h);
    const n = bendCompliance.length;
    for (let it = 0; it < n; it++) {
      const c = reverse ? n - 1 - it : it;
      const o = 4 * c;
      const v0 = bendIdx[o], v1 = bendIdx[o + 1], v2 = bendIdx[o + 2], v3 = bendIdx[o + 3];
      const k0 = bendK[o], k1 = bendK[o + 1], k2 = bendK[o + 2], k3 = bendK[o + 3];
      const w0 = invMass[v0], w1 = invMass[v1], w2 = invMass[v2], w3 = invMass[v3];
      const alpha = bendCompliance[c] * ih2;
      const denom = w0 * k0 * k0 + w1 * k1 * k1 + w2 * k2 * k2 + w3 * k3 * k3 + alpha;
      // Linear and separable per axis: C_axis = Σ K_i x_i[axis].
      for (let a = 0; a < 3; a++) {
        const C = k0 * pos[3 * v0 + a] + k1 * pos[3 * v1 + a] + k2 * pos[3 * v2 + a] + k3 * pos[3 * v3 + a];
        const li = 3 * c + a;
        const dl = (-C - alpha * bendLambda[li]) / denom;
        bendLambda[li] += dl;
        pos[3 * v0 + a] += w0 * k0 * dl;
        pos[3 * v1 + a] += w1 * k1 * dl;
        pos[3 * v2 + a] += w2 * k2 * dl;
        pos[3 * v3 + a] += w3 * k3 * dl;
      }
    }
  }

  /** Bands (model.ts BandModel): a band longer than its rest length is scaled down about its centre of mass. */
  /** A belt (model.ts BELT) round the vertices v0…vEnd of the bands' list, no longer than `limit`. */
  private solveBelt(v0: number, vEnd: number, limit: number) {
    const { pos } = this;
    const { invMass, bands } = this.m;
    const K = BELT.sectors, far = this.beltFar, at = this.beltAt;
    let cx = 0, cz = 0, mass = 0;
    for (let k = v0; k < vEnd; k++) {
      const v = bands.vertices[k], w = invMass[v];
      if (!w) continue;
      cx += pos[3 * v] / w; cz += pos[3 * v + 2] / w;
      mass += 1 / w;
    }
    if (!mass) return;
    cx /= mass; cz /= mass;
    far.fill(-1);
    for (let k = v0; k < vEnd; k++) {
      const v = bands.vertices[k], dx = pos[3 * v] - cx, dz = pos[3 * v + 2] - cz;
      const s = Math.min(K - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * K)), r = dx * dx + dz * dz;
      if (r > far[s]) {
        far[s] = r;
        at[s] = v;
      }
    }
    let round = 0, first = -1, last = -1;
    for (let s = 0; s < K; s++) {
      if (far[s] < 0) continue;
      if (last >= 0) round += Math.hypot(pos[3 * at[s]] - pos[3 * last], pos[3 * at[s] + 2] - pos[3 * last + 2]);
      else first = at[s];
      last = at[s];
    }
    if (first < 0) return;
    round += Math.hypot(pos[3 * first] - pos[3 * last], pos[3 * first + 2] - pos[3 * last + 2]);
    if (round <= limit) return; // a belt does not push
    const scale = limit / round;
    for (let k = v0; k < vEnd; k++) {
      const v = bands.vertices[k];
      if (!invMass[v]) continue;
      pos[3 * v] = cx + (pos[3 * v] - cx) * scale;
      pos[3 * v + 2] = cz + (pos[3 * v + 2] - cz) * scale;
    }
  }
  private readonly beltFar = new Float64Array(BELT.sectors);
  private readonly beltAt = new Int32Array(BELT.sectors);

  private solveBands(time: number) {
    const { pos } = this;
    const { invMass, bands, params } = this.m;
    const { ranges, segments, vertices } = bands;
    for (let b = 0; b < bands.rest.length; b++) {
      const limit = bandLimit(bands, b, params, time);
      const seg0 = 2 * ranges[4 * b], segEnd = seg0 + 2 * ranges[4 * b + 1], v0 = ranges[4 * b + 2], vEnd = v0 + ranges[4 * b + 3];
      if (seg0 === segEnd) {
        this.solveBelt(v0, vEnd, limit);
        continue;
      }
      let length = 0;
      for (let k = seg0; k < segEnd; k += 2) {
        const a = 3 * segments[k], c = 3 * segments[k + 1];
        const dx = pos[a] - pos[c], dy = pos[a + 1] - pos[c + 1], dz = pos[a + 2] - pos[c + 2];
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      if (length <= limit) continue; // a band does not push: the fabric may gather along it
      let cx = 0, cy = 0, cz = 0, mass = 0;
      for (let k = v0; k < vEnd; k++) {
        const v = vertices[k], w = invMass[v];
        if (!w) continue;
        cx += pos[3 * v] / w; cy += pos[3 * v + 1] / w; cz += pos[3 * v + 2] / w;
        mass += 1 / w;
      }
      if (!mass) continue;
      cx /= mass; cy /= mass; cz /= mass;
      const scale = limit / length;
      for (let k = v0; k < vEnd; k++) {
        const v = vertices[k];
        if (!invMass[v]) continue;
        pos[3 * v] = cx + (pos[3 * v] - cx) * scale;
        pos[3 * v + 1] = cy + (pos[3 * v + 1] - cy) * scale;
        pos[3 * v + 2] = cz + (pos[3 * v + 2] - cz) * scale;
      }
    }
  }

  private solveSeams(sewK: number, claspGoal: number, reverse: boolean) {
    const { pos } = this;
    const { invMass, seams, seamStart } = this.m;
    const n = seamStart.length;
    for (let it = 0; it < n; it++) {
      const s = reverse ? n - 1 - it : it;
      const a = seams[2 * s], b = seams[2 * s + 1];
      if (a === b) continue;
      const wa = invMass[a], wb = invMass[b], w = wa + wb;
      const dx = pos[3 * a] - pos[3 * b], dy = pos[3 * a + 1] - pos[3 * b + 1], dz = pos[3 * a + 2] - pos[3 * b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // A clasp (negative start) is fastened once the garment is on, and until then opens no further than -start (model.ts CLASP).
      const target = seamStart[s] < 0 ? Math.min(claspGoal, -seamStart[s]) : seamStart[s] * sewK;
      if (len <= target || len < 1e-9 || !w) continue;
      const f = (len - target) / (len * w);
      pos[3 * a] -= dx * f * wa; pos[3 * a + 1] -= dy * f * wa; pos[3 * a + 2] -= dz * f * wa;
      pos[3 * b] += dx * f * wb; pos[3 * b + 1] += dy * f * wb; pos[3 * b + 2] += dz * f * wb;
    }
  }

  /**
   * Body contacts, in rest space when the body is posed (lib/sim/posedBody.ts):
   * restPos holds the rest-space position of `prev`, so friction acts on the
   * motion relative to the skin. Then the floor (model.ts PLINTH).
   */
  private solveContacts(sewing: boolean, posed: boolean, h: number) {
    const { pos, prev, restPos: r, sdf, grad, blend: M, blend0: M0, q, q0 } = this;
    const { params: p, onSeam } = this.m;
    const base = p.skinGap + p.thickness / 2;
    // The limbs' capsules as posed (the limb's bone is rigid): a cheap first test.
    const L = sdf.limbs, LE = this.limbEnds;
    if (posed)
      for (let l = 0; l < L.length; l += LIMB_STRIDE) {
        const o = L[l + 7] * BONE_STRIDE, b = this.bones!, e = (6 * l) / LIMB_STRIDE;
        for (let end = 0; end < 2; end++)
          for (let a = 0; a < 3; a++)
            LE[e + 3 * end + a] = b[o + 4 * a] * L[l + 4 * end] + b[o + 4 * a + 1] * L[l + 4 * end + 1] + b[o + 4 * a + 2] * L[l + 4 * end + 2] + b[o + 4 * a + 3];
      }
    for (let i = 0; i < pos.length; i += 3) {
      let consistent = true;
      if (posed) {
        // Fixed point: weights at the previous rest position, then at the first estimate.
        blendAt(sdf, this.bones!, r[i], r[i + 1], r[i + 2], M0);
        applyInverse(M0, pos[i], pos[i + 1], pos[i + 2], q0);
        blendAt(sdf, this.bones!, q0[0], q0[1], q0[2], M);
        applyInverse(M, pos[i], pos[i + 1], pos[i + 2], q);
        // M·q₀ should land back on p (see posedBody.ts): else free space, no contact.
        const ex = M[0] * q0[0] + M[1] * q0[1] + M[2] * q0[2] + M[3] - pos[i];
        const ey = M[4] * q0[0] + M[5] * q0[1] + M[6] * q0[2] + M[7] - pos[i + 1];
        const ez = M[8] * q0[0] + M[9] * q0[1] + M[10] * q0[2] + M[11] - pos[i + 2];
        consistent = ex * ex + ey * ey + ez * ez < POSE_TOLERANCE * POSE_TOLERANCE;
      } else {
        q[0] = pos[i]; q[1] = pos[i + 1]; q[2] = pos[i + 2];
      }
      let qx = q[0], qy = q[1], qz = q[2];
      // Seam vertices may cross the body while the seams are being closed.
      const free = sewing && onSeam[i / 3];
      const d = !consistent || free ? Infinity : sdf.sample(qx, qy, qz);
      // Impact: cloth moving fast relative to the skin of a limb (posedBody.ts) — 0: none, 1: full.
      // The skin offset then grows with that speed.
      const rel = Math.sqrt((qx - r[i]) ** 2 + (qy - r[i + 1]) ** 2 + (qz - r[i + 2]) ** 2);
      let impact = 0;
      if (posed && rel > IMPACT_SPEED.from * h) {
        for (let l = 0; l < L.length; l += LIMB_STRIDE) {
          if (toSegment2(qx, qy, qz, L, l, l + 4) > L[l + 3] * L[l + 3]) continue;
          const k = Math.min(1, (rel / h - IMPACT_SPEED.from) / (IMPACT_SPEED.to - IMPACT_SPEED.from));
          impact = k * k * (3 - 2 * k);
          break;
        }
      }
      const margin = base + impact * Math.min(IMPACT_MARGIN.max, (IMPACT_MARGIN.time / h) * rel);
      // The margin stops the cloth where it comes in. Cloth already nearer is pushed back out to
      // it by skin that moves fast itself — a runner's forearm —, else only kept from coming
      // nearer still (posedBody.ts IMPACT_MARGIN).
      let offset = base, before = Infinity;
      if (impact > 0) {
        before = sdf.sample(r[i], r[i + 1], r[i + 2]);
        // The skin's own motion over the substep: the cloth's, less its motion relative to the skin.
        const ux = qx - r[i], uy = qy - r[i + 1], uz = qz - r[i + 2];
        const sx = pos[i] - prev[i] - (M[0] * ux + M[1] * uy + M[2] * uz);
        const sy = pos[i + 1] - prev[i + 1] - (M[4] * ux + M[5] * uy + M[6] * uz);
        const sz = pos[i + 2] - prev[i + 2] - (M[8] * ux + M[9] * uy + M[10] * uz);
        const k = Math.min(1, Math.max(0, (Math.sqrt(sx * sx + sy * sy + sz * sz) / h - IMPACT_SPEED.from) / (IMPACT_SPEED.to - IMPACT_SPEED.from)));
        const held = Math.max(base, Math.min(margin, before));
        offset = held + (margin - held) * k * k * (3 - 2 * k);
      }
      if (posed && !free && d >= offset) {
        // No contact where the vertex comes from: a limb swung far from its rest place may still
        // be going through it (posedBody.ts). The deepest one pushes it out.
        const B = this.limbBone, ML = this.limbBlend;
        let deepest = offset, hx = 0, hy = 0, hz = 0;
        for (let l = 0; l < L.length; l += LIMB_STRIDE) {
          const e = (6 * l) / LIMB_STRIDE;
          if (toSegment2(pos[i], pos[i + 1], pos[i + 2], LE, e, e + 3) > L[l + 3] * L[l + 3]) continue;
          const o = L[l + 7] * BONE_STRIDE;
          for (let e = 0; e < BONE_STRIDE; e++) B[e] = this.bones![o + e];
          applyInverse(B, pos[i], pos[i + 1], pos[i + 2], q0);
          const dl = sdf.sample(q0[0], q0[1], q0[2]);
          if (dl >= deepest) continue;
          blendAt(sdf, this.bones!, q0[0], q0[1], q0[2], M);
          const ex = M[0] * q0[0] + M[1] * q0[1] + M[2] * q0[2] + M[3] - pos[i];
          const ey = M[4] * q0[0] + M[5] * q0[1] + M[6] * q0[2] + M[7] - pos[i + 1];
          const ez = M[8] * q0[0] + M[9] * q0[1] + M[10] * q0[2] + M[11] - pos[i + 2];
          if (ex * ex + ey * ey + ez * ez >= POSE_TOLERANCE * POSE_TOLERANCE) continue;
          deepest = dl;
          hx = q0[0]; hy = q0[1]; hz = q0[2];
          ML.set(M);
        }
        if (deepest < offset) {
          sdf.gradient(hx, hy, hz, grad);
          const push = offset - deepest;
          // From now on the vertex is followed on the limb (its rest-space position there).
          qx = hx + grad[0] * push; qy = hy + grad[1] * push; qz = hz + grad[2] * push;
          applyAffine(ML, qx, qy, qz, pos, i);
        }
      }
      if (d < offset) {
        // Where the vertex entered the body, on its way from where it was against the skin
        // (rest space: the path is the motion of the cloth relative to the skin).
        const ux = qx - r[i], uy = qy - r[i + 1], uz = qz - r[i + 2];
        let stick = 0, ex = 0, ey = 0, ez = 0;
        if (impact > 0 && before >= offset) {
          let lo = 0, hi = 1;
          for (let it = 0; it < 5; it++) {
            const mid = (lo + hi) / 2;
            if (sdf.sample(r[i] + ux * mid, r[i + 1] + uy * mid, r[i + 2] + uz * mid) >= offset) lo = mid;
            else hi = mid;
          }
          ex = r[i] + ux * lo; ey = r[i + 1] + uy * lo; ez = r[i + 2] + uz * lo;
          stick = impact;
        }
        sdf.gradient(qx, qy, qz, grad);
        const push = offset - d;
        qx += grad[0] * push; qy += grad[1] * push; qz += grad[2] * push;
        // Coulomb friction (Macklin et al. 2014), proportional to the contact push:
        // static below μ·push of tangential motion, kinetic above.
        const mx = qx - r[i], my = qy - r[i + 1], mz = qz - r[i + 2];
        const mn = mx * grad[0] + my * grad[1] + mz * grad[2];
        const tx = mx - mn * grad[0], ty = my - mn * grad[1], tz = mz - mn * grad[2];
        const lt = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const limit = p.friction * push;
        const k = lt <= limit ? 1 : limit / lt;
        qx -= tx * k; qy -= ty * k; qz -= tz * k;
        // Hit at speed (a runner's forearm against a cape): the vertex stays where it was hit
        // instead of sliding round the limb (posedBody.ts).
        if (stick > 0) {
          qx += (ex - qx) * stick; qy += (ey - qy) * stick; qz += (ez - qz) * stick;
        }
        if (posed) applyAffine(M, qx, qy, qz, pos, i);
        else {
          pos[i] = qx; pos[i + 1] = qy; pos[i + 2] = qz;
        }
      }
      r[i] = qx; r[i + 1] = qy; r[i + 2] = qz;
      // The floor (world space: it does not move with the body): the plinth, a cylinder standing
      // on the ground (model.ts PLINTH). A vertex inside it leaves by the nearest face — its top or
      // its side: pushed up whatever the depth, cloth hanging over the edge would be thrown back
      // onto the plinth and never settle. Same Coulomb friction, against the motion since the
      // start of the substep.
      const half = p.thickness / 2;
      const x = pos[i], z = pos[i + 2];
      const up = p.floorY + half - pos[i + 1];
      const rad = Math.sqrt(x * x + z * z);
      const out = PLINTH.radius + half - rad;
      let nx = 0, ny = 0, nz = 0, depth = 0;
      if (up > 0 && out > 0) {
        if (up <= out || rad < 1e-6) {
          ny = 1; depth = up;
        } else {
          nx = x / rad; nz = z / rad; depth = out;
        }
      } else {
        const ground = p.floorY - PLINTH.height + half - pos[i + 1];
        if (ground > 0) {
          ny = 1; depth = ground;
        }
      }
      if (depth > 0) {
        pos[i] += nx * depth; pos[i + 1] += ny * depth; pos[i + 2] += nz * depth;
        const mx = pos[i] - prev[i], my = pos[i + 1] - prev[i + 1], mz = pos[i + 2] - prev[i + 2];
        const mn = mx * nx + my * ny + mz * nz;
        const tx = mx - mn * nx, ty = my - mn * ny, tz = mz - mn * nz;
        const lt = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const limit = p.friction * depth;
        const k = lt <= limit ? 1 : limit / lt;
        pos[i] -= tx * k; pos[i + 1] -= ty * k; pos[i + 2] -= tz * k;
      }
    }
  }
}
