import type { BodySdf } from "./bodySdf";
import { substepState, type ClothModel } from "./model";
import { applyAffine, applyInverse, blendAt, POSE_TOLERANCE } from "./posedBody";
import { SelfCollider, UNTANGLE_INTERVAL } from "./selfCollision";
import { findTangles } from "./untangle";

/**
 * Body pose at a simulated time: writes the bone transforms into `out` and
 * returns false when the body is in its rest pose.
 */
export type PoseAt = (time: number, out: Float32Array) => boolean;

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
  /** Rest-space position of each vertex at the end of the last substep (animated body). */
  private readonly restPos: Float32Array;
  private readonly blend = new Float64Array(12);
  private readonly blend0 = new Float64Array(12);
  private readonly q = new Float64Array(3);
  private readonly q0 = new Float64Array(3);
  /** Current bone transforms (when posed). */
  readonly bones: Float32Array | null;
  private readonly self: SelfCollider | null;
  private untangledAt = -Infinity;

  constructor(private readonly m: ClothModel, initial: Float32Array, private readonly sdf: BodySdf, boneCount = 0) {
    this.pos = Float32Array.from(initial);
    this.prev = Float32Array.from(initial);
    this.restPos = Float32Array.from(initial);
    this.bones = sdf.skin && boneCount ? new Float32Array(12 * boneCount) : null;
    this.self = m.self ? new SelfCollider(m.self, m.triangles, initial) : null;
    this.vel = new Float32Array(initial.length);
    this.edgeLambda = new Float32Array(m.edgeRest.length);
    this.bendLambda = new Float32Array(m.bendCompliance.length * 3);
  }

  /** Advances `dt` seconds; `poseAt` animates the body (bone transforms at each substep). */
  step(dt: number, poseAt?: PoseAt) {
    const { m, pos, prev, vel } = this;
    const p = m.params, invMass = m.invMass;
    const h = dt / p.substeps;
    const damp = Math.exp(-p.damping * h);
    for (let s = 0; s < p.substeps; s++) {
      const { gravity, sewK, sewing, selfActive } = substepState(p, this.time);
      const posed = !!(poseAt && this.bones && poseAt(this.time + h, this.bones));
      for (let i = 0; i < m.vertexCount; i++) {
        if (!invMass[i]) continue;
        vel[3 * i + 1] += gravity * h;
        for (let a = 0; a < 3; a++) {
          prev[3 * i + a] = pos[3 * i + a];
          pos[3 * i + a] += vel[3 * i + a] * damp * h;
        }
      }
      this.edgeLambda.fill(0);
      this.bendLambda.fill(0);
      // Symmetric Gauss-Seidel: forward then backward sweep.
      for (const reverse of [false, true]) {
        this.solveStretch(h, reverse);
        this.solveBending(h, reverse);
        this.solveSeams(sewK, reverse);
      }
      if (this.self && (s + 1) % m.self!.interval === 0) {
        if (selfActive && this.time - this.untangledAt >= UNTANGLE_INTERVAL) {
          this.untangledAt = this.time;
          findTangles(pos, m.triangles, m.self!, this.self.tangle);
        }
        this.self.solve(pos, invMass, selfActive);
      }
      this.solveContacts(sewing, posed);
      for (let i = 0; i < pos.length; i++) vel[i] = (pos[i] - prev[i]) / h;
      this.time += h;
    }
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

  private solveSeams(sewK: number, reverse: boolean) {
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
      const target = seamStart[s] * sewK;
      if (len <= target || len < 1e-9 || !w) continue;
      const f = (len - target) / (len * w);
      pos[3 * a] -= dx * f * wa; pos[3 * a + 1] -= dy * f * wa; pos[3 * a + 2] -= dz * f * wa;
      pos[3 * b] += dx * f * wb; pos[3 * b + 1] += dy * f * wb; pos[3 * b + 2] += dz * f * wb;
    }
  }

  /**
   * Body contacts, in rest space when the body is posed (lib/sim/posedBody.ts):
   * restPos holds the rest-space position of `prev`, so friction acts on the
   * motion relative to the skin.
   */
  private solveContacts(sewing: boolean, posed: boolean) {
    const { pos, restPos: r, sdf, grad, blend: M, blend0: M0, q, q0 } = this;
    const { params: p, onSeam } = this.m;
    const offset = p.skinGap + p.thickness / 2;
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
      const d = !consistent || (sewing && onSeam[i / 3]) ? Infinity : sdf.sample(qx, qy, qz);
      if (d < offset) {
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
        if (posed) applyAffine(M, qx, qy, qz, pos, i);
        else {
          pos[i] = qx; pos[i + 1] = qy; pos[i + 2] = qz;
        }
      }
      r[i] = qx; r[i + 1] = qy; r[i + 2] = qz;
    }
  }
}
