import type { GarmentMesh } from "../pattern/mesh";
import type { BodySdf } from "./bodySdf";

/**
 * XPBD cloth solver ("small steps": many substeps, one iteration each).
 *  - stretch: distance constraints on every mesh edge (rest = flat pattern),
 *  - bending: distance between the two opposite vertices of each inner edge,
 *  - sewing: seam vertex pairs pulled together, rest length ramping to 0,
 *  - body contact: projection out of the mannequin SDF, with friction.
 * Gravity is switched on once the seams are closed, like a virtual fitting.
 */

export interface ClothParams {
  /** Surface density, kg/m². */
  density: number;
  /** XPBD compliances (m/N). */
  stretchCompliance: number;
  bendCompliance: number;
  /** Contact offset from the skin (m). */
  thickness: number;
  friction: number;
  substeps: number;
  /** Seconds to close the seams; gravity starts afterwards. */
  sewTime: number;
  /** Total simulated time before the solver stops (s). */
  duration: number;
  damping: number;
}

export const DEFAULT_CLOTH: ClothParams = {
  density: 0.16,
  stretchCompliance: 1e-7,
  bendCompliance: 2e-3,
  thickness: 0.006,
  friction: 0.4,
  substeps: 10,
  sewTime: 1.2,
  duration: 5,
  damping: 2,
};

export class ClothSim {
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly vel: Float32Array;
  private readonly invMass: Float32Array;
  private readonly cons: Uint32Array; // pairs: stretch then bending
  private readonly rest: Float32Array;
  private readonly compliance: Float32Array;
  private readonly seams: Uint32Array;
  private readonly seamStart: Float32Array;
  /** Seam vertices may cross the body while the seams are being closed. */
  private readonly onSeam: Uint8Array;
  private readonly grad = new Float32Array(3);
  time = 0;

  constructor(mesh: GarmentMesh, initial: Float32Array, private readonly sdf: BodySdf, private readonly p: ClothParams = DEFAULT_CLOTH) {
    const n = initial.length / 3;
    this.pos = Float32Array.from(initial);
    this.prev = Float32Array.from(initial);
    this.vel = new Float32Array(n * 3);
    const r = mesh.rest;
    const tri = mesh.triangles;
    const restDist = (a: number, b: number) => Math.hypot(r[2 * a] - r[2 * b], r[2 * a + 1] - r[2 * b + 1]);

    // Masses from rest areas.
    const mass = new Float32Array(n);
    for (let t = 0; t < tri.length; t += 3) {
      const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
      const area = Math.abs((r[2 * b] - r[2 * a]) * (r[2 * c + 1] - r[2 * a + 1]) - (r[2 * c] - r[2 * a]) * (r[2 * b + 1] - r[2 * a + 1])) / 2;
      for (const v of [a, b, c]) mass[v] += (area * p.density) / 3;
    }
    this.invMass = mass.map((m) => (m > 0 ? 1 / m : 0));

    // Edges (stretch) and opposite-vertex pairs (bending).
    const edgeOpp = new Map<number, number[]>();
    for (let t = 0; t < tri.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = tri[t + e], b = tri[t + ((e + 1) % 3)], c = tri[t + ((e + 2) % 3)];
        const k = a < b ? a * n + b : b * n + a;
        if (!edgeOpp.has(k)) edgeOpp.set(k, []);
        edgeOpp.get(k)!.push(c);
      }
    const cons: number[] = [], rest: number[] = [], comp: number[] = [];
    for (const [k, opp] of edgeOpp) {
      const a = Math.floor(k / n), b = k % n;
      cons.push(a, b); rest.push(restDist(a, b)); comp.push(p.stretchCompliance);
      if (opp.length === 2) {
        cons.push(opp[0], opp[1]); rest.push(restDist(opp[0], opp[1])); comp.push(p.bendCompliance);
      }
    }
    this.cons = Uint32Array.from(cons);
    this.rest = Float32Array.from(rest);
    this.compliance = Float32Array.from(comp);

    this.seams = mesh.seams;
    this.onSeam = new Uint8Array(n);
    for (const v of mesh.seams) this.onSeam[v] = 1;
    this.seamStart = new Float32Array(mesh.seams.length / 2);
    for (let s = 0; s < this.seamStart.length; s++) {
      const a = mesh.seams[2 * s], b = mesh.seams[2 * s + 1];
      this.seamStart[s] = Math.hypot(initial[3 * a] - initial[3 * b], initial[3 * a + 1] - initial[3 * b + 1], initial[3 * a + 2] - initial[3 * b + 2]);
    }
  }

  get done(): boolean {
    return this.time >= this.p.duration;
  }

