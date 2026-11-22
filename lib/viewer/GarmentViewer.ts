import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AnnyModel, BodyShape, LocalChanges, Phenotype } from "../avatar/anny";
import { measureForPattern, type TorsoFrame } from "../avatar/bodyMeasures";
import { loadAnnyModel } from "../avatar/loadAnny";
import { measureBody, type BodyMeasurement } from "../avatar/measure";
import { Animator, CADENCE, MOTION_DELAY, standingBody, type Posture, type Side } from "../avatar/motion";
import { BONE_STRIDE, Skeleton, skinVertices, type Vec3 } from "../avatar/skeleton";
import { GarmentSimulator } from "../garment/GarmentSimulator";
import { MeshSlicer } from "../geometry/slice";
import type { P2 } from "../pattern/curves";
import type { BodyMeasures, Handle, Pattern } from "../pattern/types";
import { PLINTH, REST, restDeadline, SELF_DELAY, type ClothParams } from "../sim/model";
import { UNTANGLE_INTERVAL } from "../sim/selfCollision";
import type { Textile } from "../textiles/catalog";
import type { TextileColors } from "../textiles/generate";
import { GpuClothSolver } from "../sim/gpu/GpuClothSolver";
import type { GarmentGeometry } from "../garment/protocol";
import type { SdfGrid } from "../sim/bodySdf";
import { selectGrab } from "../sim/grab";
import type { ClothModel } from "../sim/model";
import { ClothGrab, type PickMesh } from "./ClothGrab";
import { ClothShell } from "./ClothShell";
import type { FitMode } from "./fitMap";
import { GpuClothShell } from "./GpuClothShell";
import { HandHandles } from "./HandHandles";
import { FabricMaterial } from "./FabricMaterial";
import { PatternOverlay, type EdgeColor } from "./PatternOverlay";

export type ViewPreset = "face" | "profil" | "dos" | "buste";

const PLINTH_H = PLINTH.height;
const VIEWS: Record<ViewPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  face: { pos: [0, 1.2, 4.5], target: [0, 0.94, 0] },
  profil: { pos: [4.5, 1.2, 0.2], target: [0, 0.94, 0] },
  dos: { pos: [0, 1.2, -4.5], target: [0, 0.94, 0] },
  buste: { pos: [0.55, 1.42, 1.85], target: [0, 1.2, 0] },
};

/**
 * GPU mode pacing: real time, always — a garment is sewn and falls at the speed it would, as
 * it does when the hand or the body moves it afterwards. It used to be put on in fast forward,
 * as many simulated frames per rendered frame as kept the display above ~45 fps (2 to 24,
 * adjusted from the measured frame interval): the adjustment lagged behind the cost of the
 * frames, and what was seen was a garment jumping into place at a few images a second.
 */
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
/** GPU mode: the cloth's positions are read back for picking this often while it moves (ms). */
const PICK_REFRESH = 120;

