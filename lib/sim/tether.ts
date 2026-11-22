import type { ClothModel } from "./model";

/**
 * Motion mode, the way a video game dresses a character that runs: the garment as it hangs at
 * rest is tethered to the skeleton, and no self-collision is solved — a frame then costs half
 * as much. A tether is a length of cloth that cannot be outrun: each vertex stays within its
 * distance along the cloth of the place the garment hangs from, so nothing stretches without
 * end, comes off or is flung away, however fast the body moves. Inside that length the cloth
 * is simulated as ever (it swings, and the body pushes it out of itself: contacts are solved
 * after the tethers). What is lost is the layers' order — cloth may pass through cloth. So it
 * is for the run only; standing and walking, where a garment's fit is judged, keep the whole
 * simulation.
 *
 * Each vertex hangs from a support: the place where the garment rests on the body that it is
 * nearest to along the cloth, the higher ones first — a cape hangs from the shoulders, not
 * from the forearm it brushes against; a skirt from the waist. The support follows its bones;
 * the vertex may be `base` from it, plus its distance to it along the cloth as draped and
 * `slack` of that (the draped cloth already hangs a little stretched).
 *
 * Bound while the body stands still — where the cloth is then is its place in the standing
 * pose, the one the bone transforms are counted from (lib/avatar/motion.ts).
 */
export const TETHER = {
  /** How near the contact offset a vertex must be to count as resting on the body (m). */
  touch: 0.006,
  base: 0.02,
  slack: 0.05,
  /** Metres of cloth a support is worth per metre it is below the highest one: what hangs, hangs from above. */
  hang: 3,
};

/** Floats per vertex: the place of its support when bound (x, y, z) and how far it may be from it (< 0: free), then that place again (where the bones are read) and a spare. */
export const TETHER_STRIDE = 8;

/** A binary heap of (key, vertex) pairs, smallest key first. */
class Heap {
  private readonly keys: number[] = [];
  private readonly items: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, item: number) {
    const { keys, items } = this;
    let i = keys.length;
    keys.push(key);
    items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [keys[p], keys[i]] = [keys[i], keys[p]];
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const { keys, items } = this;
    const top: [number, number] = [keys[0], items[0]];
    const key = keys.pop()!, item = items.pop()!;
    if (keys.length) {
      keys[0] = key;
      items[0] = item;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < keys.length && keys[l] < keys[m]) m = l;
        if (r < keys.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The tethers of a garment as it hangs now, the body standing (see the header): TETHER_STRIDE
 * floats per vertex. `offset` is the distance to the skin contacts keep the cloth at.
 */
export function bindTethers(m: ClothModel, pos: Float32Array, body: { sample(x: number, y: number, z: number): number }, offset: number): Float32Array {
  const n = m.vertexCount;
  // The cloth as a graph: its edges at their length as draped, its seams (stitched vertices are one place).
  const count = new Uint32Array(n + 1);
  const pairs = [m.edges, m.seams];
  for (const list of pairs) for (let k = 0; k < list.length; k++) count[list[k] + 1]++;
  for (let v = 0; v < n; v++) count[v + 1] += count[v];
  const fill = count.slice(0, n), to = new Uint32Array(count[n]);
  for (const list of pairs)
    for (let k = 0; k < list.length; k += 2) {
      to[fill[list[k]]++] = list[k + 1];
      to[fill[list[k + 1]]++] = list[k];
    }
  const dist = (a: number, b: number) => Math.hypot(pos[3 * a] - pos[3 * b], pos[3 * a + 1] - pos[3 * b + 1], pos[3 * a + 2] - pos[3 * b + 2]);

  // Supports: the vertices resting on the body. The highest one costs nothing; the others, the cloth it would take to hang from above them.
  const resting: number[] = [];
  let top = -Infinity;
  for (let v = 0; v < n; v++)
    if (body.sample(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]) < offset + TETHER.touch) {
      resting.push(v);
      top = Math.max(top, pos[3 * v + 1]);
    }
  const cost = new Float64Array(n).fill(Infinity), along = new Float64Array(n), support = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (const v of resting) {
    cost[v] = TETHER.hang * (top - pos[3 * v + 1]);
    support[v] = v;
    heap.push(cost[v], v);
  }
  while (heap.size) {
    const [c, v] = heap.pop();
    if (c > cost[v]) continue;
    for (let k = count[v]; k < count[v + 1]; k++) {
      const u = to[k], d = dist(v, u);
      if (c + d >= cost[u]) continue;
      cost[u] = c + d;
      along[u] = along[v] + d;
      support[u] = support[v];
      heap.push(cost[u], u);
    }
  }

  const out = new Float32Array(TETHER_STRIDE * n);
  for (let v = 0; v < n; v++) {
    const o = TETHER_STRIDE * v, s = support[v];
    // Cloth that rests on nothing (a piece not sewn to the rest, lying on the floor) is left free.
    if (s < 0) {
      out[o + 3] = -1;
      continue;
    }
    const place = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
    out.set(place, o);
    out[o + 3] = TETHER.base + (1 + TETHER.slack) * along[v];
    out.set(place, o + 4);
  }
  return out;
}
