import { PLINTH, substepState, type ClothModel } from "../../lib/sim/model";

/**
 * Prototype of a Vertex Block Descent cloth solver (Chen, Macklin, Kim & Yuksel, SIGGRAPH
 * 2024), for the physics bench only (physics.ts, --vbd): would it do better than the XPBD
 * solver the application runs (lib/sim/cloth.ts)?
 *
 * Each step is implicit Euler written as a minimisation,
 *
 *   x ↦ Σᵢ mᵢ / (2h²) · |xᵢ − yᵢ|²  +  Σⱼ Eⱼ(x),      y = x + h·v + h²·g  (where inertia alone leads),
 *
 * solved one vertex at a time: with the others held, a vertex takes one Newton step on its own
 * 3 × 3 system (its inertia, plus the gradients and Hessians of the energies it takes part
 * in). Vertices are graph-coloured so that no two of a colour share an energy: a colour can be
 * solved in parallel — a Gauss-Seidel sweep over the colours is one iteration. The energy never
 * goes up by much whatever the number of iterations, hence the method's stability; how fast it
 * comes down is what this bench measures.
 *
 * To compare solvers and nothing else, the energies are the very ones the XPBD solver's
 * constraints stand for (lib/sim/model.ts), stiffness = 1 / compliance:
 *
 *  - stretch: a spring per mesh edge, ½·k·(|xₐ − x_b| − l)²; its Hessian is made positive
 *    (the term of a compressed spring that would make it indefinite is dropped);
 *  - bending: ½·k·|Σ Kᵢ xᵢ|² around each inner edge (quadratic: constant Hessian);
 *  - the same velocity damping and the same gravity, substep for substep.
 *
 * And, from the paper: Chebyshev acceleration of the iterations (`rho`: the estimated spectral
 * radius, 0: none); the floor as a penalty energy with a smoothed Coulomb friction (the plinth
 * of model.ts PLINTH), solved with the rest; and, as an option, its "adaptive" start of the
 * iterations, which takes of gravity what the vertex's previous acceleration says it can
 * follow (a cloth at rest starts from where it is, not from a free fall the iterations must
 * then undo). Short of convergence the answer depends on where the iterations start, so that
 * start becomes part of the dynamics: on the hanging strip it hides the spurious stretch, but
 * the strip never comes to rest, and with large steps its bounce grows (see physics.ts --vbd).
 *
 * Not there: seams, bands, the body, self-collisions — a strip of fabric is all the physics
 * bench needs. Positions are single precision, as in the XPBD solver (and on a GPU).
 */

export interface VbdOptions {
  /** Gauss-Seidel sweeps over the vertices per substep. */
  iterations: number;
  /** Chebyshev acceleration: estimate of the iteration's spectral radius (0: off). */
  rho: number;
  /** Stiffness of the floor's penalty (N/m per vertex). */
  contact: number;
  /** Where the iterations start from: where inertia and gravity lead ("inertial"), or the paper's "adaptive" start (see the header). */
  start: "adaptive" | "inertial";
  /** Positions in double precision (the XPBD solver's, and a GPU's, are single). */
  double: boolean;
}

export const VBD_DEFAULTS: VbdOptions = { iterations: 10, rho: 0, contact: 1000, start: "inertial", double: false };

/** Tangential speed (m/s) under which friction is smoothed to zero. */
const STICK_SPEED = 0.01;

export class VbdClothSolver {
  readonly pos: Float32Array | Float64Array;
  time = 0;
  /** Colours of the vertex graph: what a GPU would run in as many passes per iteration. */
  readonly colours: number;
  private readonly prev: Float32Array | Float64Array;
  private readonly vel: Float32Array | Float64Array;
  private readonly lastVel: Float32Array | Float64Array;
  private readonly target: Float32Array | Float64Array;
  private readonly back1: Float32Array | Float64Array;
  private readonly back2: Float32Array | Float64Array;
  /** Vertices sorted by colour, and where each colour starts. */
  private readonly order: Uint32Array;
  private readonly edgeStart: Uint32Array;
  /** Per incident edge: the edge, the vertex at its other end. */
  private readonly edgeList: Uint32Array;
  private readonly bendStart: Uint32Array;
  /** Per incident bending element: the element, this vertex's place in it (0..3). */
  private readonly bendList: Uint32Array;
  private readonly opts: VbdOptions;