interface Garment {
  mesh: THREE.Mesh;
  /** Mid-surface triangles and the latest positions known on this side (CPU mode: streamed; GPU mode: read back), for picking. */
  triangles: Uint32Array;
  positions: Float32Array | null;
  /** Simulated time (CPU mode; GPU mode: the solver's), and from when the cloth may be held by hand. */
  time: number;
  grabFrom: number;
  /** CPU mode: shell rebuilt from streamed positions. */
  cpu?: ClothShell;
  /** GPU mode: simulated and rebuilt on the GPU every frame. */
  gpu?: {
    solver: GpuClothSolver;
    shell: GpuClothShell;
    model: ClothModel;
    duration: number;
    sewTime: number;
    /** From when the garment is all put together (ClothModel.fastenedAt): it may come to rest only after. */
    fastenedAt: number;
    done: boolean;
    still: number;
    lastMotion: number;
    /** Simulated time the motion was last asked for (REST.window apart). */
    measuredAt: number;
    /** Simulated time the body last moved at. */
    movedAt: number;
    /** Simulated time of the last intersection analysis request. */
    untangledAt: number;
    /** Picking: simulated time of `positions`, and when they were last asked for (ms). */
    readTime: number;
    readAt: number;
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
 * The cloth can be held with the pointer and pulled (ClothGrab, lib/sim/grab.ts):
 * the simulation then runs in real time, as when the body moves. While the 2D
 * pattern editor is open, the pattern is drawn on the garment and its points can
 * be dragged there too (PatternOverlay).
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
  /** Called when an arm is placed by hand or released (sides whose wrist has a target). */
  onHandsChange?: (placed: Record<Side, boolean>) => void;
  /** A pattern point is dragged on the garment: its move so far on the pattern (cm); `done` when released. */
  onPatternEdit?: (key: string, move: P2, done: boolean) => void;
  /** The pattern point under the pointer or being dragged on the garment changed. */
  onPatternFocus?: (key: string | null) => void;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly figure = new THREE.Group();
  private readonly handles: HandHandles;
  private readonly grabber: ClothGrab;
  private readonly overlay: PatternOverlay;
  /** Pattern of the latest garment asked for: the one on screen once its mesh arrives. */
  private dressing: Pattern | null = null;
  private cursor = "";
  private readonly bodyGeo = new THREE.BufferGeometry();
  private readonly body: THREE.Mesh;
  private readonly fabric: FabricMaterial;
  private readonly simulator: GarmentSimulator;
  private garment: Garment | null = null;
  /** null: fabric rendering; otherwise the fit map is shown. */
  private fitMode: FitMode | null = null;
  private readonly fitMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  private shape: BodyShape | null = null;
  /** Rest pose of the current morphology (an A-pose): measured, and sent to be dressed. */
  private restPositions: Float32Array;
  private restNormals: Float32Array;
  /**
   * The same body as it stands (avatar/motion.ts standingBody): what is shown when it stands
   * still, and what the animator's bone transforms apply to (the geometry holds the posed body).
   */
  private stand!: ReturnType<typeof standingBody>;
  private skeleton!: Skeleton;
  private animator!: Animator;
  /** Animation clock (s). */
  private clock = 0;
  private lag = 0;
  /** Simulated frames submitted to the GPU and not completed. */
  private gpuInFlight = 0;
  private walkWanted = false;
  private cadence = CADENCE.default;
  private posture: Posture = "standing";
  private posed = false;
  private readonly bones: Float32Array;
  /** CPU mode: pose of the latest simulated frame. */
  private cpuBones: Float32Array | null = null;
  private slicer: MeshSlicer | null = null;
  private tween: Tween | null = null;
  private lastFrameTime = 0;

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
    this.body.frustumCulled = false; // posed on the CPU, bounds of the standing pose
    this.figure.add(this.body);
    this.scene.add(this.figure);
    this.setBody(anny.defaults());
    this.handles = new HandHandles(this.camera, renderer.domElement, this.figure, this.controls);
    this.handles.onDrag = (side, target) => this.setHandTarget(side, target);
    const skin = () => ({ positions: this.bodyGeo.getAttribute("position").array, triangles: anny.indices });
    // Before the cloth's hold: a pattern point wins over the cloth under it.
    this.overlay = new PatternOverlay(this.camera, renderer.domElement, this.figure, this.controls, () => [this.pickable(), skin()]);
    this.overlay.onEdit = (key, move, done) => this.onPatternEdit?.(key, move, done);
    this.overlay.onFocus = (key) => this.onPatternFocus?.(key);
    this.grabber = new ClothGrab(this.camera, renderer.domElement, this.figure, this.controls, () => this.pickable(), skin);
    this.grabber.onStart = (triangle, point) => this.startGrab(triangle, point);
    this.grabber.onMove = (target) => {
      const g = this.garment;
      if (g?.gpu) g.gpu.solver.moveGrab(target);
      else if (g) this.simulator.grab({ target });
    };
    this.grabber.onEnd = () => {
      const g = this.garment;
      if (g?.gpu) {
        g.gpu.solver.setGrab(null);
      } else if (g) this.simulator.grab({ release: true });
    };

    this.fabric = new FabricMaterial(renderer.getMaxAnisotropy());
    this.simulator = new GarmentSimulator({
      onMesh: (m) => this.showCpuGarment(m),
      onModel: (m) => this.startGpuGarment(m, m.model, m.sdf),
      onFrame: (positions, time, progress, bones) => this.updateGarment(positions, time, progress, bones),
      onTangles: (tangle) => this.garment?.gpu?.solver.setTangles(tangle),
      onTethers: (tethers) => this.garment?.gpu?.solver.setTethers(tethers),
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
    this.bodyGeo.computeVertexNormals();
    this.restNormals.set(normals.array as Float32Array);
    this.shape = shape;
    this.slicer = null;

    const { labels, parents } = this.anny.meta.bones;
    this.skeleton = new Skeleton(labels, parents, shape.joints, shape.positions, this.anny.skin);
    if (this.animator) {
      this.animator.skeleton = this.skeleton;
      this.animator.restore(this.clock);
    } else this.animator = new Animator(this.skeleton);
    // Shown standing (arms along the body), never in the rest pose.
    this.stand = standingBody(this.animator, { positions: shape.positions, normals: this.restNormals, joints: shape.joints }, this.anny.skin);
    (attr.array as Float32Array).set(this.stand.positions);
    (normals.array as Float32Array).set(this.stand.normals);
    attr.needsUpdate = normals.needsUpdate = true;
    this.bodyGeo.computeBoundingSphere();
    this.posed = false;
  }

  /** Poses the rendered body by bone transforms from the standing pose (null: standing still). */
  private poseBody(bones: Float32Array | null) {
    if (!bones && !this.posed) return;
    const attr = this.bodyGeo.getAttribute("position") as THREE.BufferAttribute;
    const normals = this.bodyGeo.getAttribute("normal") as THREE.BufferAttribute;
    if (bones) {
      skinVertices(this.stand.positions, this.stand.normals, this.anny.skin, bones, attr.array as Float32Array, normals.array as Float32Array);
    } else {
      (attr.array as Float32Array).set(this.stand.positions);
      (normals.array as Float32Array).set(this.stand.normals);
    }
    attr.needsUpdate = normals.needsUpdate = true;
    this.posed = !!bones;
  }

  // --- Motion -----------------------------------------------------------------

  /** Walks in place (looped) or stops; with a garment, starts once it is sewn. */
  setWalking(on: boolean) {
    this.walkWanted = on;
    if (on) this.posture = "standing"; // the mannequin stands up to walk
    this.animator.setWalking(on, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ walk: on });
  }

  /** Standing, seated or squatting (eased); sitting or squatting stops the walk. With a garment, applied once it is sewn. */
  setPosture(posture: Posture) {
    this.posture = posture;
    if (posture !== "standing") this.walkWanted = false;
    this.animator.setPosture(posture, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ posture });
  }

