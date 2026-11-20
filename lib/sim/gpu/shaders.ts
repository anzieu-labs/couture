/**
 * WGSL kernels of the XPBD cloth solver. Same formulas as CpuClothSolver.
 * Positions are flat f32 arrays (3 per vertex) to avoid vec3 padding.
 * Each constraint kernel solves one colour: no two threads touch the same vertex.
 */

export const WORKGROUP = 64;

const common = /* wgsl */ `
struct Frame { h: f32, damp: f32, friction: f32, offset: f32 }
struct Substep { gravity: f32, sewK: f32, sewing: u32, pad: u32 }
struct Range { start: u32, count: u32, pad0: u32, pad1: u32 }

fn getP(i: u32) -> vec3f { return vec3f(pos[3u * i], pos[3u * i + 1u], pos[3u * i + 2u]); }
fn addP(i: u32, d: vec3f) {
  pos[3u * i] += d.x;
  pos[3u * i + 1u] += d.y;
  pos[3u * i + 2u] += d.z;
}
`;

export const integrateWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> prev: array<f32>;
@group(0) @binding(2) var<storage, read_write> vel: array<f32>;
@group(0) @binding(3) var<storage, read> invMass: array<f32>;
@group(1) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(1) var<uniform> substep: Substep;
${common}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&invMass) || invMass[i] == 0.0) { return; }
  let o = 3u * i;
  vel[o + 1u] += substep.gravity * frame.h;
  for (var a = 0u; a < 3u; a++) {
    prev[o + a] = pos[o + a];
    pos[o + a] += vel[o + a] * frame.damp * frame.h;
  }
}`;

export const resetWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> edgeLambda: array<f32>;
@group(0) @binding(1) var<storage, read_write> bendLambda: array<f32>;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&edgeLambda)) { edgeLambda[id.x] = 0.0; }
  if (id.x < arrayLength(&bendLambda)) { bendLambda[id.x] = 0.0; }
}`;

export const stretchWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read> invMass: array<f32>;
@group(0) @binding(2) var<storage, read> edges: array<u32>;
@group(0) @binding(3) var<storage, read> rest: array<f32>;
@group(0) @binding(4) var<storage, read> compliance: array<f32>;
@group(0) @binding(5) var<storage, read_write> lambda: array<f32>;
@group(1) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(1) var<uniform> range: Range;
${common}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let c = range.start + id.x;
  let a = edges[2u * c];
  let b = edges[2u * c + 1u];
  let wa = invMass[a];
  let wb = invMass[b];
  let w = wa + wb;
  if (w == 0.0) { return; }
  let d = getP(a) - getP(b);
  let len = length(d);
  if (len < 1e-9) { return; }
  let alpha = compliance[c] / (frame.h * frame.h);
  let dl = (-(len - rest[c]) - alpha * lambda[c]) / (w + alpha);
  lambda[c] += dl;
  let s = d / len * dl;
  addP(a, s * wa);
  addP(b, -s * wb);
}`;

export const bendingWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read> invMass: array<f32>;
@group(0) @binding(2) var<storage, read> idx: array<u32>;
@group(0) @binding(3) var<storage, read> K: array<f32>;
@group(0) @binding(4) var<storage, read> compliance: array<f32>;
@group(0) @binding(5) var<storage, read_write> lambda: array<f32>;
@group(1) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(1) var<uniform> range: Range;
${common}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let c = range.start + id.x;
  let o = 4u * c;
  let v = vec4u(idx[o], idx[o + 1u], idx[o + 2u], idx[o + 3u]);
  let k = vec4f(K[o], K[o + 1u], K[o + 2u], K[o + 3u]);
  let w = vec4f(invMass[v.x], invMass[v.y], invMass[v.z], invMass[v.w]);
  let alpha = compliance[c] / (frame.h * frame.h);
  let denom = dot(w * k, k) + alpha;
  // Linear and separable per axis: C = Σ K_i x_i.
  let C = k.x * getP(v.x) + k.y * getP(v.y) + k.z * getP(v.z) + k.w * getP(v.w);
  let l = vec3f(lambda[3u * c], lambda[3u * c + 1u], lambda[3u * c + 2u]);
  let dl = (-C - alpha * l) / denom;
  lambda[3u * c] = l.x + dl.x;
  lambda[3u * c + 1u] = l.y + dl.y;
  lambda[3u * c + 2u] = l.z + dl.z;
  addP(v.x, dl * (w.x * k.x));
  addP(v.y, dl * (w.y * k.y));
  addP(v.z, dl * (w.z * k.z));
  addP(v.w, dl * (w.w * k.w));
}`;