  /** 0..1 */
  get progress(): number {
    return Math.min(1, this.time / this.p.duration);
  }

  /** Advances one frame of `dt` seconds. */
  step(dt: number) {
    const { p, pos, prev, vel, invMass } = this;
    const h = dt / p.substeps;
    const n = invMass.length;
    for (let s = 0; s < p.substeps; s++) {
      const gravity = this.time > p.sewTime ? -9.81 : 0;
      const damp = Math.exp(-p.damping * h);
      for (let i = 0; i < n; i++) {
        if (!invMass[i]) continue;
        vel[3 * i + 1] += gravity * h;
        for (let a = 0; a < 3; a++) {
          prev[3 * i + a] = pos[3 * i + a];
          pos[3 * i + a] += vel[3 * i + a] * damp * h;
        }
      }
      // Symmetric Gauss-Seidel (forward then backward sweep): no ordering bias,
      // and no oscillation between substeps.
      this.solveDistances(h, false);
      this.solveSeams(false);
      this.solveDistances(h, true);
      this.solveSeams(true);
      this.solveContacts();
      for (let i = 0; i < 3 * n; i++) vel[i] = (pos[i] - prev[i]) / h;
      this.time += h;
    }
  }

  private solveDistances(h: number, reverse: boolean) {
    const { pos, invMass, cons, rest, compliance } = this;
    const ih2 = 1 / (h * h);
    const n = rest.length;
    for (let it = 0; it < n; it++) {
      const c = reverse ? n - 1 - it : it;
      const a = cons[2 * c], b = cons[2 * c + 1];
      const wa = invMass[a], wb = invMass[b], w = wa + wb;
      if (!w) continue;
      const dx = pos[3 * a] - pos[3 * b], dy = pos[3 * a + 1] - pos[3 * b + 1], dz = pos[3 * a + 2] - pos[3 * b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const lambda = -(len - rest[c]) / (w + compliance[c] * ih2);
      const sx = (dx / len) * lambda, sy = (dy / len) * lambda, sz = (dz / len) * lambda;
      pos[3 * a] += sx * wa; pos[3 * a + 1] += sy * wa; pos[3 * a + 2] += sz * wa;
      pos[3 * b] -= sx * wb; pos[3 * b + 1] -= sy * wb; pos[3 * b + 2] -= sz * wb;
    }
  }

  private solveSeams(reverse: boolean) {
    const { pos, invMass, seams, seamStart } = this;
    const k = Math.max(0, 1 - this.time / this.p.sewTime);
    const n = seamStart.length;
    for (let it = 0; it < n; it++) {
      const s = reverse ? n - 1 - it : it;
      const a = seams[2 * s], b = seams[2 * s + 1];
      if (a === b) continue;
      const wa = invMass[a], wb = invMass[b], w = wa + wb;
      const dx = pos[3 * a] - pos[3 * b], dy = pos[3 * a + 1] - pos[3 * b + 1], dz = pos[3 * a + 2] - pos[3 * b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const target = seamStart[s] * k;
      if (len <= target || len < 1e-9 || !w) continue;
      const f = (len - target) / (len * w);
      pos[3 * a] -= dx * f * wa; pos[3 * a + 1] -= dy * f * wa; pos[3 * a + 2] -= dz * f * wa;
      pos[3 * b] += dx * f * wb; pos[3 * b + 1] += dy * f * wb; pos[3 * b + 2] += dz * f * wb;
    }
  }

  private solveContacts() {
    const { pos, prev, sdf, grad, p, onSeam } = this;
    const sewing = this.time < p.sewTime;
    for (let i = 0; i < pos.length; i += 3) {
      if (sewing && onSeam[i / 3]) continue;
      const d = sdf.sample(pos[i], pos[i + 1], pos[i + 2]);
      if (d >= p.thickness) continue;
      sdf.gradient(pos[i], pos[i + 1], pos[i + 2], grad);
      const push = p.thickness - d;
      pos[i] += grad[0] * push; pos[i + 1] += grad[1] * push; pos[i + 2] += grad[2] * push;
      // Coulomb-like friction: cancel part of the tangential motion of this substep.
      const mx = pos[i] - prev[i], my = pos[i + 1] - prev[i + 1], mz = pos[i + 2] - prev[i + 2];
      const mn = mx * grad[0] + my * grad[1] + mz * grad[2];
      const tx = mx - mn * grad[0], ty = my - mn * grad[1], tz = mz - mn * grad[2];
      pos[i] -= tx * p.friction; pos[i + 1] -= ty * p.friction; pos[i + 2] -= tz * p.friction;
    }
  }
}
