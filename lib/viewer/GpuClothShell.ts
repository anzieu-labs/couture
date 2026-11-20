import * as THREE from "three/webgpu";
import { shellTopology } from "./shellTopology";

const WORKGROUP = 64;

const normalsWGSL = /* wgsl */ `
struct Counts { n: u32, nRim: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> tris: array<u32>;
@group(0) @binding(2) var<storage, read> start: array<u32>;
@group(0) @binding(3) var<storage, read> list: array<u32>;
@group(0) @binding(4) var<storage, read_write> nrm: array<f32>;
@group(0) @binding(5) var<uniform> counts: Counts;
fn P(i: u32) -> vec3f { return vec3f(pos[3u * i], pos[3u * i + 1u], pos[3u * i + 2u]); }
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= counts.n) { return; }
  // Area-weighted sum of the normals of the incident triangles.
  var s = vec3f(0.0);
  for (var k = start[i]; k < start[i + 1u]; k++) {
    let t = 3u * list[k];
    let a = P(tris[t]);
    s += cross(P(tris[t + 1u]) - a, P(tris[t + 2u]) - a);
  }
  let l = length(s);
  let n = select(vec3f(0.0, 1.0, 0.0), s / l, l > 0.0);
  nrm[3u * i] = n.x;
  nrm[3u * i + 1u] = n.y;
  nrm[3u * i + 2u] = n.z;
}`;

const shellWGSL = /* wgsl */ `
struct Counts { n: u32, nRim: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> nrm: array<f32>;
@group(0) @binding(2) var<storage, read> rim: array<u32>;
@group(0) @binding(3) var<storage, read> thick: array<f32>;
@group(0) @binding(4) var<storage, read_write> outPos: array<f32>;
@group(0) @binding(5) var<storage, read_write> outNrm: array<f32>;
@group(0) @binding(6) var<uniform> counts: Counts;
fn P(i: u32) -> vec3f { return vec3f(pos[3u * i], pos[3u * i + 1u], pos[3u * i + 2u]); }
fn N(i: u32) -> vec3f { return vec3f(nrm[3u * i], nrm[3u * i + 1u], nrm[3u * i + 2u]); }
fn put(v: u32, p: vec3f, n: vec3f) {
  outPos[3u * v] = p.x; outPos[3u * v + 1u] = p.y; outPos[3u * v + 2u] = p.z;
  outNrm[3u * v] = n.x; outNrm[3u * v + 1u] = n.y; outNrm[3u * v + 2u] = n.z;
}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = counts.n;
  if (id.x < n) {
    // Outer and inner faces, offset by ± half the (local) thickness.
    let i = id.x;
    let p = P(i);
    let d = N(i);
    put(i, p + d * thick[i], d);
    put(n + i, p - d * thick[i], -d);
    return;
  }
  let r = id.x - n;
  if (r >= counts.nRim) { return; }
  // Rim quad along a boundary edge: outer a, outer b, inner b, inner a.
  let a = rim[2u * r];
  let b = rim[2u * r + 1u];
  let pa = P(a);
  let pb = P(b);
  let na = N(a);
  let nb = N(b);
  let side = normalize(cross(pb - pa, na + nb));
  let o = 2u * n + 4u * r;
  put(o, pa + na * thick[a], side);
  put(o + 1u, pb + nb * thick[b], side);
  put(o + 2u, pb - nb * thick[b], side);
  put(o + 3u, pa - na * thick[a], side);
}`;

/**
 * GPU version of the rendered cloth solid: normals and the thick shell (outer
 * face, inner face, rims) are computed by compute shaders on the renderer's
 * device, straight into the vertex buffers three.js draws — the simulated
 * positions never leave the GPU.
 */
export class GpuClothShell {
  readonly geometry = new THREE.BufferGeometry();
  private readonly buffers: GPUBuffer[] = [];
  private readonly normals: { pipeline: GPUComputePipeline; group: GPUBindGroup; count: number };
  private readonly shell: { pipeline: GPUComputePipeline; group: GPUBindGroup; count: number };

  constructor(
    renderer: THREE.WebGPURenderer,
    rest: Float32Array,
    triangles: Uint32Array,
    band: Float32Array,
    thickness: number,
    positions: GPUBuffer,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = renderer.backend as any;
    const device: GPUDevice = backend.device;
    const topo = shellTopology(rest, triangles, band, thickness);
    const { n, rim } = topo;
    const nRim = rim.length / 2;

    // Vertex attributes whose GPU buffers are created here with STORAGE usage,
    // so that compute shaders can write them; three.js reuses these buffers.
    const position = new THREE.BufferAttribute(new Float32Array(topo.vertexCount * 3), 3);
    const normal = new THREE.BufferAttribute(new Float32Array(topo.vertexCount * 3), 3);
    this.geometry.setAttribute("position", position);
    this.geometry.setAttribute("normal", normal);
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(topo.uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(topo.index, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2);
    backend.createStorageAttribute(position);
    backend.createStorageAttribute(normal);
    const outPos: GPUBuffer = backend.get(position).buffer;
    const outNrm: GPUBuffer = backend.get(normal).buffer;

    // Vertex → incident triangles (CSR), so normals are gathered without atomics.
    const start = new Uint32Array(n + 1);
    for (const v of triangles) start[v + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n);
    const list = new Uint32Array(triangles.length);
    for (let t = 0; t < triangles.length; t++) list[fill[triangles[t]]++] = Math.floor(t / 3);

    const upload = (data: Float32Array | Uint32Array, usage = GPUBufferUsage.STORAGE) => {
      const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
      this.buffers.push(buf);
      return buf;
    };
    const tris = upload(triangles), startBuf = upload(start), listBuf = upload(list);
    const rimBuf = upload(rim), thick = upload(topo.halfThickness);
    const nrm = upload(new Float32Array(3 * n));
    const counts = upload(new Uint32Array([n, nRim, 0, 0]), GPUBufferUsage.UNIFORM);

    const stage = (code: string, resources: GPUBuffer[], count: number) => {
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      return { pipeline, group, count };
    };
    this.normals = stage(normalsWGSL, [positions, tris, startBuf, listBuf, nrm, counts], n);
    this.shell = stage(shellWGSL, [positions, nrm, rimBuf, thick, outPos, outNrm, counts], n + nRim);
  }

  /** Appends the normal and shell passes to `encoder`. */
  encode(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass();
    for (const { pipeline, group, count } of [this.normals, this.shell]) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP));
    }
    pass.end();
  }

  dispose() {
    for (const b of this.buffers) b.destroy();
    this.geometry.dispose(); // three.js releases the vertex buffers
  }
}
