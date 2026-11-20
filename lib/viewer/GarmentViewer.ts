import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AnnyModel, BodyShape, LocalChanges, Phenotype } from "../avatar/anny";
import { measureForPattern, type TorsoFrame } from "../avatar/bodyMeasures";
import { loadAnnyModel } from "../avatar/loadAnny";
import { measureBody, type BodyMeasurement } from "../avatar/measure";
import { Animator, CADENCE, MOTION_DELAY, SETTLE_TIME } from "../avatar/motion";
import { BONE_STRIDE, Skeleton, skinVertices } from "../avatar/skeleton";
import { GarmentSimulator } from "../garment/GarmentSimulator";
import { MeshSlicer } from "../geometry/slice";
import type { BodyMeasures, Pattern } from "../pattern/types";
import { SELF_DELAY, type ClothParams } from "../sim/model";
import { UNTANGLE_INTERVAL } from "../sim/selfCollision";
import type { Textile } from "../textiles/catalog";
import type { TextileColors } from "../textiles/generate";
import { GpuClothSolver } from "../sim/gpu/GpuClothSolver";
import type { GarmentGeometry } from "../garment/protocol";
import type { SdfGrid } from "../sim/bodySdf";
import type { ClothModel } from "../sim/model";
import { ClothShell } from "./ClothShell";
import type { FitMode } from "./fitMap";
import { GpuClothShell } from "./GpuClothShell";
import { FabricMaterial } from "./FabricMaterial";

export type ViewPreset = "face" | "profil" | "dos" | "buste";

const PLINTH_H = 0.04;
const VIEWS: Record<ViewPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  face: { pos: [0, 1.2, 4.5], target: [0, 0.94, 0] },
  profil: { pos: [4.5, 1.2, 0.2], target: [0, 0.94, 0] },
  dos: { pos: [0, 1.2, -4.5], target: [0, 0.94, 0] },
  buste: { pos: [0.55, 1.42, 1.85], target: [0, 1.2, 0] },
};

/**
 * GPU mode pacing: as many simulated frames per rendered frame as the display
 * allows while staying above ~45 fps (adjusted from the measured frame interval).
 */
const SIM_FRAMES = { initial: 3, min: 2, max: 24 };
const FRAME_INTERVAL = { raise: 19, lower: 24 }; // ms
/**
 * At rest: mean vertex speed below 3 mm/s and max below 3 cm/s. Measurements
 * are sparse (asynchronous read-back behind queued GPU work), so one suffices.
 */
const REST = { mean: 0.003, max: 0.03, count: 1 };
/** Real-time pacing while the body moves: simulated time the solver may lag behind (s). */
const MAX_LAG = 0.1;
const SIM_DT = 1 / 60;
/**
 * Simulated frames queued on the GPU and not finished yet: past this, a rendered
 * frame simulates nothing. Catching up at most this many frames per rendered frame.
 * Without these limits, a garment slightly over the frame budget (cape: ~14 ms of
 * simulation + the render) lags, catches up with 6 frames at once, lags more… and
 * the page freezes (1 fps). With them, the walk slows down instead, smoothly.
 */
const MAX_IN_FLIGHT = 2;
const MAX_CATCH_UP = 2;

interface Garment {
  mesh: THREE.Mesh;
  /** CPU mode: shell rebuilt from streamed positions. */
  cpu?: ClothShell;
  /** GPU mode: simulated and rebuilt on the GPU every frame. */
  gpu?: {
    solver: GpuClothSolver;
    shell: GpuClothShell;
    duration: number;
    sewTime: number;
    done: boolean;
    still: number;
    lastMotion: number;
    /** Simulated time the body last moved at. */
    movedAt: number;
    /** Simulated time of the last intersection analysis request. */
    untangledAt: number;
  };
  /** Switches the fit-map quantity and refreshes the colours. */
  setFitMode: (mode: FitMode) => void;
  dispose: () => void;
}

