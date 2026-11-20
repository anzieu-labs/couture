import type { SdfGrid } from "../bodySdf";
import { substepState, type ClothModel } from "../model";
import { bendingWGSL, contactsWGSL, integrateWGSL, motionWGSL, resetWGSL, seamsWGSL, stretchWGSL, velocityWGSL, WORKGROUP } from "./shaders";

const UNIFORM_SLOT = 256; // minUniformBufferOffsetAlignment

/**
 * WebGPU implementation of the XPBD cloth solver (compute shaders, graph-
 * coloured constraints). One command buffer per frame: every substep and every
 * colour is a dispatch inside a single compute pass; WebGPU orders dispatches
 * that touch the same storage buffers, so colours run one after another while
 * the constraints of a colour run in parallel.
 *
 * Runs on the renderer's device: positions never leave the GPU (GpuClothShell
 * turns them into the rendered vertex buffers).
 */
export class GpuClothSolver {
  time = 0;

  private readonly buffers: GPUBuffer[] = [];
  /** Simulated mid-surface positions (3 floats per vertex). */
  readonly positions: GPUBuffer;
  private readonly frameUniform: GPUBuffer;
  private readonly substepUniform: GPUBuffer;
  private readonly encodeFrame: (encoder: GPUCommandEncoder) => void;
  private readonly encodeMotion: (encoder: GPUCommandEncoder) => void;
  private readonly motionReadback: GPUBuffer;
  private motionPending = false;
  /** Latest measured motion: mean and max vertex speed (m/s), and the simulated time it was taken at. */
  motion: { mean: number; max: number; time: number } | null = null;

  constructor(private readonly device: GPUDevice, private readonly m: ClothModel, initial: Float32Array, sdf: SdfGrid) {
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
    this.positions = storage(initial);
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

    this.frameUniform = uniform(16);
    this.substepUniform = uniform(UNIFORM_SLOT * p.substeps);
    const grid = uniform(32);
    const g = new ArrayBuffer(32);
    new Float32Array(g, 0, 4).set([sdf.min[0], sdf.min[1], sdf.min[2], sdf.h]);
    new Uint32Array(g, 16, 4).set([sdf.nx, sdf.ny, sdf.nz, 0]);
    device.queue.writeBuffer(grid, 0, g);

    const colorRanges = [...m.edgeColors, ...m.bendColors, ...m.seamColors];
    const ranges = uniform(UNIFORM_SLOT * colorRanges.length);
    const rangeData = new Uint32Array((UNIFORM_SLOT / 4) * colorRanges.length);
    colorRanges.forEach(([start, count], i) => rangeData.set([start, count], (UNIFORM_SLOT / 4) * i));
    device.queue.writeBuffer(ranges, 0, rangeData);
    const rangeSlot = (i: number): GPUBufferBinding => ({ buffer: ranges, offset: UNIFORM_SLOT * i, size: 16 });
    const substepSlot = (s: number): GPUBufferBinding => ({ buffer: this.substepUniform, offset: UNIFORM_SLOT * s, size: 16 });
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
      contacts0: group(contacts, 0, [this.positions, prev, onSeam, sdfData]),
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

    this.encodeFrame = (encoder) => {
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
        // Symmetric Gauss-Seidel over colours: forward then backward sweep.
        for (let sweep = 0; sweep < 2; sweep++) {
          for (const c of sweeps.edges[sweep]) run(stretch, bg.stretch0, bg.stretch1[c], m.edgeColors[c][1]);
          for (const c of sweeps.bend[sweep]) run(bending, bg.bending0, bg.bending1[c], m.bendColors[c][1]);
          for (const c of sweeps.seams[sweep]) run(sew, bg.sew0, bg.sew1[s][c], m.seamColors[c][1]);
        }
        run(contacts, bg.contacts0, bg.contacts1[s], n);
        run(velocity, bg.velocity0, bg.velocity1, 3 * n);
      }
      pass.end();
    };
  }

  /**
   * Queues `frames` frames of `dt` seconds. `after` may append commands to the
   * last frame (e.g. building the rendered shell from `positions`).
   */
  simulate(frames: number, dt: number, after?: (encoder: GPUCommandEncoder) => void) {
    const p = this.m.params;
    const h = dt / p.substeps;
    const offset = p.skinGap + p.thickness / 2;
    this.device.queue.writeBuffer(this.frameUniform, 0, new Float32Array([h, Math.exp(-p.damping * h), p.friction, offset]));
    const slot = new ArrayBuffer(UNIFORM_SLOT * p.substeps);
    for (let f = 0; f < frames; f++) {
      for (let s = 0; s < p.substeps; s++) {
        const st = substepState(p, this.time + s * h);
        new Float32Array(slot, UNIFORM_SLOT * s, 2).set([st.gravity, st.sewK]);
        new Uint32Array(slot, UNIFORM_SLOT * s + 8, 1)[0] = st.sewing ? 1 : 0;
      }
      this.device.queue.writeBuffer(this.substepUniform, 0, slot);
      const encoder = this.device.createCommandEncoder();
      this.encodeFrame(encoder);
      if (f === frames - 1) after?.(encoder);
      this.device.queue.submit([encoder.finish()]);
      this.time += dt;
    }
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

  dispose() {
    for (const b of this.buffers) b.destroy();
  }
}
