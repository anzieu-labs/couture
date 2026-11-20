import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AnnyModel, BodyShape, LocalChanges, Phenotype } from "../avatar/anny";
import { measureForPattern, type TorsoFrame } from "../avatar/bodyMeasures";
import { loadAnnyModel } from "../avatar/loadAnny";
import { measureBody, type BodyMeasurement } from "../avatar/measure";
import { GarmentSimulator } from "../garment/GarmentSimulator";
import { MeshSlicer } from "../geometry/slice";
import type { BodyMeasures, Pattern } from "../pattern/tshirt";
import type { ClothParams } from "../sim/cloth";
import type { Textile } from "../textiles/catalog";
import type { TextileColors } from "../textiles/generate";
import { FabricMaterial } from "./FabricMaterial";

export type ViewPreset = "face" | "profil" | "dos" | "buste";

const PLINTH_H = 0.04;
const VIEWS: Record<ViewPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  face: { pos: [0, 1.2, 4.5], target: [0, 0.94, 0] },
  profil: { pos: [4.5, 1.2, 0.2], target: [0, 0.94, 0] },
  dos: { pos: [0, 1.2, -4.5], target: [0, 0.94, 0] },
  buste: { pos: [0.55, 1.42, 1.85], target: [0, 1.2, 0] },
};

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
 * sewn from its flat pattern and draped in a worker (XPBD cloth solver).
 */
export class GarmentViewer {
  readonly backend: "WebGPU" | "WebGL 2";
  /** Called with the sewing/draping progress (0..1). */
  onSimProgress?: (progress: number) => void;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly figure = new THREE.Group();
  private readonly bodyGeo = new THREE.BufferGeometry();
  private readonly body: THREE.Mesh;
  private readonly fabric: FabricMaterial;
  private readonly simulator: GarmentSimulator;
  private garment: THREE.Mesh | null = null;
  private shape: BodyShape | null = null;
  private slicer: MeshSlicer | null = null;
  private tween: Tween | null = null;

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

    // Mannequin: positions are rewritten on every morphology change.
    this.bodyGeo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(anny.base), 3));
    this.bodyGeo.setIndex(new THREE.BufferAttribute(anny.indices, 1));
    this.body = new THREE.Mesh(
      this.bodyGeo,
      new THREE.MeshPhysicalMaterial({ color: "#efe9e0", roughness: 0.55, clearcoat: 0.1, clearcoatRoughness: 0.6 }),
    );
    this.body.castShadow = this.body.receiveShadow = true;
    this.figure.add(this.body);
    this.scene.add(this.figure);
    this.setBody(anny.defaults());

    this.fabric = new FabricMaterial(renderer.getMaxAnisotropy());
    this.simulator = new GarmentSimulator({
      onMesh: (m) => this.showGarment(m.rest, m.triangles, m.positions),
      onFrame: (positions, progress) => this.updateGarment(positions, progress),
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
    const shape = this.anny.compute(phenotype, localChanges, attr.array as Float32Array);
    let minY = Infinity;
    for (let i = 1; i < shape.positions.length; i += 3) minY = Math.min(minY, shape.positions[i]);
    this.figure.position.y = PLINTH_H - minY;
    attr.needsUpdate = true;
    this.bodyGeo.computeVertexNormals();
    this.bodyGeo.computeBoundingSphere();
    this.shape = shape;
    this.slicer = null;
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
    this.simulator.dress({
      pattern,
      torso,
      cloth,
      body: {
        positions: Float32Array.from(this.shape.positions),
        normals: Float32Array.from(this.bodyGeo.getAttribute("normal").array as Float32Array),
        joints: this.shape.joints,
      },
    });
    this.onSimProgress?.(0);
  }

  setFabric(textile: Textile, colors: TextileColors, scale = 1) {
    this.fabric.set(textile, colors, scale);
  }

  private showGarment(rest: Float32Array, triangles: Uint32Array, positions: Float32Array) {
    this.removeGarment();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(rest, 2));
    geo.setIndex(new THREE.BufferAttribute(triangles, 1));
    geo.computeVertexNormals();
    this.garment = new THREE.Mesh(geo, this.fabric.material);
    this.garment.castShadow = this.garment.receiveShadow = true;
    this.figure.add(this.garment);
  }

  private updateGarment(positions: Float32Array, progress: number) {
    if (!this.garment) return;
    const geo = this.garment.geometry;
    const attr = geo.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(positions);
    attr.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.onSimProgress?.(progress);
  }

  private removeGarment() {
    if (!this.garment) return;
    this.figure.remove(this.garment);
    this.garment.geometry.dispose();
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