interface Tween {
  t0: number;
  from: THREE.Spherical;
  to: THREE.Spherical;
  targetFrom: THREE.Vector3;
  targetTo: THREE.Vector3;
}

/**
 * Three.js scene: WebGPU renderer (automatic WebGL 2 fallback), studio lighting,
 * parametric Anny mannequin (morphology computed on the CPU) and a garment
 * sewn from its flat pattern and draped by an XPBD cloth solver — on the
 * renderer's GPU with WebGPU (simulation + thick shell, no read-back), else on
 * the CPU in a worker.
 *
 * The mannequin can walk in place or turn (Animator, skinned on the CPU). The
 * animation clock follows the simulated time while a GPU garment is simulated
 * (real time while the body moves, fast forward otherwise), the wall clock
 * otherwise; in CPU mode the worker owns the timeline and sends the pose with
 * each frame.
 */
export class GarmentViewer {
  readonly backend: "WebGPU" | "WebGL 2";
  /** Called with the sewing/draping progress (0..1). */
  onSimProgress?: (progress: number) => void;
  /** Called when a garment starts simulating, with where it runs. */
  onSimBackend?: (backend: "gpu" | "cpu") => void;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly figure = new THREE.Group();
  private readonly bodyGeo = new THREE.BufferGeometry();
  private readonly body: THREE.Mesh;
  private readonly fabric: FabricMaterial;
  private readonly simulator: GarmentSimulator;
  private garment: Garment | null = null;
  /** null: fabric rendering; otherwise the fit map is shown. */
  private fitMode: FitMode | null = null;
  private readonly fitMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  private shape: BodyShape | null = null;
  /** Rest pose of the current morphology (the geometry holds the posed body). */
  private restPositions: Float32Array;
  private restNormals: Float32Array;
  private skeleton!: Skeleton;
  private animator!: Animator;
  /** Animation clock (s). */
  private clock = 0;
  private lag = 0;
  /** Simulated frames submitted to the GPU and not completed. */
  private gpuInFlight = 0;
  private walkWanted = false;
  private cadence = CADENCE.default;
  private armSpread: number | null = null;
  private posed = false;
  private readonly bones: Float32Array;
  /** CPU mode: pose of the latest simulated frame. */
  private cpuBones: Float32Array | null = null;
  private slicer: MeshSlicer | null = null;
  private tween: Tween | null = null;
  private lastFrameTime = 0;
  private simFrames = SIM_FRAMES.initial;

