/**
 * WGSL kernels of the XPBD cloth solver. Same formulas as CpuClothSolver.
 * Positions are flat f32 arrays (3 per vertex) to avoid vec3 padding.
 * Each constraint kernel solves one colour: no two threads touch the same vertex.
 */

import { POSE_TOLERANCE } from "../posedBody";
import { NEAR_MARGIN, SELF_CELLS_PER_AXIS } from "../selfCollision";

export const WORKGROUP = 64;

const common = /* wgsl */ `
struct Frame { h: f32, damp: f32, friction: f32, offset: f32 }
// posed: the body is animated; bones: first vec4 of this substep's bone transforms.
struct Substep { gravity: f32, sewK: f32, sewing: u32, posed: u32, bones: u32, selfActive: u32, pad1: u32, pad2: u32 }
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
/** 3×4 affine transform, one row per vector. */
struct Affine { r0: vec4f, r1: vec4f, r2: vec4f }
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read> onSeam: array<u32>;
@group(0) @binding(2) var<storage, read> sdf: array<f32>;
@group(0) @binding(3) var<storage, read_write> restPos: array<f32>;
@group(0) @binding(4) var<storage, read> skin: array<u32>;
@group(0) @binding(5) var<storage, read> bones: array<vec4f>;
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

// Blended bone transform at a rest-space point: skin influences of the grid,
// trilinearly interpolated (see lib/sim/posedBody.ts).
fn blendAt(q: vec3f) -> Affine {
  let f = clamp((q - grid.min) / grid.h, vec3f(0.0), vec3f(grid.dims - vec3u(1u)) - vec3f(0.001));
  let c = vec3u(floor(f));
  let t = f - floor(f);
  var a = Affine(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  for (var corner = 0u; corner < 8u; corner++) {
    let o = vec3u(corner & 1u, (corner >> 1u) & 1u, corner >> 2u);
    let s = select(1.0 - t, t, o == vec3u(1u));
    let cw = s.x * s.y * s.z;
    if (cw == 0.0) { continue; }
    let cc = c + o;
    let idx = cc.x + grid.dims.x * (cc.y + grid.dims.y * cc.z);
    let ids = skin[2u * idx];
    let ws = unpack4x8unorm(skin[2u * idx + 1u]) * cw;
    for (var n = 0u; n < 4u; n++) {
      let w = ws[n];
      if (w == 0.0) { continue; }
      let b = substep.bones + 3u * ((ids >> (8u * n)) & 0xffu);
      a.r0 += w * bones[b];
      a.r1 += w * bones[b + 1u];
      a.r2 += w * bones[b + 2u];
    }
  }
  return a;
}

fn applyAffine(a: Affine, q: vec3f) -> vec3f {
  let h = vec4f(q, 1.0);
  return vec3f(dot(a.r0, h), dot(a.r1, h), dot(a.r2, h));
}

fn applyInverse(a: Affine, p: vec3f) -> vec3f {
  let d = p - vec3f(a.r0.w, a.r1.w, a.r2.w);
  let c0 = cross(a.r1.xyz, a.r2.xyz);
  let c1 = cross(a.r2.xyz, a.r0.xyz);
  let c2 = cross(a.r0.xyz, a.r1.xyz);
  let det = dot(a.r0.xyz, c0);
  return select(vec3f(0.0), (c0 * d.x + c1 * d.y + c2 * d.z) / det, det != 0.0);
}

fn getR(i: u32) -> vec3f { return vec3f(restPos[3u * i], restPos[3u * i + 1u], restPos[3u * i + 2u]); }

// Body contacts, in rest space when the body is animated: restPos holds the
// rest-space position of the previous substep, so friction acts on the motion
// relative to the skin.
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&onSeam)) { return; }
  let r = getR(i);
  let p0 = getP(i);
  var q = p0;
  var a: Affine;
  var consistent = true;
  let posed = substep.posed != 0u;
  if (posed) {
    // Fixed point: weights at the previous rest position, then at the first estimate.
    let q0 = applyInverse(blendAt(r), p0);
    a = blendAt(q0);
    q = applyInverse(a, p0);
    // a·q0 should land back on p (see posedBody.ts): else free space, no contact.
    let e = applyAffine(a, q0) - p0;
    consistent = dot(e, e) < ${POSE_TOLERANCE * POSE_TOLERANCE};
  }
  // Seam vertices may cross the body while the seams are being closed.
  let d = select(sampleSdf(q), 1e9, !consistent || (substep.sewing != 0u && onSeam[i] != 0u));
  if (d < frame.offset) {
    let e = grid.h * 0.5;
    var g = vec3f(
      sampleSdf(q + vec3f(e, 0.0, 0.0)) - sampleSdf(q - vec3f(e, 0.0, 0.0)),
      sampleSdf(q + vec3f(0.0, e, 0.0)) - sampleSdf(q - vec3f(0.0, e, 0.0)),
      sampleSdf(q + vec3f(0.0, 0.0, e)) - sampleSdf(q - vec3f(0.0, 0.0, e)),
    );
    let gl = length(g);
    g = select(vec3f(0.0, 1.0, 0.0), g / gl, gl > 0.0);
    let push = frame.offset - d;
    q += g * push;
    // Coulomb friction (Macklin et al. 2014), proportional to the contact push:
    // static below μ·push of tangential motion, kinetic above.
    let m = q - r;
    let t = m - dot(m, g) * g;
    let lt = length(t);
    let limit = frame.friction * push;
    q -= t * select(limit / lt, 1.0, lt <= limit);
    let p = select(q, applyAffine(a, q), posed);
    pos[3u * i] = p.x;
    pos[3u * i + 1u] = p.y;
    pos[3u * i + 2u] = p.z;
  }
  restPos[3u * i] = q.x;
  restPos[3u * i + 1u] = q.y;
  restPos[3u * i + 2u] = q.z;
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

// --- Self-collisions (see lib/sim/selfCollision.ts) ---------------------------------
// Hash tables: 2 words per bucket, [count, start]; entries: primitive ids sorted by bucket.
// tangle (untangle.ts): per vertex correction direction (xyz) and region label (w; < 0: released).

const substepStruct = "struct Substep { gravity: f32, sewK: f32, sewing: u32, posed: u32, bones: u32, selfActive: u32, pad1: u32, pad2: u32 }";

const selfCommon = /* wgsl */ `
struct SelfParams { triCell: f32, edgeCell: f32, distance: f32, reach: f32, edgeGrow: f32, mask: u32, pad0: u32, pad1: u32 }
fn bucketOf(p: vec3f, cell: f32) -> u32 {
  let u = bitcast<vec3u>(vec3i(floor(p / cell)));
  return ((u.x * 73856093u) ^ (u.y * 19349663u) ^ (u.z * 83492791u)) & params.mask;
}
fn bucketOfCell(c: vec3i) -> u32 {
  let u = bitcast<vec3u>(c);
  return ((u.x * 73856093u) ^ (u.y * 19349663u) ^ (u.z * 83492791u)) & params.mask;
}
fn getP(i: u32) -> vec3f { return vec3f(pos[3u * i], pos[3u * i + 1u], pos[3u * i + 2u]); }
`;

/** Side to keep along n (selfCollision.ts pairSide). */
const pairSideWGSL = /* wgsl */ `
fn pairSide(ta: vec4f, tb: vec4f, n: vec3f, snap: f32) -> f32 {
  if (ta.w == tb.w) { return snap; }
  let d = select(-dot(tb.xyz, n), dot(ta.xyz, n), ta.w != 0.0);
  return select(select(snap, -1.0, d < 0.0), 1.0, d > 0.0);
}
fn getS(i: u32) -> vec3f { return vec3f(snapshot[3u * i], snapshot[3u * i + 1u], snapshot[3u * i + 2u]); }
`;

export const selfClearWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> table: array<u32>;
@group(1) @binding(0) var<uniform> substep: Substep;
${substepStruct}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (substep.selfActive == 0u || id.x >= arrayLength(&table)) { return; }
  table[id.x] = 0u;
}`;

