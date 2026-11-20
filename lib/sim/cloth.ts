import type { BodySdf } from "./bodySdf";
import { substepState, type ClothModel } from "./model";

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

  constructor(private readonly m: ClothModel, initial: Float32Array, private readonly sdf: BodySdf) {
    this.pos = Float32Array.from(initial);
    this.prev = Float32Array.from(initial);
    this.vel = new Float32Array(initial.length);
    this.edgeLambda = new Float32Array(m.edgeRest.length);
    this.bendLambda = new Float32Array(m.bendCompliance.length * 3);
  }

  step(dt: number) {
    const { m, pos, prev, vel } = this;
    const p = m.params, invMass = m.invMass;
    const h = dt / p.substeps;
    const damp = Math.exp(-p.damping * h);
    for (let s = 0; s < p.substeps; s++) {
      const { gravity, sewK, sewing } = substepState(p, this.time);
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
      this.solveContacts(sewing);
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

  private solveContacts(sewing: boolean) {
    const { pos, prev, sdf, grad } = this;
    const { params: p, onSeam } = this.m;
    const offset = p.skinGap + p.thickness / 2;
    for (let i = 0; i < pos.length; i += 3) {
      // Seam vertices may cross the body while the seams are being closed.
      if (sewing && onSeam[i / 3]) continue;
      const d = sdf.sample(pos[i], pos[i + 1], pos[i + 2]);
      if (d >= offset) continue;
      sdf.gradient(pos[i], pos[i + 1], pos[i + 2], grad);
      const push = offset - d;
      pos[i] += grad[0] * push; pos[i + 1] += grad[1] * push; pos[i + 2] += grad[2] * push;
      // Coulomb-like friction: cancel part of the tangential motion of this substep.
      const mx = pos[i] - prev[i], my = pos[i + 1] - prev[i + 1], mz = pos[i + 2] - prev[i + 2];
      const mn = mx * grad[0] + my * grad[1] + mz * grad[2];
      pos[i] -= (mx - mn * grad[0]) * p.friction;
      pos[i + 1] -= (my - mn * grad[1]) * p.friction;
      pos[i + 2] -= (mz - mn * grad[2]) * p.friction;
    }
  }
}