  static async create(container: HTMLElement): Promise<GarmentViewer> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    const [anny] = await Promise.all([loadAnnyModel(), renderer.init()]);
    return new GarmentViewer(container, renderer, anny);
  }

  private constructor(
    private readonly container: HTMLElement,
    private readonly renderer: THREE.WebGPURenderer,
    private readonly anny: AnnyModel,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.backend = (renderer.backend as any).isWebGPUBackend ? "WebGPU" : "WebGL 2";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%", touchAction: "none" });
    container.appendChild(renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    this.camera.position.set(...VIEWS.face.pos);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      minDistance: 0.8,
      maxDistance: 7,
      maxPolarAngle: Math.PI * 0.53,
      autoRotateSpeed: 1.2,
    });
    this.controls.target.set(...VIEWS.face.target);
    this.controls.addEventListener("start", () => (this.tween = null));

    this.setupStudio();

    // Mannequin: positions are rewritten on every morphology change and every posed frame.
    this.restPositions = Float32Array.from(anny.base);
    this.restNormals = new Float32Array(anny.base.length);
    this.bones = new Float32Array(anny.meta.bones.labels.length * BONE_STRIDE);
    this.bodyGeo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(anny.base), 3));
    this.bodyGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(anny.base.length), 3));
    this.bodyGeo.setIndex(new THREE.BufferAttribute(anny.indices, 1));
    this.body = new THREE.Mesh(
      this.bodyGeo,
      new THREE.MeshPhysicalMaterial({ color: "#efe9e0", roughness: 0.55, clearcoat: 0.1, clearcoatRoughness: 0.6 }),
    );
    this.body.castShadow = this.body.receiveShadow = true;
    this.body.frustumCulled = false; // posed on the CPU, bounds of the rest pose
    this.figure.add(this.body);
    this.scene.add(this.figure);
    this.setBody(anny.defaults());

    this.fabric = new FabricMaterial(renderer.getMaxAnisotropy());
    this.simulator = new GarmentSimulator({
      onMesh: (m) => this.showCpuGarment(m),
      onModel: (m) => this.startGpuGarment(m, m.model, m.sdf),
      onFrame: (positions, progress, bones) => this.updateGarment(positions, progress, bones),
      onTangles: (tangle) => this.garment?.gpu?.solver.setTangles(tangle),
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    renderer.setAnimationLoop((time) => this.frame(time));
  }

  get model(): AnnyModel {
    return this.anny;
  }

  // --- Body -----------------------------------------------------------------

  /** Recomputes the mannequin for a morphology and stands it on the plinth. */
  setBody(phenotype: Phenotype, localChanges: LocalChanges = {}) {
    const attr = this.bodyGeo.getAttribute("position") as THREE.BufferAttribute;
    const normals = this.bodyGeo.getAttribute("normal") as THREE.BufferAttribute;
    const shape = this.anny.compute(phenotype, localChanges, this.restPositions);
    let minY = Infinity;
    for (let i = 1; i < shape.positions.length; i += 3) minY = Math.min(minY, shape.positions[i]);
    this.figure.position.y = PLINTH_H - minY;
    (attr.array as Float32Array).set(shape.positions);
    attr.needsUpdate = true;
    this.bodyGeo.computeVertexNormals();
    this.restNormals.set(normals.array as Float32Array);
    this.bodyGeo.computeBoundingSphere();
    this.shape = shape;
    this.slicer = null;

    const { labels, parents } = this.anny.meta.bones;
    this.skeleton = new Skeleton(labels, parents, shape.joints, shape.positions, this.anny.skin);
    if (this.animator) {
      this.animator.skeleton = this.skeleton;
      this.animator.restoreArmSpread(this.clock);
    } else this.animator = new Animator(this.skeleton);
    this.posed = false;
  }

  /** Poses the rendered body (null: rest pose). */
  private poseBody(bones: Float32Array | null) {
    if (!bones && !this.posed) return;
    const attr = this.bodyGeo.getAttribute("position") as THREE.BufferAttribute;
    const normals = this.bodyGeo.getAttribute("normal") as THREE.BufferAttribute;
    if (bones) {
      skinVertices(this.restPositions, this.restNormals, this.anny.skin, bones, attr.array as Float32Array, normals.array as Float32Array);
    } else {
      (attr.array as Float32Array).set(this.restPositions);
      (normals.array as Float32Array).set(this.restNormals);
    }
    attr.needsUpdate = normals.needsUpdate = true;
    this.posed = !!bones;
  }

  // --- Motion -----------------------------------------------------------------

  /** Walks in place (looped) or stops; with a garment, starts once it is sewn. */
  setWalking(on: boolean) {
    this.walkWanted = on;
    this.animator.setWalking(on, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ walk: on });
  }

  /** Walking cadence (steps per minute). */
  setCadence(stepsPerMinute: number) {
    this.cadence = stepsPerMinute;
    this.animator.setCadence(stepsPerMinute, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ cadence: stepsPerMinute });
  }

  /** Arm spread in degrees from the body (null: rest pose); with a garment, applied once it is sewn. */
  setArmSpread(degrees: number | null) {
    this.armSpread = degrees;
    this.animator.setArmSpread(degrees, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ arms: degrees });
  }

  /** Arm spread of the current morphology's rest pose (degrees from the body). */
  get restArmSpread(): number {
    return this.animator.restArmSpread;
  }

  /** One full turn on the plinth (stops walking first). */
  turn() {
    this.walkWanted = false;
    this.animator.startTurn(this.clock);
    if (this.garment?.cpu) this.simulator.motion({ turn: true });
  }

  /** Starts a new garment's timeline: rest pose while it is sewn, then the requested walk. */
  private restartMotion(params: Pick<ClothParams, "sewTime" | "settleTime">) {
    this.animator.reset();
    this.animator.holdUntil(this.clock + params.sewTime + params.settleTime + MOTION_DELAY);
    this.animator.restoreArmSpread(this.clock);
    if (this.walkWanted) this.animator.setWalking(true, this.clock);
    this.cpuBones = null;
  }

  /** Current body shape with its (lazily built, shared) cross-section index. */
  private current(): { shape: BodyShape; slicer: MeshSlicer } | null {
    if (!this.shape) return null;
    if (!this.slicer) this.slicer = new MeshSlicer(this.shape.positions, this.anny.indices);
    return { shape: this.shape, slicer: this.slicer };
  }

  /** Tape measurements of the current mannequin. */
  measure(): BodyMeasurement | null {
    const c = this.current();
    return c && measureBody(c.shape, this.anny.indices, c.slicer);
  }

  /** Inputs for drafting a top garment on the current mannequin. */
  patternInputs(body: BodyMeasurement): { measures: BodyMeasures; torso: TorsoFrame } | null {
    const c = this.current();
    return c && measureForPattern(c.shape, this.anny.indices, body, c.slicer);
  }

  // --- Garment --------------------------------------------------------------

  /** Sews and drapes a pattern on the current mannequin (in a worker). */
  dress(pattern: Pattern, torso: TorsoFrame, cloth: Partial<ClothParams> = {}) {
    if (!this.shape) return;
    // The new garment is placed on the rest pose: ease back to it meanwhile.
    this.animator.fadeToRest(this.clock);
    const { labels, parents } = this.anny.meta.bones;
    this.simulator.dress({
      mode: this.gpuDevice ? "gpu" : "cpu",
      pattern,
      torso,
      cloth,
      body: {
        positions: Float32Array.from(this.shape.positions),
        normals: Float32Array.from(this.restNormals),
        joints: this.shape.joints,
        skin: this.anny.skin,
        rig: { labels, parents },
      },
      motion: { walking: this.walkWanted, cadence: this.cadence, arms: this.armSpread },
    });
    this.onSimProgress?.(0);
  }

  setFabric(textile: Textile, colors: TextileColors, scale = 1) {
    this.fabric.set(textile, colors, scale);
  }

  /** The renderer's WebGPU device (null with the WebGL 2 fallback). */
  private get gpuDevice(): GPUDevice | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.backend === "WebGPU" ? ((this.renderer.backend as any).device ?? null) : null;
  }

  private addGarment(garment: Garment) {
    this.removeGarment();
    garment.mesh.castShadow = garment.mesh.receiveShadow = true;
    this.figure.add(garment.mesh);
    this.garment = garment;
    this.setFitMap(this.fitMode);
  }

  /** Shows the fit map (tension or stretch) instead of the fabric, or back (null). */
  setFitMap(mode: FitMode | null) {
    this.fitMode = mode;
    const g = this.garment;
    if (!g) return;
    g.mesh.material = mode ? this.fitMaterial : this.fabric.material;
    if (mode) g.setFitMode(mode);
  }

  /** CPU mode: the worker simulates and streams positions; the shell is built here. */
  private showCpuGarment(g: GarmentGeometry) {
    const shell = new ClothShell(g.rest, g.triangles, g.thickness, g.tensile);
    shell.update(g.initial);
    this.animator.reset(); // the worker owns the timeline now
    this.cpuBones = null;
    this.addGarment({
      mesh: new THREE.Mesh(shell.geometry, this.fabric.material),
      cpu: shell,
      setFitMode: (mode) => shell.setFitMode(mode),
      dispose: () => shell.dispose(),
    });
    this.onSimBackend?.("cpu");
  }

  private updateGarment(positions: Float32Array, progress: number, bones: Float32Array | null) {
    if (!this.garment?.cpu) return;
    this.garment.cpu.update(positions);
    this.cpuBones = bones;
    this.onSimProgress?.(progress);
  }

  /** GPU mode: simulation and shell run on the renderer's device, every frame. */
  private startGpuGarment(g: GarmentGeometry, model: ClothModel, sdf: SdfGrid) {
    const device = this.gpuDevice;
    if (!device) return;
    const solver = new GpuClothSolver(device, model, g.initial, sdf, this.skeleton.count);
    this.restartMotion(model.params);
    const shell = new GpuClothShell(this.renderer, g.rest, g.triangles, g.thickness, g.tensile, solver.positions);
    const rebuildShell = () => {
      const encoder = device.createCommandEncoder();
      shell.encode(encoder);
      device.queue.submit([encoder.finish()]);
    };
    rebuildShell();
    const mesh = new THREE.Mesh(shell.geometry, this.fabric.material);
    mesh.frustumCulled = false;
    this.addGarment({
      mesh,
      gpu: {
        solver,
        shell,
        duration: model.params.duration,
        sewTime: model.params.sewTime,
        done: false,
        still: 0,
        lastMotion: -1,
        movedAt: -Infinity,
        untangledAt: -Infinity,
      },
      setFitMode: (mode) => {
        shell.setFitMode(mode);
        rebuildShell(); // the simulation may be over: refresh the colours now
      },
      dispose: () => {
        solver.dispose();
        shell.dispose();
      },
    });
    this.onSimBackend?.("gpu");
  }

  /**
   * One rendered frame of GPU simulation: real-time pacing while the body
   * moves, else adaptive fast forward; rest detection. Advances the clock.
   */
  private stepGpuGarment(gpu: NonNullable<Garment["gpu"]>, interval: number) {
    const { solver, shell } = gpu;
    let frames: number;
    if (this.gpuInFlight >= MAX_IN_FLIGHT) {
      // The GPU is behind: render only. The body's clock follows the simulation, so
      // the motion slows down rather than piling up work.
      frames = 0;
      this.lag = 0;
    } else if (this.animator.moving(this.clock)) {
      this.lag = Math.min(MAX_LAG, this.lag + Math.max(0, interval) / 1000);
      frames = Math.min(MAX_CATCH_UP, Math.floor(this.lag / SIM_DT));
      this.lag = Math.min(this.lag - frames * SIM_DT, SIM_DT);
    } else {
      this.lag = 0;
      if (interval > 0 && interval < 200) {
        if (interval < FRAME_INTERVAL.raise) this.simFrames = Math.min(SIM_FRAMES.max, this.simFrames + 1);
        else if (interval > FRAME_INTERVAL.lower) this.simFrames = Math.max(SIM_FRAMES.min, this.simFrames - 1);
      }
      frames = this.simFrames;
    }
    if (frames > 0) {
      const t0 = this.clock;
      solver.simulate(frames, SIM_DT, (encoder) => shell.encode(encoder), (t, out) => this.animator.sample(t0 + t, out));
      this.gpuInFlight++;
      this.gpuDevice?.queue.onSubmittedWorkDone().then(() => this.gpuInFlight--);
      this.clock += frames * SIM_DT;
    }
    if (this.animator.moving(this.clock)) {
      gpu.movedAt = solver.time;
      gpu.still = 0;
    }
    // Tangled regions: analysed in the worker from read-back positions.
    if (solver.time > gpu.sewTime + SELF_DELAY && solver.time - gpu.untangledAt >= UNTANGLE_INTERVAL) {
      const read = solver.readPositions();
      if (read) {
        gpu.untangledAt = solver.time;
        read.then((p) => this.garment?.gpu === gpu && this.simulator.untangle(p)).catch(() => {});
      }
    }
    solver.measureMotion();
    const m = solver.motion;
    if (m && m.time !== gpu.lastMotion) {
      gpu.lastMotion = m.time;
      const still = m.time > gpu.sewTime + 0.5 && m.time > gpu.movedAt + 0.5 && m.mean < REST.mean && m.max < REST.max;
      gpu.still = still ? gpu.still + 1 : 0;
    }
    gpu.done =
      !this.animator.pending(this.clock) &&
      (gpu.still >= REST.count || solver.time >= Math.max(gpu.duration, gpu.movedAt + SETTLE_TIME));
    this.onSimProgress?.(gpu.done ? 1 : Math.min(1, solver.time / gpu.duration));
  }

  private removeGarment() {
    if (!this.garment) return;
    this.figure.remove(this.garment.mesh);
    this.garment.dispose();
    this.garment = null;
  }

  // --- Camera ---------------------------------------------------------------

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on;
  }

  /** Smoothly orbits the camera to a preset view. */
  goTo(view: ViewPreset) {
    const v = VIEWS[view];
    const targetTo = new THREE.Vector3(...v.target);
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const to = new THREE.Spherical().setFromVector3(new THREE.Vector3(...v.pos).sub(targetTo));
    to.theta = from.theta + Math.atan2(Math.sin(to.theta - from.theta), Math.cos(to.theta - from.theta)); // shortest way
    this.tween = { t0: performance.now(), from, to, targetFrom: this.controls.target.clone(), targetTo };
  }

  private frame(time: number) {
    const interval = time - this.lastFrameTime;
    this.lastFrameTime = time;
    const garment = this.garment;
    const gpu = garment?.gpu;
    if (gpu && (!gpu.done || this.animator.pending(this.clock))) this.stepGpuGarment(gpu, interval);
    else if (interval > 0) this.clock += Math.min(interval, 100) / 1000;
    if (garment?.cpu) this.poseBody(this.cpuBones);
    else this.poseBody(this.animator.sample(this.clock, this.bones) ? this.bones : null);
    if (this.tween) {
      const { t0, from, to, targetFrom, targetTo } = this.tween;
      const k = Math.min(1, (time - t0) / 900);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const s = new THREE.Spherical(
        from.radius + (to.radius - from.radius) * e,
        from.phi + (to.phi - from.phi) * e,
        from.theta + (to.theta - from.theta) * e,
      );
      this.controls.target.lerpVectors(targetFrom, targetTo, e);
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    // keep the whole figure in frame on narrow (portrait) screens
    this.camera.fov = w / h < 0.8 ? 38 : 28;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private setupStudio() {
    this.scene.background = new THREE.Color("#ebe7e0");
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();

    const key = new THREE.DirectionalLight("#fff6ec", 2.4);
    key.position.set(2.2, 4.2, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 2.2, bottom: -0.4, near: 1, far: 10 });
    Object.assign(key.shadow, { bias: -0.0004, normalBias: 0.015, radius: 4 });
    key.target.position.set(0, 1, 0);
    const rim = new THREE.DirectionalLight("#e6eeff", 1.4); // grazing light for the fabric sheen
    rim.position.set(-2.5, 2.8, -3.5);
    const fill = new THREE.DirectionalLight("#ffffff", 0.5);
    fill.position.set(-3, 1.5, 2);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 64).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ color: "#3b3026", opacity: 0.16 }),
    );
    floor.receiveShadow = true;
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.44, PLINTH_H, 96),
      new THREE.MeshStandardMaterial({ color: "#d9d3c9", roughness: 0.7 }),
    );
    plinth.position.y = PLINTH_H / 2;
    plinth.castShadow = plinth.receiveShadow = true;
    this.scene.add(key, key.target, rim, fill, floor, plinth);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.simulator.dispose();
    this.removeGarment();
    this.fitMaterial.dispose();
    this.fabric.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
