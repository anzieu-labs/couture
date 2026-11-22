import { BONE_STRIDE } from "../../avatar/skeleton";
import type { SdfGrid } from "../bodySdf";
import type { PoseAt } from "../cloth";
import { GRAB, selfInterval, type GrabPatch } from "../grab";
import { assembling, substepState, sweepPlan, type ClothModel } from "../model";
import { SELF_CELLS_PER_AXIS } from "../selfCollision";
import {
  bandsWGSL,
  bendingWGSL,
  contactsWGSL,
  grabWGSL,
  integrateWGSL,
  motionWGSL,
  resetWGSL,
  seamsWGSL,
  selfApplyWGSL,
  selfClearWGSL,
  selfCountEdgeWGSL,
  selfCountTriWGSL,
  selfEdgeEdgeWGSL,
  selfFillEdgeWGSL,
  selfFillTriWGSL,
  selfScanWGSL,
  selfVertexTriangleWGSL,
  stretchWGSL,
  velocityWGSL,
  WORKGROUP,
} from "./shaders";

const UNIFORM_SLOT = 256; // minUniformBufferOffsetAlignment
const SUBSTEP_SIZE = 32;
const GRAB_SIZE = 32;

/**
 * WebGPU implementation of the XPBD cloth solver (compute shaders, graph-
 * coloured constraints). One command buffer per frame: every substep and every
 * colour is a dispatch inside a single compute pass; WebGPU orders dispatches
 * that touch the same storage buffers, so colours run one after another while
 * the constraints of a colour run in parallel. Bands (waistbands, model.ts BandModel) are
 * solved after the sweeps, one invocation each.
 *
 * Runs on the renderer's device: positions never leave the GPU (GpuClothShell
 * turns them into the rendered vertex buffers; readPositions copies them back, for the
 * intersection analyses and for picking). The cloth may be held by hand (setGrab,
 * lib/sim/grab.ts). An animated body is collided
 * with in rest space (lib/sim/posedBody.ts): the bone transforms of every
 * substep are uploaded with each frame. Self-collisions (lib/sim/selfCollision.ts)
 * run every `self.interval` substeps: for triangles then edges, hash (count,
 * prefix sum, fill); vertex ↔ triangle, edge ↔ edge; apply. Tangled regions
 * (lib/sim/untangle.ts) are analysed on the CPU from read-back positions
 * (readPositions) and uploaded with setTangles.
 */
export class GpuClothSolver {
  time = 0;

  private readonly buffers: GPUBuffer[] = [];
  /** Simulated mid-surface positions (3 floats per vertex). */
  readonly positions: GPUBuffer;
  private readonly frameUniform: GPUBuffer;
  private readonly substepUniform: GPUBuffer;
  /**
   * `early`: the garment is still being assembled at the start of the frame (model.ts sweepPlan);
   * `held`: the cloth is held by hand or still falling back (grab.ts selfInterval).
   */
  private readonly encodeFrame: (encoder: GPUCommandEncoder, early: boolean, held: boolean) => void;
  private readonly encodeMotion: (encoder: GPUCommandEncoder) => void;
  private readonly motionReadback: GPUBuffer;
  private readonly tangle: GPUBuffer | null = null;
  private readonly positionsReadback: GPUBuffer;
  private positionsPending = false;
  private readonly bones: GPUBuffer;
  private readonly boneCount: number;
  private readonly boneScratch: Float32Array;
  private motionPending = false;
  /** Latest measured motion: mean and max vertex speed (m/s), and the simulated time it was taken at. */
  motion: { mean: number; max: number; time: number } | null = null;
  private readonly held: GPUBuffer;
  private readonly grabUniform: GPUBuffer;
  /** The cloth held by hand: vertex count, inverse mass of the held point, and where the hand goes during the next frames. */
  private grab: { count: number; mobility: number; from: [number, number, number]; to: [number, number, number] } | null = null;
  /** Simulated time until which the cloth let go is still falling back. */
  private heldUntil = -Infinity;