  /** Walking cadence (steps per minute). */
  setCadence(stepsPerMinute: number) {
    this.cadence = stepsPerMinute;
    this.animator.setCadence(stepsPerMinute, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ cadence: stepsPerMinute });
  }

  /**
   * Places an arm by its wrist (body frame, m), by inverse kinematics; null gives it
   * back to the arm spread. With a garment, applied once it is sewn.
   */
  setHandTarget(side: Side, target: Vec3 | null) {
    this.animator.setHandTarget(side, target, this.clock);
    if (this.garment?.cpu) this.simulator.motion({ hand: { side, target } });
    const t = this.animator.handTargets;
    this.onHandsChange?.({ L: !!t.L, R: !!t.R });
  }

  /** Both arms back to the arm spread. */
  releaseHands() {
    for (const side of ["L", "R"] as const) if (this.animator.handTargets[side]) this.setHandTarget(side, null);
  }

  /** Shows the wrist handles (Pose tab). */
  setHandlesVisible(on: boolean) {
    this.handles.setVisible(on);
  }

  /** Wrist positions (body frame) for the given bone transforms (null: standing still). */
  private wrists(bones: Float32Array | null): Record<Side, Vec3> {
    const out = {} as Record<Side, Vec3>;
    for (const side of ["L", "R"] as const) {
      const [x, y, z] = this.stand.joints[`wrist.${side}`] ?? [0, 0, 0];
      const k = this.skeleton.index[`wrist.${side}`];
      if (!bones || k === undefined) {
        out[side] = [x, y, z];
        continue;
      }
      const o = k * BONE_STRIDE;
      out[side] = [0, 1, 2].map((r) => bones[o + 4 * r] * x + bones[o + 4 * r + 1] * y + bones[o + 4 * r + 2] * z + bones[o + 4 * r + 3]) as Vec3;
    }
    return out;
  }

  /** One full turn on the plinth (stops walking first). */
  turn() {
    this.walkWanted = false;
    this.animator.startTurn(this.clock);
    if (this.garment?.cpu) this.simulator.motion({ turn: true });
  }

  /** Starts a new garment's timeline: standing still while it is sewn, then the requested walk. */
  private restartMotion(params: Pick<ClothParams, "sewTime" | "settleTime">) {
    this.animator.reset();
    this.animator.holdUntil(this.clock + params.sewTime + params.settleTime + MOTION_DELAY);
    this.animator.restore(this.clock);
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
    this.dressing = pattern;
    // The new garment is placed on the body standing still: ease back to that meanwhile.
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
        indices: this.anny.indices,
        joints: this.shape.joints,
        skin: this.anny.skin,
        rig: { labels, parents },
      },
      motion: { walking: this.walkWanted, cadence: this.cadence, hands: this.animator.handTargets, posture: this.posture },
    });
    this.onSimProgress?.(0);
  }

  setFabric(textile: Textile, colors: TextileColors, scale = 1) {
    this.fabric.set(textile, colors, scale);
  }

  // --- The pattern on the garment ----------------------------------------------

  /**
   * Draws the pattern on the garment (2D editor open): its edges in the colours `colorOf`
   * gives them, its points where they sit on the cloth, draggable (onPatternEdit). Null hides it.
   */
  setPatternOverlay(colorOf: EdgeColor | null) {
    this.overlay.show(colorOf);
    if (colorOf && this.garment?.positions) this.overlay.update(this.garment.positions);
  }

  /** The pattern's points as the 2D editor currently draws them (being edited or not). */
  setPatternHandles(handles: Handle[]) {
    this.overlay.setHandles(handles);
  }

  /** Highlights the point selected or hovered in the 2D editor. */
  setPatternFocus(key: string | null) {
    this.overlay.setFocus(key);
  }

  /** Highlights edges of the pattern on the garment (`piece/edge`: those of the seam pointed at in the 2D editor's list). */
  setPatternHighlight(edges: ReadonlySet<string>) {
    this.overlay.setHighlight(edges);
  }

  /** The new garment on screen, for the overlay: drawn on it once it has fallen into its drape. */
  private overlayGarment(g: GarmentGeometry) {
    this.overlay.hold(true);
    if (this.dressing) this.overlay.setGarment({ pattern: this.dressing, rest: g.rest, triangles: g.triangles, piece: g.piece, pieceIds: g.pieceIds, outline: g.outline, thickness: g.thickness }, g.initial);
  }

  // --- Holding the cloth ------------------------------------------------------

  /** The cloth as it can be picked: once sewn, where it was last seen from this side. */
  private pickable(): PickMesh | null {
    const g = this.garment;
    if (!g?.positions || (g.gpu ? g.gpu.solver.time : g.time) < g.grabFrom) return null;
    return { positions: g.positions, triangles: g.triangles };
  }

  /** The pointer takes hold of the cloth at `point`, on `triangle`; false if it cannot. */
  private startGrab(triangle: number, point: Vec3): boolean {
    const g = this.garment;
    if (!g?.positions) return false;
    if (g.gpu) {
      const patch = selectGrab(g.gpu.model, g.positions, triangle, point);
      if (!patch) return false;
      g.gpu.solver.setGrab(patch, point);
      g.gpu.done = false; // wakes the simulation up
    } else this.simulator.grab({ start: { triangle, point } });
    return true;
  }

  /**
   * GPU mode: keeps the positions known on this side up to date (read back: a few frames late
   * while the cloth moves) — for picking, and every frame for the pattern drawn on the garment.
   */
  private refreshPick(g: Garment, now: number) {
    const gpu = g.gpu;
    const drawn = this.overlay.visible;
    if (!gpu || (this.grabber.holding && !drawn)) return;
    const time = gpu.solver.time;
    if (time === gpu.readTime || (!drawn && (time < g.grabFrom || now - gpu.readAt < PICK_REFRESH))) return;
    const read = gpu.solver.readPositions();
    if (!read) return;
    gpu.readAt = now;
    read
      .then((p) => {
        g.positions = p;
        gpu.readTime = time;
        if (this.garment === g) this.overlay.update(p);
      })
      .catch(() => {});
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
      triangles: g.triangles,
      positions: g.initial,
      time: 0,
      grabFrom: g.grabFrom,
      cpu: shell,
      setFitMode: (mode) => shell.setFitMode(mode),
      dispose: () => shell.dispose(),
    });
    this.overlayGarment(g);
    this.onSimBackend?.("cpu");
  }

  private updateGarment(positions: Float32Array, time: number, progress: number, bones: Float32Array | null) {
    if (!this.garment?.cpu) return;
    this.garment.cpu.update(positions);
    this.garment.positions = positions;
    this.garment.time = time;
    this.overlay.update(positions);
    if (progress >= 1) this.overlay.hold(false);
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
      triangles: g.triangles,
      positions: null,
      time: 0,
      grabFrom: g.grabFrom,
      gpu: {
        solver,
        shell,
        model,
        duration: model.params.duration,
        sewTime: model.params.sewTime,
        fastenedAt: model.fastenedAt,
        done: false,
        still: 0,
        lastMotion: -1,
        measuredAt: -Infinity,
        movedAt: -Infinity,
        untangledAt: -Infinity,
        readTime: -1,
        readAt: -Infinity,
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
    this.overlayGarment(g);
    this.onSimBackend?.("gpu");
  }

  /**
   * One rendered frame of GPU simulation, in real time; rest detection.
   * Advances the clock.
   */
  private stepGpuGarment(gpu: NonNullable<Garment["gpu"]>, interval: number) {
    const { solver, shell } = gpu;
    const holding = this.grabber.holding;
    let frames = 0;
    if (this.gpuInFlight >= MAX_IN_FLIGHT) {
      // The GPU is behind: render only. The body's clock follows the simulation, so
      // the motion slows down rather than piling up work.
      this.lag = 0;
    } else {
      this.lag = Math.min(MAX_LAG, this.lag + Math.max(0, interval) / 1000);
      frames = Math.min(MAX_CATCH_UP, Math.floor(this.lag / SIM_DT));
      this.lag = Math.min(this.lag - frames * SIM_DT, SIM_DT);
    }
    // Motion mode (sim/tether.ts): while the body runs, the garment is held by its tethers.
    solver.tethered = this.animator.running(this.clock);
    if (frames > 0) {
      const t0 = this.clock;
      solver.simulate(frames, SIM_DT, (encoder) => shell.encode(encoder), (t, out) => this.animator.sample(t0 + t, out));
      this.gpuInFlight++;
      this.gpuDevice?.queue.onSubmittedWorkDone().then(() => this.gpuInFlight--);
      this.clock += frames * SIM_DT;
    }
    if (this.animator.moving(this.clock) || holding) {
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
    // At rest (sim/model.ts REST): no point went anywhere over the last stretches of time, each
    // of them whole after the garment was put together and after the body or the hand last moved.
    if (solver.time - gpu.measuredAt >= REST.window) {
      gpu.measuredAt = solver.time;
      solver.measureMotion();
    }
    const m = solver.motion;
    if (m && m.time !== gpu.lastMotion) {
      gpu.lastMotion = m.time;
      const whole = m.since >= Math.max(gpu.fastenedAt, gpu.movedAt) && m.time - m.since < 2 * REST.window;
      gpu.still = whole && m.max < REST.speed ? gpu.still + 1 : 0;
    }
    gpu.done = !this.animator.pending(this.clock) && !holding && (gpu.still >= REST.windows || solver.time >= restDeadline(gpu.duration, gpu.movedAt));
    if (gpu.done) {
      this.overlay.hold(false);
      // At rest with the body standing: the garment is fastened to the skeleton as it hangs (for
      // the next run) — worked out in the worker, from the positions read back.
      if (!this.animator.sample(this.clock, this.bones)) {
        const read = solver.readPositions();
        read?.then((p) => this.garment?.gpu === gpu && this.simulator.bind(p)).catch(() => {});
      }
    }
    this.onSimProgress?.(gpu.done ? 1 : Math.min(1, solver.time / gpu.duration));
  }

  private removeGarment() {
    if (!this.garment) return;
    this.grabber.cancel();
    this.overlay.setGarment(null);
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
    if (garment) this.refreshPick(garment, time);
    this.grabber.update();
    this.overlay.frame();
    // A pattern point wins over the cloth under it.
    const cursor = this.overlay.cursor ?? this.grabber.cursor ?? "";
    if (cursor !== this.cursor) this.renderer.domElement.style.cursor = this.cursor = cursor;
    const bones = garment?.cpu ? this.cpuBones : this.animator.sample(this.clock, this.bones) ? this.bones : null;
    this.poseBody(bones);
    this.handles.update(this.wrists(bones));
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
      new THREE.CylinderGeometry(PLINTH.radius, PLINTH.radius + 0.02, PLINTH_H, 96),
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
    this.handles.dispose();
    this.grabber.dispose();
    this.overlay.dispose();
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
