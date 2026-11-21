import * as THREE from "three/webgpu";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Side } from "../avatar/motion";
import type { Vec3 } from "../avatar/skeleton";

/**
 * Translation gizmos on the mannequin's wrists (body frame: children of the
 * figure), as in 3D software: a red / green / blue arrow per axis (X: the
 * mannequin's left, Y: up, Z: front) moves the hand along that axis only; the
 * sphere in the middle moves it freely on the plane facing the camera. The new
 * wrist position goes to `onDrag` (the animator places the arm by inverse
 * kinematics). Drawn over the cloth (no depth test) so a hand under a cape can
 * still be grabbed, at a constant size on screen, with larger invisible picking
 * shapes. The camera's orbit is suspended while a gizmo is held.
 */

type Axis = "x" | "y" | "z";
type Part = Axis | "free";

/** Gizmo sizes at the reference distance (m); scaled with the distance to the camera. */
const REF_DISTANCE = 3;
const CENTER = 0.022;
const ARROW = 0.13;
const SHAFT = 0.0035;
const TIP_LENGTH = 0.03;
const TIP_RADIUS = 0.011;
const PICK = { center: 0.045, shaft: 0.018 };

const COLORS: Record<Part, THREE.Color> = {
  x: new THREE.Color("#e5484d"),
  y: new THREE.Color("#30a46c"),
  z: new THREE.Color("#3e63dd"),
  free: new THREE.Color("#e8e6e1"),
};
const HOVER = new THREE.Color("#f5c400");
const AXES: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
/**
 * An axis closer than this to the line of sight (|cos|) is hidden and cannot be
 * grabbed: seen end-on, a tiny pointer motion would mean a huge move along it.
 */
const END_ON = 0.94;