  /**
   * `initial`: where the cloth starts (around the body as posed at time 0); `restPose`: the
   * same positions around the body's rest pose, the collision space (default: the same).
   */
  constructor(
    private readonly device: GPUDevice,
    private readonly m: ClothModel,
    initial: Float32Array,
    sdf: SdfGrid,
    boneCount = 0,
    restPose: Float32Array = initial,
  ) {
    const p = m.params;
    const n = m.vertexCount;
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST;

    const storage = (data: Float32Array | Uint32Array, extra = 0) => {
      const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: S | D | extra });
      device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
      this.buffers.push(buf);
      return buf;
    };
    const uniform = (size: number) => {
      const buf = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | D });
      this.buffers.push(buf);
      return buf;
    };

    // --- Buffers ---------------------------------------------------------------
    this.positions = storage(initial, GPUBufferUsage.COPY_SRC); // read back for the intersection analyses
    const prev = storage(initial);
    const vel = storage(new Float32Array(3 * n));
    const invMass = storage(m.invMass);
    const edges = storage(m.edges), edgeRest = storage(m.edgeRest), edgeComp = storage(m.edgeCompliance);
    const edgeLambda = storage(new Float32Array(m.edgeRest.length));
    const bendIdx = storage(m.bendIdx), bendK = storage(m.bendK), bendComp = storage(m.bendCompliance);
    const bendLambda = storage(new Float32Array(3 * m.bendCompliance.length));
    const seams = storage(m.seams), seamStart = storage(m.seamStart);
    const onSeam = storage(m.onSeam);
    const sdfData = storage(sdf.data);
    const restPos = storage(restPose);
    const skin = storage(sdf.skin ?? new Uint32Array(4));
    // Animated body: posing needs the skin grid.
    this.boneCount = sdf.skin ? boneCount : 0;
    this.boneScratch = new Float32Array(Math.max(4, this.boneCount * BONE_STRIDE * p.substeps));
    this.bones = storage(this.boneScratch);

    this.frameUniform = uniform(32);
    this.substepUniform = uniform(UNIFORM_SLOT * p.substeps);
    const grid = uniform(32);
    const g = new ArrayBuffer(32);
    new Float32Array(g, 0, 4).set([sdf.min[0], sdf.min[1], sdf.min[2], sdf.h]);
    new Uint32Array(g, 16, 3).set([sdf.nx, sdf.ny, sdf.nz]);
    new Float32Array(g, 28, 1)[0] = Math.max(p.floorY, -1e9); // the floor (−∞: none)
    device.queue.writeBuffer(grid, 0, g);

    const colorRanges = [...m.edgeColors, ...m.bendColors, ...m.seamColors];
    const ranges = uniform(UNIFORM_SLOT * colorRanges.length);
    const rangeData = new Uint32Array((UNIFORM_SLOT / 4) * colorRanges.length);
    colorRanges.forEach(([start, count], i) => rangeData.set([start, count], (UNIFORM_SLOT / 4) * i));
    device.queue.writeBuffer(ranges, 0, rangeData);
    const rangeSlot = (i: number): GPUBufferBinding => ({ buffer: ranges, offset: UNIFORM_SLOT * i, size: 16 });
    const substepSlot = (s: number): GPUBufferBinding => ({ buffer: this.substepUniform, offset: UNIFORM_SLOT * s, size: SUBSTEP_SIZE });
    const frame: GPUBufferBinding = { buffer: this.frameUniform };

    // --- Pipelines & bind groups ------------------------------------------------
    // Motion statistics (rest detection).
    const motionBuf = device.createBuffer({ size: 16, usage: S | GPUBufferUsage.COPY_SRC | D });
    this.motionReadback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | D });
    this.buffers.push(motionBuf, this.motionReadback);

    const pipeline = (code: string) =>
      device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    const group = (pipe: GPUComputePipeline, index: number, resources: (GPUBuffer | GPUBufferBinding)[]) =>
      device.createBindGroup({
        layout: pipe.getBindGroupLayout(index),
        entries: resources.map((r, binding) => ({ binding, resource: "buffer" in r ? r : { buffer: r } })),
      });

    const integrate = pipeline(integrateWGSL);
    const reset = pipeline(resetWGSL);
    const stretch = pipeline(stretchWGSL);
    const bending = pipeline(bendingWGSL);
    const sew = pipeline(seamsWGSL);
    const contacts = pipeline(contactsWGSL);
    const velocity = pipeline(velocityWGSL);
    // The hand: one invocation, while the cloth is held.
    const grab = pipeline(grabWGSL);
    this.held = storage(new Float32Array(4 * GRAB.capacity));
    this.grabUniform = uniform(UNIFORM_SLOT * p.substeps);
    const grab0 = group(grab, 0, [this.positions, this.held]);
    const grab1 = Array.from({ length: p.substeps }, (_, s) => group(grab, 1, [frame, { buffer: this.grabUniform, offset: UNIFORM_SLOT * s, size: GRAB_SIZE }]));
    // Bands (waistbands): one invocation each.
    const bandCount = m.bands.rest.length;
    const bands = bandCount ? pipeline(bandsWGSL) : null;
    const bands0 = bands && group(bands, 0, [this.positions, invMass, storage(m.bands.ranges), storage(m.bands.rest), storage(m.bands.segments), storage(m.bands.vertices)]);

    // Self-collisions.
    const self = m.self;
    const triCount = m.triangles.length / 3;
    let selfGroups: ((s: number) => { pipe: GPUComputePipeline; g0: GPUBindGroup; g1: GPUBindGroup; count: number }[]) | null = null;
    if (self) {
      const edgeCount = self.edges.length / 2;
      const pipes = {
        clear: pipeline(selfClearWGSL),
        scan: pipeline(selfScanWGSL),
        countTri: pipeline(selfCountTriWGSL),
        fillTri: pipeline(selfFillTriWGSL),
        countEdge: pipeline(selfCountEdgeWGSL),
        fillEdge: pipeline(selfFillEdgeWGSL),
        vt: pipeline(selfVertexTriangleWGSL),
        ee: pipeline(selfEdgeEdgeWGSL),
        apply: pipeline(selfApplyWGSL),
      };
      const tris = storage(m.triangles), canon = storage(self.canon);
      // Edges with their seam-merged ids: a, b, canon a, canon b.
      const edgeData = new Uint32Array(2 * self.edges.length);
      for (let e = 0; e < edgeCount; e++) {
        const a = self.edges[2 * e], b = self.edges[2 * e + 1];
        edgeData.set([a, b, self.canon[a], self.canon[b]], 4 * e);
      }
      const edges = storage(edgeData);
      const triTable = storage(new Uint32Array(2 * self.buckets)), edgeTable = storage(new Uint32Array(2 * self.buckets));
      const triEntries = storage(new Uint32Array(triCount * SELF_CELLS_PER_AXIS ** 3));
      const edgeEntries = storage(new Uint32Array(edgeCount * SELF_CELLS_PER_AXIS ** 3));
      const snapshot = storage(initial);
      const vtOut = storage(new Float32Array(4 * n)), eeOut = storage(new Float32Array(8 * edgeCount));
      const vertexEdgeStart = storage(self.vertexEdgeStart), vertexEdges = storage(self.vertexEdges);
      const tangle = (this.tangle = storage(new Float32Array(4 * n)));
      const params = uniform(32);
      const pd = new ArrayBuffer(32);
      new Float32Array(pd, 0, 5).set([self.triCell, self.edgeCell, self.distance, self.reach, self.edgeGrow]);
      new Uint32Array(pd, 20, 1)[0] = self.buckets - 1;
      device.queue.writeBuffer(params, 0, pd);
      const g0 = {
        clearTri: group(pipes.clear, 0, [triTable]),
        scanTri: group(pipes.scan, 0, [triTable]),
        countTri: group(pipes.countTri, 0, [this.positions, tris, triTable, triEntries]),
        fillTri: group(pipes.fillTri, 0, [this.positions, tris, triTable, triEntries]),
        clearEdge: group(pipes.clear, 0, [edgeTable]),
        scanEdge: group(pipes.scan, 0, [edgeTable]),
        countEdge: group(pipes.countEdge, 0, [this.positions, edges, edgeTable, edgeEntries, vtOut]),
        fillEdge: group(pipes.fillEdge, 0, [this.positions, edges, edgeTable, edgeEntries, vtOut]),
        vt: group(pipes.vt, 0, [this.positions, snapshot, tris, canon, triTable, triEntries, vtOut, tangle]),
        ee: group(pipes.ee, 0, [this.positions, snapshot, edges, edgeTable, edgeEntries, eeOut, tangle, vtOut]),
        apply: group(pipes.apply, 0, [this.positions, snapshot, vtOut, eeOut, vertexEdgeStart, vertexEdges, invMass]),
      };
      const g1 = Array.from({ length: p.substeps }, (_, s) => ({
        sub: group(pipes.clear, 1, [substepSlot(s)]),
        scan: group(pipes.scan, 1, [substepSlot(s)]),
        countTri: group(pipes.countTri, 1, [substepSlot(s), params]),
        fillTri: group(pipes.fillTri, 1, [substepSlot(s), params]),
        countEdge: group(pipes.countEdge, 1, [substepSlot(s), params]),
        fillEdge: group(pipes.fillEdge, 1, [substepSlot(s), params]),
        vt: group(pipes.vt, 1, [substepSlot(s), params]),
        ee: group(pipes.ee, 1, [substepSlot(s), params]),
        apply: group(pipes.apply, 1, [substepSlot(s)]),
      }));
      selfGroups = (s) => [
        { pipe: pipes.clear, g0: g0.clearTri, g1: g1[s].sub, count: 2 * self.buckets },
        { pipe: pipes.countTri, g0: g0.countTri, g1: g1[s].countTri, count: triCount },
        { pipe: pipes.scan, g0: g0.scanTri, g1: g1[s].scan, count: 1 },
        { pipe: pipes.fillTri, g0: g0.fillTri, g1: g1[s].fillTri, count: triCount },
        { pipe: pipes.vt, g0: g0.vt, g1: g1[s].vt, count: n },
        // Edges near another layer only (marked by the vertex ↔ triangle pass).
        { pipe: pipes.clear, g0: g0.clearEdge, g1: g1[s].sub, count: 2 * self.buckets },
        { pipe: pipes.countEdge, g0: g0.countEdge, g1: g1[s].countEdge, count: edgeCount },
        { pipe: pipes.scan, g0: g0.scanEdge, g1: g1[s].scan, count: 1 },
        { pipe: pipes.fillEdge, g0: g0.fillEdge, g1: g1[s].fillEdge, count: edgeCount },
        { pipe: pipes.ee, g0: g0.ee, g1: g1[s].ee, count: edgeCount },
        { pipe: pipes.apply, g0: g0.apply, g1: g1[s].apply, count: n },
      ];
    }
    this.positionsReadback = device.createBuffer({ size: 12 * n, usage: GPUBufferUsage.MAP_READ | D });
    this.buffers.push(this.positionsReadback);

    const substeps = Array.from({ length: p.substeps }, (_, s) => s);
    const bg = {
      integrate0: group(integrate, 0, [this.positions, prev, vel, invMass]),
      integrate1: substeps.map((s) => group(integrate, 1, [frame, substepSlot(s)])),
      reset0: group(reset, 0, [edgeLambda, bendLambda]),
      stretch0: group(stretch, 0, [this.positions, invMass, edges, edgeRest, edgeComp, edgeLambda]),
      stretch1: m.edgeColors.map((_, c) => group(stretch, 1, [frame, rangeSlot(c)])),
      bending0: group(bending, 0, [this.positions, invMass, bendIdx, bendK, bendComp, bendLambda]),
      bending1: m.bendColors.map((_, c) => group(bending, 1, [frame, rangeSlot(m.edgeColors.length + c)])),
      sew0: group(sew, 0, [this.positions, invMass, seams, seamStart]),
      sew1: substeps.map((s) =>
        m.seamColors.map((_, c) => group(sew, 1, [substepSlot(s), rangeSlot(m.edgeColors.length + m.bendColors.length + c)])),
      ),
      contacts0: group(contacts, 0, [this.positions, onSeam, sdfData, restPos, skin, this.bones, prev, storage(sdf.limbs)]),
      contacts1: substeps.map((s) => group(contacts, 1, [frame, substepSlot(s), grid])),
      velocity0: group(velocity, 0, [this.positions, prev, vel]),
      velocity1: group(velocity, 1, [frame]),
    };

    const groups = (count: number) => Math.max(1, Math.ceil(count / WORKGROUP));
    const motion = pipeline(motionWGSL);
    const motion0 = group(motion, 0, [vel, motionBuf]);
    this.encodeMotion = (encoder) => {
      encoder.clearBuffer(motionBuf);
      const pass = encoder.beginComputePass();
      pass.setPipeline(motion);
      pass.setBindGroup(0, motion0);
      pass.dispatchWorkgroups(groups(n));
      pass.end();
      encoder.copyBufferToBuffer(motionBuf, 0, this.motionReadback, 0, 16);
    };
    const lambdaCount = Math.max(m.edgeRest.length, 3 * m.bendCompliance.length);
    const order = (colors: number) => {
      const fwd = Array.from({ length: colors }, (_, c) => c);
      return [fwd, fwd.slice().reverse()];
    };
    const sweeps = { edges: order(m.edgeColors.length), bend: order(m.bendColors.length), seams: order(m.seamColors.length) };
    const plans = {
      assembling: [sweepPlan(p, 0, true), sweepPlan(p, 1, true)],
      draping: [sweepPlan(p, 0, false), sweepPlan(p, 1, false)],
    };

    this.encodeFrame = (encoder, early, held) => {
      const selfEvery = selfInterval(p, held);
      const pass = encoder.beginComputePass();
      let current: GPUComputePipeline | null = null;
      const run = (pipe: GPUComputePipeline, g0: GPUBindGroup, g1: GPUBindGroup | null, count: number) => {
        if (!count) return;
        if (pipe !== current) {
          pass.setPipeline(pipe);
          pass.setBindGroup(0, g0);
          current = pipe;
        }
        if (g1) pass.setBindGroup(1, g1);
        pass.dispatchWorkgroups(groups(count));
      };
      for (const s of substeps) {
        run(reset, bg.reset0, null, lambdaCount);
        run(integrate, bg.integrate0, bg.integrate1[s], n);
        if (this.grab) {
          // An external force: on the predicted positions, before the sweeps.
          pass.setPipeline(grab);
          pass.setBindGroup(0, grab0);
          pass.setBindGroup(1, grab1[s]);
          pass.dispatchWorkgroups(1);
          current = null;
        }
        // Symmetric Gauss-Seidel over colours: sweeps alternately forward and backward (model.ts sweepPlan).
        for (const { reverse, bending: bend } of (early ? plans.assembling : plans.draping)[s & 1]) {
          const dir = reverse ? 1 : 0;
          for (const c of sweeps.edges[dir]) run(stretch, bg.stretch0, bg.stretch1[c], m.edgeColors[c][1]);
          if (bend) for (const c of sweeps.bend[dir]) run(bending, bg.bending0, bg.bending1[c], m.bendColors[c][1]);
          for (const c of sweeps.seams[dir]) run(sew, bg.sew0, bg.sew1[s][c], m.seamColors[c][1]);
        }
        if (bands && bands0) {
          pass.setPipeline(bands);
          pass.setBindGroup(0, bands0);
          pass.dispatchWorkgroups(bandCount);
          current = null;
        }
        if (selfGroups && self && (s + 1) % selfEvery === 0)
          for (const k of selfGroups(s)) {
            current = null; // the same pipeline runs on the triangle and the edge tables
            run(k.pipe, k.g0, k.g1, k.count);
          }
        run(contacts, bg.contacts0, bg.contacts1[s], n);
        run(velocity, bg.velocity0, bg.velocity1, 3 * n);
      }
      pass.end();
    };
  }

  /**
   * Queues `frames` frames of `dt` seconds. `after` may append commands to the
   * last frame (e.g. building the rendered shell from `positions`). `poseAt`
   * animates the body; its time is relative to this call.
   */
  simulate(frames: number, dt: number, after?: (encoder: GPUCommandEncoder) => void, poseAt?: PoseAt) {
    const p = this.m.params;
    const h = dt / p.substeps;
    const offset = p.skinGap + p.thickness / 2;
    this.device.queue.writeBuffer(this.frameUniform, 0, new Float32Array([h, Math.exp(-p.damping * h), p.friction, offset, p.thickness / 2, 0, 0, 0]));
    const slot = new ArrayBuffer(UNIFORM_SLOT * p.substeps);
    const stride = this.boneCount * BONE_STRIDE;
    const grab = this.grab;
    const hand = grab && new ArrayBuffer(UNIFORM_SLOT * p.substeps);
    for (let f = 0; f < frames; f++) {
      let anyPosed = false;
      if (grab && hand) {
        // The hand moves evenly over the frames queued by this call.
        for (let s = 0; s < p.substeps; s++) {
          const k = (f * p.substeps + s + 1) / (frames * p.substeps);
          new Float32Array(hand, UNIFORM_SLOT * s, 3).set(grab.from.map((x, a) => x + (grab.to[a] - x) * k));
          new Uint32Array(hand, UNIFORM_SLOT * s + 12, 1)[0] = grab.count;
          new Float32Array(hand, UNIFORM_SLOT * s + 16, 4).set([GRAB.stiffness, GRAB.force, grab.mobility, GRAB.acceleration]);
        }
        this.device.queue.writeBuffer(this.grabUniform, 0, hand);
      }
      for (let s = 0; s < p.substeps; s++) {
        const st = substepState(p, this.time + s * h);
        // Same convention as the CPU solver: the pose at the end of the substep.
        const posed =
          !!poseAt && stride > 0 && poseAt(f * dt + (s + 1) * h, this.boneScratch.subarray(s * stride, (s + 1) * stride));
        anyPosed ||= posed;
        new Float32Array(slot, UNIFORM_SLOT * s, 2).set([st.gravity, st.sewK]);
        new Uint32Array(slot, UNIFORM_SLOT * s + 8, 4).set([st.sewing ? 1 : 0, posed ? 1 : 0, (s * stride) / 4, st.selfActive ? 1 : 0]);
      }
      this.device.queue.writeBuffer(this.substepUniform, 0, slot);
      if (anyPosed) this.device.queue.writeBuffer(this.bones, 0, this.boneScratch as Float32Array<ArrayBuffer>);
      const encoder = this.device.createCommandEncoder();
      this.encodeFrame(encoder, assembling(p, this.time), !!grab || this.time < this.heldUntil);
      if (f === frames - 1) after?.(encoder);
      this.device.queue.submit([encoder.finish()]);
      this.time += dt;
    }
    if (grab && frames > 0) grab.from = grab.to;
  }

  /** Takes hold of the cloth by `patch` (lib/sim/grab.ts), the hand at `target`; null lets go. */
  setGrab(patch: GrabPatch | null, target: readonly [number, number, number] = [0, 0, 0]) {
    if (!patch) {
      if (this.grab) this.heldUntil = this.time + GRAB.settle;
      this.grab = null;
      return;
    }
    const count = patch.indices.length;
    const data = new ArrayBuffer(16 * count);
    const index = new Uint32Array(data), value = new Float32Array(data);
    for (let k = 0; k < count; k++) {
      index[4 * k] = patch.indices[k];
      value[4 * k + 1] = patch.shares[k];
      value[4 * k + 2] = patch.gains[k];
    }
    this.device.queue.writeBuffer(this.held, 0, data);
    this.grab = { count, mobility: patch.mobility, from: [...target], to: [...target] };
  }

  /** Moves the hand: it gets there over the frames queued by the next `simulate`. */
  moveGrab(target: readonly [number, number, number]) {
    if (this.grab) this.grab.to = [...target];
  }

  /**
   * Measures the current motion asynchronously (a few bytes read back); the
   * result lands in `motion`. No-op while a measurement is in flight.
   */
  measureMotion() {
    if (this.motionPending) return;
    this.motionPending = true;
    const time = this.time;
    const encoder = this.device.createCommandEncoder();
    this.encodeMotion(encoder);
    this.device.queue.submit([encoder.finish()]);
    this.motionReadback
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const [sum, max] = new Uint32Array(this.motionReadback.getMappedRange());
        this.motionReadback.unmap();
        this.motion = { mean: sum / this.m.vertexCount / 1000, max: max / 1000, time };
      })
      .catch(() => {}) // device lost / destroyed buffer
      .finally(() => (this.motionPending = false));
  }

  /** Copy of the current positions (asynchronous read-back); null while one is in flight. */
  readPositions(): Promise<Float32Array> | null {
    if (this.positionsPending) return null;
    this.positionsPending = true;
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.positions, 0, this.positionsReadback, 0, this.positionsReadback.size);
    this.device.queue.submit([encoder.finish()]);
    return this.positionsReadback
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const out = new Float32Array(this.positionsReadback.getMappedRange().slice(0));
        this.positionsReadback.unmap();
        return out;
      })
      .finally(() => (this.positionsPending = false));
  }

  /** Tangled regions (untangle.ts output) for the self-collision passes. */
  setTangles(tangle: Float32Array) {
    // Size check: a reply computed for another mesh must never reach this buffer.
    if (this.tangle && tangle.byteLength === this.tangle.size)
      this.device.queue.writeBuffer(this.tangle, 0, tangle as Float32Array<ArrayBuffer>);
  }

  dispose() {
    for (const b of this.buffers) b.destroy();
  }
}
