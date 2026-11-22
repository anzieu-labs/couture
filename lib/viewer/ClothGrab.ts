import * as THREE from "three/webgpu";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Vec3 } from "../avatar/skeleton";

/** A triangle mesh as flat arrays, in the figure's frame. */
export interface PickMesh {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
}

/** The skin may show through the cloth lying on it: the cloth is still the one picked (m). */
const SKIN_TOLERANCE = 0.01;

/** Nearest triangle crossed by the ray (origin, unit direction), from either side: its index and the distance along the ray. */
export function raycast(mesh: PickMesh, o: THREE.Vector3, d: THREE.Vector3): { triangle: number; distance: number } | null {
  const P = mesh.positions, T = mesh.triangles;
  let best = Infinity, triangle = -1;
  for (let t = 0; t < T.length; t += 3) {
    const i0 = 3 * T[t], i1 = 3 * T[t + 1], i2 = 3 * T[t + 2];
    const ox = P[i0], oy = P[i0 + 1], oz = P[i0 + 2];
    const e1x = P[i1] - ox, e1y = P[i1 + 1] - oy, e1z = P[i1 + 2] - oz;
    const e2x = P[i2] - ox, e2y = P[i2 + 1] - oy, e2z = P[i2 + 2] - oz;
    // Möller–Trumbore.
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const sx = o.x - ox, sy = o.y - oy, sz = o.z - oz;
    const u = (sx * px + sy * py + sz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const w = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (w > 0 && w < best) [best, triangle] = [w, t / 3];
  }
  return triangle < 0 ? null : { triangle, distance: best };
}

/**
 * Taking hold of the garment with the pointer: pressing on the cloth picks the point under
 * the pointer, dragging moves the hand on the plane facing the camera through that point,
 * releasing lets go (the simulation does the rest: lib/sim/grab.ts). Pressing anywhere else
 * orbits the camera as usual; the orbit is suspended while the cloth is held. The viewer
 * sets the cursor (`cursor`).
 *
 * Picking is done here, against the latest cloth positions known on this side (`cloth`) and
 * the body as posed (`body`): cloth hidden behind the body is not picked.
 */
export class ClothGrab {
  /** The cloth is picked: its triangle and the point on it (body frame, m). Return false to refuse. */
  onStart?: (triangle: number, point: Vec3) => boolean;
  /** The hand moved (body frame, m). */
  onMove?: (target: Vec3) => void;
  onEnd?: () => void;
  private drag: { pointer: number; plane: THREE.Plane } | null = null;
  private hovering = false;
  /** Latest pointer position not yet tested for hovering (one test per rendered frame: `update`). */
  private moved: { clientX: number; clientY: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly down = (e: PointerEvent) => this.onDown(e);
  private readonly move = (e: PointerEvent) => this.onMoved(e);
  private readonly up = (e: PointerEvent) => this.onUp(e);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly figure: THREE.Object3D,
    private readonly controls: OrbitControls,
    private readonly cloth: () => PickMesh | null,
    private readonly body: () => PickMesh | null,
  ) {
    // Capture phase: holding the cloth must not start an orbit of the camera.
    dom.addEventListener("pointerdown", this.down, { capture: true });
    dom.addEventListener("pointermove", this.move);
    dom.addEventListener("pointerup", this.up);
    dom.addEventListener("pointercancel", this.up);
    dom.addEventListener("lostpointercapture", this.up);
  }

  get holding(): boolean {
    return this.drag !== null;
  }

  /** Cursor over cloth that can be held, or holding it; null elsewhere. */
  get cursor(): string | null {
    return this.drag ? "grabbing" : this.hovering ? "grab" : null;
  }

  /** Lets go (the garment is replaced). */
  cancel() {
    if (!this.drag) return;
    const { pointer } = this.drag;
    this.drag = null;
    this.controls.enabled = true;
    if (this.dom.hasPointerCapture(pointer)) this.dom.releasePointerCapture(pointer);
    this.hovering = false;
    this.onEnd?.();
  }

  /** Once per rendered frame: the "grab" cursor over cloth that can be held. */
  update() {
    if (!this.moved || this.drag) return;
    this.hovering = !!this.pick(this.moved);
    this.moved = null;
  }

  /** The pointer's ray, in the world. */
  private ray(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** The cloth under the pointer, unless the body is in front of it: triangle and point (body frame). */
  private pick(e: { clientX: number; clientY: number }): { triangle: number; point: THREE.Vector3 } | null {
    const cloth = this.cloth();
    if (!cloth) return null;
    const local = this.ray(e).clone().applyMatrix4(this.figure.matrixWorld.clone().invert());
    const hit = raycast(cloth, local.origin, local.direction);
    if (!hit) return null;
    const body = this.body();
    const skin = body && raycast(body, local.origin, local.direction);
    if (skin && skin.distance < hit.distance - SKIN_TOLERANCE) return null;
    return { triangle: hit.triangle, point: local.at(hit.distance, new THREE.Vector3()) };
  }

  private onDown(e: PointerEvent) {
    if (this.drag || e.button !== 0 || !e.isPrimary) return;
    const picked = this.pick(e);
    if (!picked || !this.onStart?.(picked.triangle, [picked.point.x, picked.point.y, picked.point.z])) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.moved = null;
    const world = this.figure.localToWorld(picked.point);
    this.drag = {
      pointer: e.pointerId,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), world),
    };
    this.controls.enabled = false;
    this.dom.setPointerCapture(e.pointerId);
  }

  private onMoved(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      // Hover: only with no button down (the camera may be orbiting); tested in `update`.
      this.moved = e.buttons === 0 ? { clientX: e.clientX, clientY: e.clientY } : null;
      return;
    }
    if (e.pointerId !== d.pointer) return;
    const hit = this.ray(e).intersectPlane(d.plane, new THREE.Vector3());
    if (!hit) return;
    const local = this.figure.worldToLocal(hit);
    this.onMove?.([local.x, local.y, local.z]);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    this.cancel();
    // The cursor for what is now under the pointer, at the next frame.
    this.moved = { clientX: e.clientX, clientY: e.clientY };
  }

  dispose() {
    this.cancel();
    this.dom.removeEventListener("pointerdown", this.down, { capture: true });
    this.dom.removeEventListener("pointermove", this.move);
    this.dom.removeEventListener("pointerup", this.up);
    this.dom.removeEventListener("pointercancel", this.up);
    this.dom.removeEventListener("lostpointercapture", this.up);
  }
}
