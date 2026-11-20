import * as THREE from "three/webgpu";
import { fitColor, restInverses, triangleFit, type FitMode, type Tensile } from "./fitMap";
import { shellTopology, type ShellTopology } from "./shellTopology";

/**
 * CPU version of the rendered cloth solid (used with the CPU solver): an outer
 * and an inner face offset by ± thickness / 2 along the vertex normals, plus a
 * rim along every boundary edge.
 * Triangles must be oriented with their normals pointing away from the body.
 * Also fills fit-map colours (see fitMap.ts).
 */
export class ClothShell {
  readonly geometry = new THREE.BufferGeometry();
  private readonly topo: ShellTopology;
  private readonly tris: Uint32Array;
  private readonly normals: Float32Array;
  private readonly position: THREE.BufferAttribute;
  private readonly normal: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private readonly restInv: Float32Array;
  private readonly fit: Float32Array;
  private readonly fitCount: Uint16Array;
  private readonly smoothed: Float32Array;
  private fitMode: FitMode = "tension";
  private last: Float32Array | null = null;

  constructor(rest: Float32Array, triangles: Uint32Array, thickness: number, private readonly tensile: Tensile) {
    this.topo = shellTopology(rest, triangles, thickness);
    this.tris = triangles;
    this.normals = new Float32Array(this.topo.n * 3);
    this.position = new THREE.BufferAttribute(new Float32Array(this.topo.vertexCount * 3), 3);
    this.normal = new THREE.BufferAttribute(new Float32Array(this.topo.vertexCount * 3), 3);
    this.color = new THREE.BufferAttribute(new Float32Array(this.topo.vertexCount * 3), 3);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("normal", this.normal);
    this.geometry.setAttribute("color", this.color);
    this.restInv = restInverses(rest, triangles);
    this.fit = new Float32Array(this.topo.n);
    this.fitCount = new Uint16Array(this.topo.n);
    this.smoothed = new Float32Array(this.topo.n);
    for (const v of triangles) this.fitCount[v]++;
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(this.topo.uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(this.topo.index, 1));
  }

  /** Selects what the fit-map colours show. */
  setFitMode(mode: FitMode) {
    this.fitMode = mode;
    if (this.last) this.update(this.last);
  }

  /** Rebuilds the solid from the simulated mid-surface positions. */
  update(mid: Float32Array) {
    this.last = mid;
    const { n, rim, halfThickness: h } = this.topo;
    const tris = this.tris;
    const nrm = this.normals.fill(0);
    const fit = this.fit.fill(0);
    for (let i = 0; i < tris.length; i += 3) {
      const a = 3 * tris[i], b = 3 * tris[i + 1], c = 3 * tris[i + 2];
      const ux = mid[b] - mid[a], uy = mid[b + 1] - mid[a + 1], uz = mid[b + 2] - mid[a + 2];
      const vx = mid[c] - mid[a], vy = mid[c + 1] - mid[a + 1], vz = mid[c + 2] - mid[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx; // area-weighted
      for (const v of [a, b, c]) {
        nrm[v] += x; nrm[v + 1] += y; nrm[v + 2] += z;
      }
      const f = triangleFit(ux, uy, uz, vx, vy, vz, this.restInv, (4 * i) / 3, this.fitMode, this.tensile);
      fit[tris[i]] += f; fit[tris[i + 1]] += f; fit[tris[i + 2]] += f;
    }
    for (let v = 0; v < n; v++) fit[v] /= Math.max(1, this.fitCount[v]);
    // One smoothing pass (same as the GPU): mean over the incident triangles' vertices.
    const smoothed = this.smoothed.fill(0);
    for (let i = 0; i < tris.length; i += 3) {
      const m = fit[tris[i]] + fit[tris[i + 1]] + fit[tris[i + 2]];
      smoothed[tris[i]] += m; smoothed[tris[i + 1]] += m; smoothed[tris[i + 2]] += m;
    }
    for (let v = 0; v < n; v++) smoothed[v] /= 3 * Math.max(1, this.fitCount[v]);
    for (let v = 0; v < 3 * n; v += 3) {
      const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]) || 1;
      nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l;
    }

    const P = this.position.array as Float32Array, N = this.normal.array as Float32Array;
    const C = this.color.array as Float32Array;
    const rgb = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const v = 3 * i, w = 3 * (n + i);
      fitColor(smoothed[i], this.fitMode, rgb);
      for (let k = 0; k < 3; k++) {
        P[v + k] = mid[v + k] + nrm[v + k] * h;
        P[w + k] = mid[v + k] - nrm[v + k] * h;
        N[v + k] = nrm[v + k];
        N[w + k] = -nrm[v + k];
        C[v + k] = C[w + k] = rgb[k];
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
        C[dst] = C[src]; C[dst + 1] = C[src + 1]; C[dst + 2] = C[src + 2];
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    this.color.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
  }
}