  constructor(private readonly m: ClothModel, initial: Float32Array, opts: Partial<VbdOptions> = {}) {
    this.opts = { ...VBD_DEFAULTS, ...opts };
    const n = m.vertexCount;
    const Real = this.opts.double ? Float64Array : Float32Array;
    this.pos = Real.from(initial);
    this.prev = Real.from(initial);
    this.vel = new Real(3 * n);
    this.lastVel = new Real(3 * n);
    this.target = new Real(3 * n);
    this.back1 = new Real(3 * n);
    this.back2 = new Real(3 * n);

    // Vertex → incident edges and bending elements (CSR).
    const edgeCount = new Uint32Array(n + 1), bendCount = new Uint32Array(n + 1);
    for (const v of m.edges) edgeCount[v + 1]++;
    for (const v of m.bendIdx) bendCount[v + 1]++;
    for (let i = 0; i < n; i++) {
      edgeCount[i + 1] += edgeCount[i];
      bendCount[i + 1] += bendCount[i];
    }
    this.edgeStart = edgeCount;
    this.bendStart = bendCount;
    this.edgeList = new Uint32Array(2 * m.edges.length);
    this.bendList = new Uint32Array(2 * m.bendIdx.length);
    const ef = edgeCount.slice(0, n), bf = bendCount.slice(0, n);
    for (let c = 0; c < m.edges.length / 2; c++) {
      const a = m.edges[2 * c], b = m.edges[2 * c + 1];
      this.edgeList.set([c, b], 2 * ef[a]++);
      this.edgeList.set([c, a], 2 * ef[b]++);
    }
    for (let c = 0; c < m.bendIdx.length / 4; c++)
      for (let s = 0; s < 4; s++) this.bendList.set([c, s], 2 * bf[m.bendIdx[4 * c + s]]++);

    // Greedy colouring: no two vertices of an edge or of a bending element share a colour.
    const colour = new Int16Array(n).fill(-1);
    let colours = 0;
    const used = new Uint8Array(64);
    for (let i = 0; i < n; i++) {
      used.fill(0);
      for (let k = this.edgeStart[i]; k < this.edgeStart[i + 1]; k++) {
        const c = colour[this.edgeList[2 * k + 1]];
        if (c >= 0) used[c] = 1;
      }
      for (let k = this.bendStart[i]; k < this.bendStart[i + 1]; k++) {
        const e = this.bendList[2 * k];
        for (let s = 0; s < 4; s++) {
          const c = colour[m.bendIdx[4 * e + s]];
          if (c >= 0) used[c] = 1;
        }
      }
      let c = 0;
      while (used[c]) c++;
      colour[i] = c;
      colours = Math.max(colours, c + 1);
    }
    this.colours = colours;
    this.order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => colour[a] - colour[b]);
  }

  /** Advances `dt` seconds, in `params.substeps` implicit steps of `iterations` sweeps each. */
  step(dt: number) {
    const { m, pos, prev, vel, lastVel, target, back1, back2 } = this;
    const p = m.params, invMass = m.invMass;
    const h = dt / p.substeps;
    const damp = Math.exp(-p.damping * h);
    const { iterations, rho } = this.opts;
    for (let s = 0; s < p.substeps; s++) {
      const g = substepState(p, this.time).gravity;
      for (let i = 0; i < m.vertexCount; i++) {
        if (!invMass[i]) continue;
        const o = 3 * i;
        // How much of gravity the vertex followed over the last step: all of it in free fall,
        // none of it resting on something.
        const followed = this.opts.start === "inertial" ? 1 : g ? Math.min(1, Math.max(0, (vel[o + 1] - lastVel[o + 1]) / (g * h))) : 0;
        for (let a = 0; a < 3; a++) {
          const x = pos[o + a], v = vel[o + a], ga = a === 1 ? g : 0;
          prev[o + a] = x;
          lastVel[o + a] = v;
          target[o + a] = x + (v + ga * h) * damp * h;
          pos[o + a] = x + (v + ga * h * followed) * damp * h;
        }
      }
      let omega = 1;
      if (rho > 0) back1.set(pos); // x⁽⁰⁾
      for (let it = 1; it <= iterations; it++) {
        this.sweep(h);
        if (rho <= 0) continue;
        // Chebyshev: x⁽ⁿ⁾ ← ω·(x̄⁽ⁿ⁾ − x⁽ⁿ⁻²⁾) + x⁽ⁿ⁻²⁾.
        omega = it === 1 ? 1 : it === 2 ? 2 / (2 - rho * rho) : 4 / (4 - rho * rho * omega);
        if (it > 1) for (let i = 0; i < pos.length; i++) pos[i] = omega * (pos[i] - back2[i]) + back2[i];
        back2.set(back1);
        back1.set(pos);
      }
      for (let i = 0; i < pos.length; i++) vel[i] = (pos[i] - prev[i]) / h;
      this.time += h;
    }
  }

  /** One iteration: every vertex in turn (colour by colour) takes a Newton step on its own energy. */
  private sweep(h: number) {
    const { m, pos, prev, target } = this;
    const p = m.params, invMass = m.invMass;
    const { edgeRest, edgeCompliance, bendIdx, bendK, bendCompliance } = m;
    const ih2 = 1 / (h * h);
    const half = p.thickness / 2, kc = this.opts.contact;
    const floor = Number.isFinite(p.floorY);
    for (const i of this.order) {
      const w = invMass[i];
      if (!w) continue;
      const o = 3 * i;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      // Force (minus the gradient) and Hessian (symmetric: 6 terms), starting with inertia.
      const mi = ih2 / w;
      let fx = -mi * (x - target[o]), fy = -mi * (y - target[o + 1]), fz = -mi * (z - target[o + 2]);
      let hxx = mi, hyy = mi, hzz = mi, hxy = 0, hxz = 0, hyz = 0;

      for (let k = this.edgeStart[i]; k < this.edgeStart[i + 1]; k++) {
        const c = this.edgeList[2 * k], j = 3 * this.edgeList[2 * k + 1];
        const dx = x - pos[j], dy = y - pos[j + 1], dz = z - pos[j + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const ke = 1 / edgeCompliance[c];
        const ux = dx / len, uy = dy / len, uz = dz / len;
        const pull = ke * (len - edgeRest[c]);
        fx -= pull * ux; fy -= pull * uy; fz -= pull * uz;
        // k·[u uᵀ + (1 − l / len)·(I − u uᵀ)], the second term dropped under compression.
        const across = ke * Math.max(0, 1 - edgeRest[c] / len), along = ke - across;
        hxx += across + along * ux * ux; hyy += across + along * uy * uy; hzz += across + along * uz * uz;
        hxy += along * ux * uy; hxz += along * ux * uz; hyz += along * uy * uz;
      }

      for (let k = this.bendStart[i]; k < this.bendStart[i + 1]; k++) {
        const c = this.bendList[2 * k], e = 4 * c;
        const ki = bendK[e + this.bendList[2 * k + 1]];
        const kb = ki / bendCompliance[c];
        let sx = 0, sy = 0, sz = 0;
        for (let s = 0; s < 4; s++) {
          const j = 3 * bendIdx[e + s], kj = bendK[e + s];
          sx += kj * pos[j]; sy += kj * pos[j + 1]; sz += kj * pos[j + 2];
        }
        fx -= kb * sx; fy -= kb * sy; fz -= kb * sz;
        hxx += kb * ki; hyy += kb * ki; hzz += kb * ki;
      }

      if (floor) {
        // The floor (lib/sim/cloth.ts solveContacts: same geometry), as a penalty.
        const up = p.floorY + half - y;
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
          const ground = p.floorY - PLINTH.height + half - y;
          if (ground > 0) {
            ny = 1; depth = ground;
          }
        }
        if (depth > 0) {
          const push = kc * depth;
          fx += push * nx; fy += push * ny; fz += push * nz;
          hxx += kc * nx * nx; hyy += kc * ny * ny; hzz += kc * nz * nz;
          hxy += kc * nx * ny; hxz += kc * nx * nz; hyz += kc * ny * nz;
          // Coulomb friction against the motion since the start of the step, smoothed near rest.
          const mx = x - prev[o], my = y - prev[o + 1], mz = z - prev[o + 2];
          const mn = mx * nx + my * ny + mz * nz;
          const tx = mx - mn * nx, ty = my - mn * ny, tz = mz - mn * nz;
          const lt = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (lt > 1e-12) {
            const r = Math.min(1, lt / (STICK_SPEED * h));
            const drag = (p.friction * push * (2 * r - r * r)) / lt;
            fx -= drag * tx; fy -= drag * ty; fz -= drag * tz;
            hxx += drag * (1 - nx * nx); hyy += drag * (1 - ny * ny); hzz += drag * (1 - nz * nz);
            hxy -= drag * nx * ny; hxz -= drag * nx * nz; hyz -= drag * ny * nz;
          }
        }
      }

      // Δx = H⁻¹·f (symmetric 3 × 3, by cofactors).
      const c00 = hyy * hzz - hyz * hyz, c01 = hxz * hyz - hxy * hzz, c02 = hxy * hyz - hxz * hyy;
      const det = hxx * c00 + hxy * c01 + hxz * c02;
      if (!(Math.abs(det) > 1e-30)) continue;
      const c11 = hxx * hzz - hxz * hxz, c12 = hxy * hxz - hxx * hyz, c22 = hxx * hyy - hxy * hxy;
      pos[o] = x + (c00 * fx + c01 * fy + c02 * fz) / det;
      pos[o + 1] = y + (c01 * fx + c11 * fy + c12 * fz) / det;
      pos[o + 2] = z + (c02 * fx + c12 * fy + c22 * fz) / det;
    }
  }
}
