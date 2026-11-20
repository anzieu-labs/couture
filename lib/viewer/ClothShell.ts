import * as THREE from "three/webgpu";
import { shellTopology, type ShellTopology } from "./shellTopology";

/**
 * CPU version of the rendered cloth solid (used with the CPU solver): an outer
 * and an inner face offset by ± thickness / 2 along the vertex normals, plus a
 * rim along every boundary edge; hem / neck bands are thicker (turned layers).
 * Triangles must be oriented with their normals pointing away from the body.
 */
export class ClothShell {
  readonly geometry = new THREE.BufferGeometry();
  private readonly topo: ShellTopology;
  private readonly tris: Uint32Array;
  private readonly normals: Float32Array;
  private readonly position: THREE.BufferAttribute;
  private readonly normal: THREE.BufferAttribute;

  constructor(rest: Float32Array, triangles: Uint32Array, band: Float32Array, thickness: number) {
    this.topo = shellTopology(rest, triangles, band, thickness);
    this.tris = triangles;
    this.normals = new Float32Array(this.topo.n * 3);
    this.position = new THREE.BufferAttribute(new Float32Array(this.topo.vertexCount * 3), 3);
    this.normal = new THREE.BufferAttribute(new Float32Array(this.topo.vertexCount * 3), 3);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("normal", this.normal);
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(this.topo.uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(this.topo.index, 1));
  }

  /** Rebuilds the solid from the simulated mid-surface positions. */
  update(mid: Float32Array) {
    const { n, rim, halfThickness: ht } = this.topo;
    const tris = this.tris;
    const nrm = this.normals.fill(0);
    for (let i = 0; i < tris.length; i += 3) {
      const a = 3 * tris[i], b = 3 * tris[i + 1], c = 3 * tris[i + 2];
      const ux = mid[b] - mid[a], uy = mid[b + 1] - mid[a + 1], uz = mid[b + 2] - mid[a + 2];
      const vx = mid[c] - mid[a], vy = mid[c + 1] - mid[a + 1], vz = mid[c + 2] - mid[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx; // area-weighted
      for (const v of [a, b, c]) {
        nrm[v] += x; nrm[v + 1] += y; nrm[v + 2] += z;
      }
    }
    for (let v = 0; v < 3 * n; v += 3) {
      const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]) || 1;
      nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l;
    }

    const P = this.position.array as Float32Array, N = this.normal.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const v = 3 * i, w = 3 * (n + i), h = ht[i];
      for (let k = 0; k < 3; k++) {
        P[v + k] = mid[v + k] + nrm[v + k] * h;
        P[w + k] = mid[v + k] - nrm[v + k] * h;
        N[v + k] = nrm[v + k];
        N[w + k] = -nrm[v + k];
      }
    }
    for (let r = 0; r < rim.length / 2; r++) {
      const a = rim[2 * r], b = rim[2 * r + 1];
      const o = 3 * (2 * n + 4 * r);
      // Outward direction of the rim: edge × normal.
      const ex = mid[3 * b] - mid[3 * a], ey = mid[3 * b + 1] - mid[3 * a + 1], ez = mid[3 * b + 2] - mid[3 * a + 2];
      const nx = nrm[3 * a] + nrm[3 * b], ny = nrm[3 * a + 1] + nrm[3 * b + 1], nz = nrm[3 * a + 2] + nrm[3 * b + 2];
      let rx = ey * nz - ez * ny, ry = ez * nx - ex * nz, rz = ex * ny - ey * nx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;
      const corners = [a, b, n + b, n + a];
      for (let k = 0; k < 4; k++) {
        const src = 3 * corners[k], dst = o + 3 * k;
        P[dst] = P[src]; P[dst + 1] = P[src + 1]; P[dst + 2] = P[src + 2];
        N[dst] = rx; N[dst + 1] = ry; N[dst + 2] = rz;
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
  }
}