const material = (color: THREE.Color, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

interface Gizmo {
  root: THREE.Group;
  /** Arrow of each axis (hidden when seen end-on). */
  arrows: Record<Axis, THREE.Group>;
  /** Visible meshes of each part, recoloured on hover. */
  parts: Record<Part, THREE.Mesh[]>;
}

interface Drag {
  side: Side;
  part: Part;
  pointer: number;
  /** Wrist position when grabbed (world). */
  origin: THREE.Vector3;
  /** Free move: plane facing the camera, offset grab point → centre. */
  plane?: THREE.Plane;
  offset?: THREE.Vector3;
  /** Axis move: world axis and the grab parameter along it. */
  axis?: THREE.Vector3;
  s0?: number;
}

export class HandHandles {
  readonly group = new THREE.Group();
  /** Called while dragging, with the wrist target (body frame, m). */
  onDrag?: (side: Side, target: Vec3) => void;
  private readonly gizmos: Record<Side, Gizmo>;
  private readonly picks: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private hovered: { side: Side; part: Part } | null = null;
  private readonly down = (e: PointerEvent) => this.onDown(e);
  private readonly move = (e: PointerEvent) => this.onMove(e);
  private readonly up = (e: PointerEvent) => this.onUp(e);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly figure: THREE.Object3D,
    private readonly controls: OrbitControls,
  ) {
    this.gizmos = { L: this.build("L"), R: this.build("R") };
    this.group.visible = false;
    figure.add(this.group);
    // Capture phase: a grabbed gizmo must not start an orbit of the camera.
    dom.addEventListener("pointerdown", this.down, { capture: true });
    dom.addEventListener("pointermove", this.move);
    dom.addEventListener("pointerup", this.up);
    dom.addEventListener("pointercancel", this.up);
  }

  private build(side: Side): Gizmo {
    const root = new THREE.Group();
    const parts: Record<Part, THREE.Mesh[]> = { x: [], y: [], z: [], free: [] };
    const arrows = {} as Record<Axis, THREE.Group>;
    const pickable = (mesh: THREE.Mesh, part: Part) => {
      mesh.userData = { side, part };
      this.picks.push(mesh);
      return mesh;
    };
    const visible = (mesh: THREE.Mesh, part: Part, order: number) => {
      mesh.renderOrder = order;
      parts[part].push(mesh);
      return mesh;
    };

    for (const axis of ["x", "y", "z"] as const) {
      // Built along +Y, then turned onto the axis.
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(SHAFT, SHAFT, ARROW - TIP_LENGTH, 10), material(COLORS[axis]));
      shaft.position.y = (ARROW - TIP_LENGTH) / 2;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(TIP_RADIUS, TIP_LENGTH, 16), material(COLORS[axis]));
      tip.position.y = ARROW - TIP_LENGTH / 2;
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(PICK.shaft, PICK.shaft, ARROW, 8), material(COLORS[axis], 0));
      pick.position.y = ARROW / 2;
      arrow.add(visible(shaft, axis, 1000), visible(tip, axis, 1000), pickable(pick, axis));
      if (axis === "x") arrow.rotation.z = -Math.PI / 2;
      if (axis === "z") arrow.rotation.x = Math.PI / 2;
      root.add(arrow);
      arrows[axis] = arrow;
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(CENTER, 20, 14), material(COLORS.free, 0.9));
    const outline = new THREE.Mesh(new THREE.SphereGeometry(CENTER * 1.25, 20, 14), material(new THREE.Color("#1c1a17"), 0.35));
    outline.renderOrder = 1000;
    root.add(outline, visible(center, "free", 1001), pickable(new THREE.Mesh(new THREE.SphereGeometry(PICK.center, 12, 8), material(COLORS.free, 0)), "free"));
    this.group.add(root);
    return { root, arrows, parts };
  }

  setVisible(on: boolean) {
    this.group.visible = on;
    if (!on) this.setHover(null);
  }

  /** Places the gizmos on the wrists (body frame), at a constant size on screen. */
  update(wrists: Record<Side, Vec3>) {
    for (const side of ["L", "R"] as const) {
      const root = this.gizmos[side].root;
      root.position.set(...wrists[side]);
      const world = root.getWorldPosition(new THREE.Vector3());
      root.scale.setScalar(world.distanceTo(this.camera.position) / REF_DISTANCE);
      const sight = world.sub(this.camera.position).normalize();
      for (const axis of ["x", "y", "z"] as const) {
        const dir = AXES[axis].clone().transformDirection(this.figure.matrixWorld);
        // Kept visible while it is being dragged.
        const held = this.drag?.side === side && this.drag.part === axis;
        this.gizmos[side].arrows[axis].visible = held || Math.abs(dir.dot(sight)) < END_ON;
      }
    }
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  private ray(e: PointerEvent): THREE.Ray {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  private pickAt(e: PointerEvent): { side: Side; part: Part } | null {
    if (!this.group.visible) return null;
    this.ray(e);
    // Hidden (end-on) arrows are not pickable: intersectObjects skips nothing by itself.
    const pickable = this.picks.filter((m) => m.parent?.visible !== false);
    const hits = this.raycaster.intersectObjects(pickable, false);
    if (!hits.length) return null;
    // The centre wins whenever it is under the pointer (an arrow may pass in front of it).
    const hit = hits.find((h) => h.object.userData.part === "free") ?? hits[0];
    return { side: hit.object.userData.side as Side, part: hit.object.userData.part as Part };
  }

  /** Parameter along the axis line (origin, axis) of its closest point to the pointer ray. */
  private axisParameter(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): number | null {
    const w0 = origin.clone().sub(ray.origin);
    const b = axis.dot(ray.direction);
    const den = 1 - b * b;
    if (den < 1 - END_ON * END_ON) return null; // axis (almost) along the line of sight
    return (b * ray.direction.dot(w0) - axis.dot(w0)) / den;
  }

  private onDown(e: PointerEvent) {
    const picked = this.pickAt(e);
    if (!picked) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const origin = this.gizmos[picked.side].root.getWorldPosition(new THREE.Vector3());
    const ray = this.ray(e);
    const drag: Drag = { ...picked, pointer: e.pointerId, origin };
    if (picked.part === "free") {
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), origin);
      const hit = ray.intersectPlane(drag.plane, new THREE.Vector3());
      drag.offset = hit ? origin.clone().sub(hit) : new THREE.Vector3();
    } else {
      drag.axis = AXES[picked.part].clone().transformDirection(this.figure.matrixWorld);
      drag.s0 = this.axisParameter(ray, origin, drag.axis) ?? 0;
    }
    this.drag = drag;
    this.controls.enabled = false;
    this.dom.setPointerCapture(e.pointerId);
    this.dom.style.cursor = "grabbing";
    this.setHover(picked);
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      this.setHover(this.pickAt(e));
      return;
    }
    if (e.pointerId !== d.pointer) return;
    const ray = this.ray(e);
    let world: THREE.Vector3 | null = null;
    if (d.plane) {
      const hit = ray.intersectPlane(d.plane, new THREE.Vector3());
      world = hit ? hit.add(d.offset!) : null;
    } else {
      const s = this.axisParameter(ray, d.origin, d.axis!);
      world = s === null ? null : d.origin.clone().addScaledVector(d.axis!, s - d.s0!);
    }
    if (!world) return;
    const local = this.figure.worldToLocal(world);
    this.onDrag?.(d.side, [local.x, local.y, local.z]);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.controls.enabled = true;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    for (const m of this.gizmos[d.side].parts[d.part]) (m.material as THREE.MeshBasicMaterial).color.copy(COLORS[d.part]);
    this.hovered = null;
    this.setHover(this.pickAt(e));
  }

  private setHover(next: { side: Side; part: Part } | null) {
    const same = (a: typeof next, b: typeof next) => a?.side === b?.side && a?.part === b?.part;
    if (same(next, this.hovered) && next) return;
    const paint = (h: { side: Side; part: Part }, color: THREE.Color) => {
      for (const m of this.gizmos[h.side].parts[h.part]) (m.material as THREE.MeshBasicMaterial).color.copy(color);
    };
    if (this.hovered && !(this.drag && same(this.hovered, this.drag))) paint(this.hovered, COLORS[this.hovered.part]);
    if (next) paint(next, HOVER);
    this.hovered = next;
    if (!this.drag) this.dom.style.cursor = next ? "grab" : "";
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.dom.removeEventListener("pointerdown", this.down, { capture: true });
    this.dom.removeEventListener("pointermove", this.move);
    this.dom.removeEventListener("pointerup", this.up);
    this.dom.removeEventListener("pointercancel", this.up);
    this.figure.remove(this.group);
  }
}