/**
 * Counts (fill = false) or stores (fill = true) the (primitive, cell) pairs per
 * bucket; primitives are triangles (arity 3, box grown by reach) or edges
 * (arity 2, grown by edgeGrow; stored as 4 words: a, b, canon a, canon b).
 */
/** Edges are hashed only near another layer (marked by the vertex ↔ triangle pass). */
const nearEdgeGuard = "if (fract(vtOut[prims[4u * p]].w) == 0.0 && fract(vtOut[prims[4u * p + 1u]].w) == 0.0) { return; }";

const selfBinWGSL = (fill: boolean, arity: 2 | 3) => {
  const stride = arity === 3 ? 3 : 4;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> prims: array<u32>;
@group(0) @binding(2) var<storage, read_write> table: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> entries: array<u32>;
${arity === 2 ? "@group(0) @binding(4) var<storage, read> vtOut: array<vec4f>;" : ""}
@group(1) @binding(0) var<uniform> substep: Substep;
@group(1) @binding(1) var<uniform> params: SelfParams;
${substepStruct}
${selfCommon}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = id.x;
  if (substep.selfActive == 0u || p >= arrayLength(&prims) / ${stride}u) { return; }
  ${arity === 2 ? nearEdgeGuard : ""}
  ${fill ? "" : "_ = &entries; // same bind group layout as the fill"}
  var lo = getP(prims[${stride}u * p]);
  var hi = lo;
  for (var k = 1u; k < ${arity}u; k++) {
    let q = getP(prims[${stride}u * p + k]);
    lo = min(lo, q);
    hi = max(hi, q);
  }
  let cell = ${arity === 3 ? "params.triCell" : "params.edgeCell"};
  let grow = ${arity === 3 ? "params.reach" : "params.edgeGrow"};
  let c0 = vec3i(floor((lo - grow) / cell));
  let c1 = min(c0 + vec3i(${SELF_CELLS_PER_AXIS - 1}), vec3i(floor((hi + grow) / cell)));
  for (var x = c0.x; x <= c1.x; x++) {
    for (var y = c0.y; y <= c1.y; y++) {
      for (var z = c0.z; z <= c1.z; z++) {
        let b = bucketOfCell(vec3i(x, y, z));
        let slot = atomicAdd(&table[2u * b], 1u);
        ${fill ? "entries[atomicLoad(&table[2u * b + 1u]) + slot] = p;" : ""}
      }
    }
  }
}`;
};
export const selfCountTriWGSL = selfBinWGSL(false, 3);
export const selfFillTriWGSL = selfBinWGSL(true, 3);
export const selfCountEdgeWGSL = selfBinWGSL(false, 2);
export const selfFillEdgeWGSL = selfBinWGSL(true, 2);

/** Exclusive prefix sum of the bucket counts (one workgroup), counts reset for the fill. */
export const selfScanWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> table: array<u32>;
@group(1) @binding(0) var<uniform> substep: Substep;
${substepStruct}
var<workgroup> partial: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t: u32) {
  if (substep.selfActive == 0u) { return; }
  let n = arrayLength(&table) / 2u;
  let per = (n + 255u) / 256u;
  let b0 = t * per;
  let b1 = min(b0 + per, n);
  var sum = 0u;
  for (var b = b0; b < b1; b++) { sum += table[2u * b]; }
  partial[t] = sum;
  workgroupBarrier();
  for (var o = 1u; o < 256u; o = o * 2u) {
    var v = 0u;
    if (t >= o) { v = partial[t - o]; }
    workgroupBarrier();
    partial[t] += v;
    workgroupBarrier();
  }
  var run = 0u;
  if (t > 0u) { run = partial[t - 1u]; }
  for (var b = b0; b < b1; b++) {
    table[2u * b + 1u] = run;
    run += table[2u * b];
    table[2u * b] = 0u;
  }
}`;

