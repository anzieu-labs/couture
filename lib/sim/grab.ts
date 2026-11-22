import type { ClothModel, ClothParams } from "./model";

/**
 * Holding the cloth by hand (the pointer, in the viewer): a spring between a point that
 * follows the hand and the centre of mass of a small disc of cloth around the point that was
 * picked. Its force is spread over the disc as an even acceleration, fading towards the edge,
 * so that the disc is not held in shape or orientation: it hangs, folds and turns as the
 * cloth around it does.
 *
 * The force is capped: a garment that cannot follow (a hem pulled down while the shoulders
 * hold the collar) is not stretched without limit, the hand slips ahead of it instead. Both
 * solvers apply it to the predicted positions, before the constraint sweeps — what an
 * external force is to XPBD — with the same formulas (solveGrab here, grabWGSL on the GPU).
 */
export const GRAB = {
  /** Radius of the disc of cloth held (m), measured along the cloth. */
  radius: 0.04,
  /** Stiffness of the hold (N/m): a free t-shirt (1.5 N) hangs 5 mm behind the hand. */
  stiffness: 300,
  /** Strongest pull (N), for the heavy fabrics that `acceleration` does not bound: two fingers pinching a fabric, before it slips. */
  force: 2.5,
  /**
   * The hand never accelerates the held point by more than this (m/s²) — in effect the force
   * of the hold: 0.3 to 0.6 N on jersey (the weight of 0.2 to 0.4 m² of it), more on heavier
   * fabrics. Pressed harder against other layers (a hem folded up over the chest), the cloth
   * goes through them faster than the self-collision passes push it back: at 20 substeps this
   * moves the held point 1.25 mm per substep, a quarter of what a pass catches (selfCollision.ts
   * SELF_CATCH), with a pass every substep meanwhile (selfIntervalHeld). Measured on the GPU,
   * hem folded up to the chest: no crossing left, against 55 to 114 at twice the acceleration.
   */
  acceleration: 1800,
  /** Most vertices in a hold (size of the GPU buffer). */
  capacity: 256,
  /** Once let go, the cloth is simulated in real time for this long (s): it is seen falling back. */
  settle: 1.5,
};

export interface GrabPatch {
  /** Vertices held. */
  indices: Uint32Array;
  /** Per vertex: its share of the disc's weighted mass (Σ = 1). The held point is their weighted mean. */
  shares: Float32Array;
  /** Per vertex: its displacement for a unit of force × h² (1/kg). */
  gains: Float32Array;
  /** Inverse mass of the held point (1/kg): how far a unit of force × h² moves it. */
  mobility: number;
}

/**
 * The disc of cloth around `point` (on `triangle`), by distance along the cloth — across the
 * seams but not through the air: the other layer of a sleeve or a fold is not held.
 */
export function selectGrab(
  m: ClothModel,
  pos: Float32Array,
  triangle: number,
  point: readonly [number, number, number],
  radius = GRAB.radius,
): GrabPatch | null {
  const T = m.triangles;
  if (!Number.isInteger(triangle) || triangle < 0 || 3 * triangle + 2 >= T.length) return null;
  const dist = new Float32Array(m.vertexCount).fill(Infinity);
  let reach = radius;
  for (let k = 0; k < 3; k++) {
    const v = T[3 * triangle + k];
    dist[v] = Math.hypot(pos[3 * v] - point[0], pos[3 * v + 1] - point[1], pos[3 * v + 2] - point[2]);
    // A coarse mesh: at least the triangle and its neighbours.
    reach = Math.max(reach, 1.5 * dist[v]);
  }
  // Shortest paths along the edges (Bellman-Ford: the disc is a few rings wide).
  const E = m.edges, S = m.seams, rest = m.edgeRest;
  const relax = (a: number, b: number, length: number) => {
    const da = dist[a], db = dist[b];
    if (da + length < db && da + length <= reach) dist[b] = da + length;
    else if (db + length < da && db + length <= reach) dist[a] = db + length;
    else return false;
    return true;
  };
  for (let pass = 0, changed = true; changed && pass < 64; pass++) {
    changed = false;
    for (let e = 0; e < rest.length; e++) {
      const a = E[2 * e], b = E[2 * e + 1];
      if (dist[a] === Infinity && dist[b] === Infinity) continue;
      if (relax(a, b, rest[e])) changed = true;
    }
    // Sewn twins are the same point of the garment.
    for (let s = 0; s < S.length; s += 2) {
      const a = S[s], b = S[s + 1];
      if (a === b || (dist[a] === Infinity && dist[b] === Infinity)) continue;
      if (relax(a, b, 0)) changed = true;
    }
  }
  let held: number[] = [];
  for (let v = 0; v < m.vertexCount; v++) if (dist[v] < reach && m.invMass[v] > 0) held.push(v);
  if (!held.length) return null;
  if (held.length > GRAB.capacity) held = held.sort((a, b) => dist[a] - dist[b]).slice(0, GRAB.capacity);

  // Fading towards the edge: (1 − r²)², smooth at both ends.
  const fade = held.map((v) => (1 - (dist[v] / reach) ** 2) ** 2);
  let mass = 0;
  held.forEach((v, k) => (mass += fade[k] / m.invMass[v]));
  const shares = new Float32Array(held.length), gains = new Float32Array(held.length);
  let mobility = 0;
  held.forEach((v, k) => {
    shares[k] = fade[k] / m.invMass[v] / mass;
    gains[k] = fade[k] / mass;
    mobility += shares[k] * gains[k];
  });
  return { indices: Uint32Array.from(held), shares, gains, mobility };
}

/**
 * Substeps between two self-collision passes: closer together while the cloth is held and
 * until it has fallen back (`held`).
 */
export const selfInterval = (p: ClothParams, held: boolean) => (held ? Math.max(1, Math.min(p.selfInterval, p.selfIntervalHeld)) : p.selfInterval);

/** The held point: the weighted mean of the patch. */
export function grabPoint(pos: Float32Array, g: GrabPatch, out: Float64Array | number[]) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < g.indices.length; k++) {
    const i = 3 * g.indices[k], s = g.shares[k];
    x += s * pos[i]; y += s * pos[i + 1]; z += s * pos[i + 2];
  }
  out[0] = x; out[1] = y; out[2] = z;
}

const point = new Float64Array(3);

/**
 * One substep of the hold, on the predicted positions: an implicit spring between the held
 * point and (tx, ty, tz) — stable whatever its stiffness against the substep —, capped.
 */
export function solveGrab(pos: Float32Array, g: GrabPatch, tx: number, ty: number, tz: number, h: number) {
  grabPoint(pos, g, point);
  const dx = tx - point[0], dy = ty - point[1], dz = tz - point[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-9) return;
  const h2 = h * h;
  const force = Math.min((GRAB.stiffness * d) / (1 + GRAB.stiffness * h2 * g.mobility), GRAB.force, GRAB.acceleration / g.mobility);
  const s = (force * h2) / d;
  for (let k = 0; k < g.indices.length; k++) {
    const i = 3 * g.indices[k], a = s * g.gains[k];
    pos[i] += dx * a; pos[i + 1] += dy * a; pos[i + 2] += dz * a;
  }
}