export const seamsWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read> invMass: array<f32>;
@group(0) @binding(2) var<storage, read> seams: array<u32>;
@group(0) @binding(3) var<storage, read> seamStart: array<f32>;
@group(1) @binding(0) var<uniform> substep: Substep;
@group(1) @binding(1) var<uniform> range: Range;
${common}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let s = range.start + id.x;
  let a = seams[2u * s];
  let b = seams[2u * s + 1u];
  if (a == b) { return; }
  let wa = invMass[a];
  let wb = invMass[b];
  let w = wa + wb;
  let d = getP(a) - getP(b);
  let len = length(d);
  let goal = seamStart[s] * substep.sewK;
  if (len <= goal || len < 1e-9 || w == 0.0) { return; }
  let f = (len - goal) / (len * w);
  addP(a, -d * (f * wa));
  addP(b, d * (f * wb));
}`;

export const contactsWGSL = /* wgsl */ `
struct Grid { min: vec3f, h: f32, dims: vec3u, pad: u32 }
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read> prev: array<f32>;
@group(0) @binding(2) var<storage, read> onSeam: array<u32>;
@group(0) @binding(3) var<storage, read> sdf: array<f32>;
@group(1) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(1) var<uniform> substep: Substep;
@group(1) @binding(2) var<uniform> grid: Grid;
${common}
fn cell(i: u32, j: u32, k: u32) -> f32 { return sdf[i + grid.dims.x * (j + grid.dims.y * k)]; }

fn sampleSdf(p: vec3f) -> f32 {
  let f = (p - grid.min) / grid.h;
  let c = floor(f);
  if (any(c < vec3f(0.0)) || any(c >= vec3f(grid.dims - vec3u(1u)))) { return 1.0; }
  let t = f - c;
  let i = u32(c.x);
  let j = u32(c.y);
  let k = u32(c.z);
  let c00 = mix(cell(i, j, k), cell(i + 1u, j, k), t.x);
  let c10 = mix(cell(i, j + 1u, k), cell(i + 1u, j + 1u, k), t.x);
  let c01 = mix(cell(i, j, k + 1u), cell(i + 1u, j, k + 1u), t.x);
  let c11 = mix(cell(i, j + 1u, k + 1u), cell(i + 1u, j + 1u, k + 1u), t.x);
  return mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&onSeam)) { return; }
  // Seam vertices may cross the body while the seams are being closed.
  if (substep.sewing != 0u && onSeam[i] != 0u) { return; }
  var p = getP(i);
  let d = sampleSdf(p);
  if (d >= frame.offset) { return; }
  let e = grid.h * 0.5;
  var g = vec3f(
    sampleSdf(p + vec3f(e, 0.0, 0.0)) - sampleSdf(p - vec3f(e, 0.0, 0.0)),
    sampleSdf(p + vec3f(0.0, e, 0.0)) - sampleSdf(p - vec3f(0.0, e, 0.0)),
    sampleSdf(p + vec3f(0.0, 0.0, e)) - sampleSdf(p - vec3f(0.0, 0.0, e)),
  );
  let gl = length(g);
  g = select(vec3f(0.0, 1.0, 0.0), g / gl, gl > 0.0);
  let push = frame.offset - d;
  p += g * push;
  // Coulomb friction (Macklin et al. 2014), proportional to the contact push:
  // static below μ·push of tangential motion, kinetic above.
  let m = p - vec3f(prev[3u * i], prev[3u * i + 1u], prev[3u * i + 2u]);
  let t = m - dot(m, g) * g;
  let lt = length(t);
  let limit = frame.friction * push;
  p -= t * select(limit / lt, 1.0, lt <= limit);
  pos[3u * i] = p.x;
  pos[3u * i + 1u] = p.y;
  pos[3u * i + 2u] = p.z;
}`;

export const velocityWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> prev: array<f32>;
@group(0) @binding(2) var<storage, read_write> vel: array<f32>;
@group(1) @binding(0) var<uniform> frame: Frame;
struct Frame { h: f32, damp: f32, friction: f32, offset: f32 }
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&vel)) { return; }
  vel[id.x] = (pos[id.x] - prev[id.x]) / frame.h;
}`;

/** Sum and max of vertex speeds (mm/s, integers) — to detect when the cloth is at rest. */
export const motionWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> vel: array<f32>;
@group(0) @binding(1) var<storage, read_write> motion: array<atomic<u32>>;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (3u * id.x >= arrayLength(&vel)) { return; }
  let v = vec3f(vel[3u * id.x], vel[3u * id.x + 1u], vel[3u * id.x + 2u]);
  let mm = u32(min(length(v) * 1000.0 + 0.5, 1e6));
  atomicAdd(&motion[0], mm);
  atomicMax(&motion[1], mm);
}`;