/**
 * Vertex ↔ triangle: per vertex, correction sum (xyz) and count (integer part
 * of w); fractional part ½: another layer is near (enables edge ↔ edge).
 */
export const selfVertexTriangleWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> snapshot: array<f32>;
@group(0) @binding(2) var<storage, read> tris: array<u32>;
@group(0) @binding(3) var<storage, read> canon: array<u32>;
@group(0) @binding(4) var<storage, read> table: array<u32>;
@group(0) @binding(5) var<storage, read> entries: array<u32>;
@group(0) @binding(6) var<storage, read_write> vtOut: array<vec4f>;
@group(0) @binding(7) var<storage, read> tangle: array<vec4f>;
@group(1) @binding(0) var<uniform> substep: Substep;
@group(1) @binding(1) var<uniform> params: SelfParams;
${substepStruct}
${selfCommon}
${pairSideWGSL}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let v = id.x;
  if (substep.selfActive == 0u || v >= arrayLength(&canon)) { return; }
  let p = getP(v);
  let b = bucketOf(p, params.triCell);
  let cv = canon[v];
  let tv = tangle[v];
  var acc = vec4f(0.0);
  var near = false;
  let start = table[2u * b + 1u];
  let end = start + table[2u * b];
  for (var k = start; k < end; k++) {
    let t = entries[k];
    let i0 = tris[3u * t];
    let i1 = tris[3u * t + 1u];
    let i2 = tris[3u * t + 2u];
    if (canon[i0] == cv || canon[i1] == cv || canon[i2] == cv) { continue; }
    // Released around an open crossing contour.
    if (tv.w < 0.0 || tangle[i0].w < 0.0 || tangle[i1].w < 0.0 || tangle[i2].w < 0.0) { continue; }
    let a = getP(i0);
    let e1 = getP(i1) - a;
    let e2 = getP(i2) - a;
    let nc = cross(e1, e2);
    let nl = length(nc);
    if (nl < 1e-12) { continue; }
    let n = nc / nl;
    let w = p - a;
    let x = dot(w, n);
    if (abs(x) >= params.reach) { continue; }
    let d00 = dot(e1, e1);
    let d01 = dot(e1, e2);
    let d11 = dot(e2, e2);
    let d20 = dot(w, e1);
    let d21 = dot(w, e2);
    let den = d00 * d11 - d01 * d01;
    let bv = (d11 * d20 - d01 * d21) / den;
    let bw = (d00 * d21 - d01 * d20) / den;
    near = near || (bv > -${NEAR_MARGIN} && bw > -${NEAR_MARGIN} && bv + bw < ${1 + NEAR_MARGIN});
    if (bv < 0.0 || bw < 0.0 || bv + bw > 1.0) { continue; }
    let s0 = getS(i0);
    let side0 = dot(getS(v) - s0, cross(getS(i1) - s0, getS(i2) - s0));
    let snap = select(-1.0, 1.0, side0 > 0.0 || (side0 == 0.0 && x >= 0.0));
    let side = pairSide(tv, tangle[i0], n, snap);
    let gap = side * x;
    if (gap >= params.distance) { continue; }
    acc += vec4f((0.5 * (params.distance - gap) * side) * n, 1.0);
  }
  vtOut[v] = acc + vec4f(0.0, 0.0, 0.0, select(0.0, 0.5, near));
}`;

/**
 * Edge ↔ edge: per edge, correction sum and count of each end point
 * (eeOut[2e + end]). edges: 4 words per edge (a, b, canon a, canon b).
 */
export const selfEdgeEdgeWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> snapshot: array<f32>;
@group(0) @binding(2) var<storage, read> edges: array<u32>;
@group(0) @binding(3) var<storage, read> table: array<u32>;
@group(0) @binding(4) var<storage, read> entries: array<u32>;
@group(0) @binding(5) var<storage, read_write> eeOut: array<vec4f>;
@group(0) @binding(6) var<storage, read> tangle: array<vec4f>;
@group(0) @binding(7) var<storage, read> vtOut: array<vec4f>;
@group(1) @binding(0) var<uniform> substep: Substep;
@group(1) @binding(1) var<uniform> params: SelfParams;
${substepStruct}
${selfCommon}
${pairSideWGSL}
// Closest points of segments p1 + s d1 and p2 + t d2 (Ericson 5.1.9): (s, t).
fn closestSegments(p1: vec3f, d1: vec3f, p2: vec3f, d2: vec3f) -> vec2f {
  let r = p1 - p2;
  let a = dot(d1, d1);
  let e = dot(d2, d2);
  let f = dot(d2, r);
  let c = dot(d1, r);
  let b = dot(d1, d2);
  let den = a * e - b * b;
  var s = select(0.0, clamp((b * f - c * e) / den, 0.0, 1.0), den > 1e-14);
  var t = (b * s + f) / e;
  if (t < 0.0) {
    t = 0.0;
    s = clamp(-c / a, 0.0, 1.0);
  } else if (t > 1.0) {
    t = 1.0;
    s = clamp((b - c) / a, 0.0, 1.0);
  }
  return vec2f(s, t);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (substep.selfActive == 0u || e >= arrayLength(&edges) / 4u) { return; }
  let ia = edges[4u * e];
  let ib = edges[4u * e + 1u];
  // Only near another layer (marked by the vertex ↔ triangle pass).
  if (fract(vtOut[ia].w) == 0.0 && fract(vtOut[ib].w) == 0.0) {
    eeOut[2u * e] = vec4f(0.0);
    eeOut[2u * e + 1u] = vec4f(0.0);
    return;
  }
  let pa = getP(ia);
  let da = getP(ib) - pa;
  let le = length(da);
  let b = bucketOf(pa + 0.5 * da, params.edgeCell);
  let ca = edges[4u * e + 2u];
  let cb = edges[4u * e + 3u];
  let ta = tangle[ia];
  let tb = tangle[ib];
  var outA = vec4f(0.0);
  var outB = vec4f(0.0);
  let start = table[2u * b + 1u];
  let end = start + table[2u * b];
  for (var k = start; k < end; k++) {
    let f = entries[k];
    if (f == e) { continue; }
    let ic = edges[4u * f];
    let id_ = edges[4u * f + 1u];
    let cc = edges[4u * f + 2u];
    let cd = edges[4u * f + 3u];
    if (cc == ca || cc == cb || cd == ca || cd == cb) { continue; }
    let tc = tangle[ic];
    if (ta.w < 0.0 || tb.w < 0.0 || tc.w < 0.0 || tangle[id_].w < 0.0) { continue; }
    let pc = getP(ic);
    let dc = getP(id_) - pc;
    // Quick reject: midpoints too far apart.
    if (length(pa + 0.5 * da - pc - 0.5 * dc) > params.reach + 0.5 * (le + length(dc))) { continue; }
    let st = closestSegments(pa, da, pc, dc);
    let sep = pa + st.x * da - pc - st.y * dc;
    let dist = length(sep);
    if (dist >= params.reach || dist < 1e-9) { continue; }
    let n = sep / dist;
    let s0a = getS(ia);
    let s0c = getS(ic);
    let sep0 = s0a + st.x * (getS(ib) - s0a) - s0c - st.y * (getS(id_) - s0c);
    let snap = select(-1.0, 1.0, dot(sep0, n) >= 0.0);
    let side = pairSide(ta, tc, n, snap);
    let C = side * dist - params.distance;
    if (C >= 0.0) { continue; }
    let u = st.x;
    let w = st.y;
    let k0 = (-C * side) / ((1.0 - u) * (1.0 - u) + u * u + (1.0 - w) * (1.0 - w) + w * w);
    outA += vec4f((k0 * (1.0 - u)) * n, 1.0);
    outB += vec4f((k0 * u) * n, 1.0);
  }
  eeOut[2u * e] = outA;
  eeOut[2u * e + 1u] = outB;
}`;

/** Per vertex: averages its corrections (vertex ↔ triangle + its edges'), applies them; snapshot for the next pass. */
export const selfApplyWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> snapshot: array<f32>;
@group(0) @binding(2) var<storage, read> vtOut: array<vec4f>;
@group(0) @binding(3) var<storage, read> eeOut: array<vec4f>;
@group(0) @binding(4) var<storage, read> vertexEdgeStart: array<u32>;
@group(0) @binding(5) var<storage, read> vertexEdges: array<u32>;
@group(0) @binding(6) var<storage, read> invMass: array<f32>;
@group(1) @binding(0) var<uniform> substep: Substep;
${common}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let v = id.x;
  if (v >= arrayLength(&invMass)) { return; }
  if (substep.selfActive != 0u && invMass[v] > 0.0) {
    var acc = vtOut[v];
    for (var k = vertexEdgeStart[v]; k < vertexEdgeStart[v + 1u]; k++) { acc += eeOut[vertexEdges[k]]; }
    let hits = floor(acc.w); // fractional parts: "near" marks
    if (hits > 0.0) { addP(v, acc.xyz / hits); }
  }
  for (var a = 0u; a < 3u; a++) { snapshot[3u * v + a] = pos[3u * v + a]; }
}`;
