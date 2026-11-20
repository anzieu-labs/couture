import type { GarmentMesh } from "../pattern/mesh";
import type { BodySdf } from "../sim/bodySdf";

/**
 * Makes every piece's triangles face away from the body (mirrored pieces —
 * back, one sleeve — come out of the flat pattern with inward normals). The
 * body SDF gradient gives the outward direction at each triangle. In place.
 */
export function orientOutward(mesh: GarmentMesh, positions: Float32Array, sdf: BodySdf): void {
  const t = mesh.triangles, p = positions;
  const score = new Float64Array(mesh.pieceIds.length);
  const g = new Float32Array(3);
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    sdf.gradient((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3, g);
    score[mesh.piece[t[i]]] += (uy * vz - uz * vy) * g[0] + (uz * vx - ux * vz) * g[1] + (ux * vy - uy * vx) * g[2];
  }
  for (let i = 0; i < t.length; i += 3) {
    if (score[mesh.piece[t[i]]] < 0) {
      const tmp = t[i + 1];
      t[i + 1] = t[i + 2];
      t[i + 2] = tmp;
    }
  }
}
