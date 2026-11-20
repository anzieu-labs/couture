/** Visual thickness never goes below this (m): thinner fabrics read as paper. */
export const MIN_THICKNESS = 0.0005;

/**
 * Static topology of the rendered cloth solid: vertices laid out as
 * [outer n][inner n][rim 4 per boundary edge], with their UVs and triangles.
 */
export interface ShellTopology {
  vertexCount: number;
  /** Mid-surface vertex count. */
  n: number;
  /** Boundary edges (a, b) in the orientation of their triangle. */
  rim: Uint32Array;
  index: Uint32Array;
  uv: Float32Array;
  /** Half thickness of the solid (m). */
  halfThickness: number;
}

export function shellTopology(rest: Float32Array, triangles: Uint32Array, thickness: number): ShellTopology {
  const n = rest.length / 2;
  const halfThickness = Math.max(MIN_THICKNESS, thickness) / 2;

  // Boundary edges: used by exactly one triangle.
  const seen = new Map<number, [number, number] | null>();
  for (let i = 0; i < triangles.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = triangles[i + e], b = triangles[i + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      seen.set(k, seen.has(k) ? null : [a, b]);
    }
  const rimList: number[] = [];
  for (const edge of seen.values()) if (edge) rimList.push(edge[0], edge[1]);
  const rim = Uint32Array.from(rimList);
  const nRim = rim.length / 2;

  const vertexCount = 2 * n + 4 * nRim;
  const uv = new Float32Array(vertexCount * 2);
  uv.set(rest, 0);
  uv.set(rest, 2 * n);
  const index = new Uint32Array(triangles.length * 2 + nRim * 6);
  let k = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    index.set([a, b, c, n + a, n + c, n + b], k);
    k += 6;
  }
  for (let r = 0; r < nRim; r++) {
    const a = rim[2 * r], b = rim[2 * r + 1];
    const o = 2 * n + 4 * r; // outer a, outer b, inner b, inner a
    uv.set([rest[2 * a], rest[2 * a + 1], rest[2 * b], rest[2 * b + 1], rest[2 * b], rest[2 * b + 1], rest[2 * a], rest[2 * a + 1]], 2 * o);
    index.set([o, o + 3, o + 2, o, o + 2, o + 1], k);
    k += 6;
  }
  return { vertexCount, n, rim, index, uv, halfThickness };
}
