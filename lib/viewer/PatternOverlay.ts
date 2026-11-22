import * as THREE from "three/webgpu";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import type { P2 } from "../pattern/curves";
import type { Handle, Pattern } from "../pattern/types";
import { raycast, type PickMesh } from "./ClothGrab";

/** The garment on screen, as the overlay needs it: its pattern and how its mesh maps to it. */
export interface OverlayGarment {
  pattern: Pattern;
  /** Flat pattern coordinates of the vertices (m, 2 each, in their piece's frame). */
  rest: Float32Array;
  triangles: Uint32Array;
  /** Piece index of each vertex, and the pieces' ids. */
  piece: Uint8Array;
  pieceIds: string[];
  /** Mesh vertices along each pattern edge. */
  outline: { piece: string; edge: string; vertices: Uint32Array }[];
  /** Fabric thickness (m). */
  thickness: number;
}

/** Colour of a pattern edge (its seam's, as in the 2D editor); null: not sewn. */
export type EdgeColor = (piece: string, edge: string) => string | null;

const INK = "#1c1a17";
const ACCENT = "#c0643e";
/** Lines are drawn this far off the fabric's faces (m), on both sides: seen from outside and from inside. */
const LIFT = 0.0012;
/** Widths (px) of the seam lines and of the other outlines. */
const WIDTH = { seam: 3.5, plain: 1.5, hot: 7 };
/** How much of the other lines is left to see while some edges are pointed at. */
const DIMMED = 0.3;
const NO_EDGES: ReadonlySet<string> = new Set();
type Lines = { mesh: LineSegments2; a: Uint32Array; b: Uint32Array; buffer: Float32Array };
/** Points on screen (px), as in the 2D editor: half side of an anchor's square, radius of a curve control's disc, outline, picking radius. */
const POINT_PX = { anchor: 5.5, control: 4.5, rim: 1.5, pick: 13 };
/** How near the pointer an edge of the pattern must pass to be the one pointed at (pixels). */
const EDGE_PX = 9;
/**
 * The marks face the camera this far in front of where they sit (m), along the line of sight —
 * they do not move on screen: a fold or a seam's ridge in front of a point does not hide it,
 * an arm or another layer of the garment does.
 */
const MARK_LIFT = 0.03;
/** Cloth or skin nearer than a point by more than this hides it from the pointer too (m): as it is drawn. */
const OCCLUSION = MARK_LIFT;
/**
 * A point is dragged on the cloth's own plane where it sits — it stays under the pointer —
 * unless that plane is seen at less than this (|cos| of the angle to the line of sight): nearly
 * edge-on, a small move of the pointer would be a huge one on the cloth. It is then dragged on
 * the plane facing the camera, and follows the pointer only as far as the cloth's plane allows.
 */
const GRAZING = 0.35;

/** Marks a line object's positions as rewritten. */
const touch = (lines: LineSegments2) => ((lines.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true);

interface Point {
  key: string;
  /** Triangle the position is read from: the one under the point — under its anchor, for a curve control. */
  tri: number;
  /** Position on the pattern as currently drawn in 2D (cm), and its anchor's (curve controls). */
  pos: P2;
  anchor: P2 | null;
  /** Position on the garment (figure frame), and the cloth's tangent basis there: ∂x/∂u, ∂x/∂v. */
  at: THREE.Vector3;
  du: THREE.Vector3;
  dv: THREE.Vector3;
  root: THREE.Group;
  fill: THREE.Mesh;
  rim: THREE.Mesh;
  pick: THREE.Mesh;
}

/**
 * The pattern drawn on the garment while the 2D editor is open: every pattern edge in its
 * seam's colour, and the editor's points where they sit on the cloth, with the editor's marks (a
 * square for an anchor, a disc for a curve control). Dragging a point here
 * edits the same point of the pattern: the pointer's move, on the cloth's plane at that point
 * (GRAZING), is read in the cloth's own flat coordinates (its tangent basis there, from the
 * mesh's rest coordinates) — pulling a shoulder point 2 cm along the cloth moves it 2 cm on
 * the pattern. The points follow the pattern as it is being edited, from either side.
 *
 * Positions come from the simulation as last seen on this side (`update`).
 *
 * Nothing is drawn while a garment is first being sewn and falling into its drape (`hold`):
 * lines and points flying about with the flat pieces say nothing, and cannot be aimed at.
 */
export class PatternOverlay {
  readonly group = new THREE.Group();
  /** A point is being dragged: its move so far on the pattern (cm); `done` when released. */
  onEdit?: (key: string, move: P2, done: boolean) => void;
  /** The edge of the pattern under the pointer changed (`piece/edge`; null: none) — what the 2D editor shows in turn. */
  onEdge?: (key: string | null) => void;
  /** The point under the pointer or being dragged changed. */
  onFocus?: (key: string | null) => void;

  private garment: OverlayGarment | null = null;
  private colorOf: EdgeColor | null = null;
  private handles: Handle[] = [];
  private positions: Float32Array | null = null;
  private focus: string | null = null;
  /** The garment is still falling into its first drape: nothing is drawn. */
  private held = false;

  private seams: Lines | null = null;
  private plain: Lines | null = null;
  /** The edges pointed at in the 2D editor (a seam of its list): drawn again, wider, over the others dimmed. */
  private hot: Lines | null = null;
  private highlight: ReadonlySet<string> = NO_EDGES;
  /** Triangles at each vertex (CSR), for the normals the lines are lifted along. */
  private vertexTris: { start: Uint32Array; list: Uint32Array } | null = null;
  private points: Point[] = [];
  /** Marks, as in the 2D editor: a square for an anchor, a disc for a curve control (unit half size, facing +z). */
  private readonly shapes = { square: new THREE.PlaneGeometry(2, 2), disc: new THREE.CircleGeometry(1, 28), pick: new THREE.SphereGeometry(1, 12, 8) };
  private readonly materials = {
    fill: new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    rim: new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }),
    focus: new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false }),
    pick: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  };

  private drag: { point: Point; pointer: number; plane: THREE.Plane; start: THREE.Vector3; du: THREE.Vector3; dv: THREE.Vector3; last: P2 } | null = null;
  private hover: string | null = null;
  private edge: string | null = null;
  private moved: { clientX: number; clientY: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly down = (e: PointerEvent) => this.onDown(e);
  private readonly move = (e: PointerEvent) => this.onMove(e);
  private readonly up = (e: PointerEvent) => this.onUp(e);
  private readonly leave = () => {
    this.moved = null;
    this.setEdge(null);
  };

  /** `occluders`: what may hide a point from the pointer (the cloth, the body), in the figure's frame. */
  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly figure: THREE.Object3D,
    private readonly controls: OrbitControls,
    private readonly occluders: () => (PickMesh | null)[],
  ) {
    this.group.visible = false;
    figure.add(this.group);
    // Capture phase, registered before the cloth's own hold: a point wins over the cloth under it.
    dom.addEventListener("pointerdown", this.down, { capture: true });
    dom.addEventListener("pointermove", this.move);
    dom.addEventListener("pointerup", this.up);
    dom.addEventListener("pointercancel", this.up);
    dom.addEventListener("lostpointercapture", this.up);
    dom.addEventListener("pointerleave", this.leave);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Cursor over a point; null elsewhere. */
  get cursor(): string | null {
    return this.drag ? "grabbing" : this.hover ? "move" : null;
  }

  /** The garment on screen changed (null: none). */
  setGarment(garment: OverlayGarment | null, positions: Float32Array | null = null) {
    this.cancel();
    this.garment = garment;
    this.positions = positions;
    this.rebuild();
  }

  /** Shows the pattern on the garment with these edge colours, or hides it (null). */
  show(colorOf: EdgeColor | null) {
    this.colorOf = colorOf;
    this.group.visible = !!colorOf && !this.held;
    if (!colorOf) {
      this.cancel();
      this.setHover(null);
      this.setEdge(null);
    }
    this.rebuild();
  }

  /** Draws nothing while `on` (the garment's first drape), whatever `show` asks; then as asked. */
  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    this.group.visible = !!this.colorOf && !on;
    if (on) {
      this.cancel();
      this.setHover(null);
    } else if (this.group.visible) {
      this.place();
      this.drawLines();
    }
  }

  /** The pattern's points as currently drawn in the 2D editor (being edited or not). */
  setHandles(handles: Handle[]) {
    this.handles = handles;
    for (const p of this.points) {
      const h = handles.find((x) => x.key === p.key);
      if (!h) continue;
      p.pos = h.pos;
      p.anchor = h.anchor;
    }
    this.place();
  }

  /** Highlights a point (the one selected or hovered in the 2D editor). */
  setFocus(key: string | null) {
    this.focus = key;
    this.paint();
  }

  /** Highlights edges of the pattern on the garment, told as `piece/edge` (those of the seam pointed at in the 2D editor's list); none: an empty set. */
  setHighlight(edges: ReadonlySet<string>) {
    this.highlight = edges.size ? edges : NO_EDGES;
    this.rebuildHot();
    this.drawLines();
  }

  /** The cloth moved: its mid-surface positions (figure frame). */
  update(positions: Float32Array) {
    this.positions = positions;
    if (!this.group.visible) return;
    this.place();
    this.drawLines();
  }

  /** Once per rendered frame: marks facing the camera at a constant size on screen, hover. */
  frame() {
    if (!this.group.visible) return;
    const px = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, this.dom.clientHeight);
    const facing = this.group.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.camera.quaternion);
    const eye = this.figure.worldToLocal(this.camera.position.clone());
    const sight = new THREE.Vector3();
    for (const p of this.points) {
      const distance = sight.copy(eye).sub(p.at).length();
      const size = distance * px;
      const r = (p.anchor ? POINT_PX.control : POINT_PX.anchor) * size;
      p.root.position.copy(p.at).addScaledVector(sight, MARK_LIFT / (distance || 1));
      p.root.quaternion.copy(facing);
      p.fill.scale.setScalar(r);
      p.rim.scale.setScalar(r + POINT_PX.rim * size);
      p.pick.scale.setScalar(POINT_PX.pick * size);
    }
    if (this.moved && !this.drag) {
      const point = this.pick(this.moved);
      this.setHover(point?.key ?? null);
      // An edge is pointed at where no point is (a point is on an edge).
      this.setEdge(point ? null : this.pickEdge(this.moved));
      this.moved = null;
    }
  }

  // --- Building ---------------------------------------------------------------

  private clear() {
    for (const l of [this.seams, this.plain, this.hot]) this.drop(l);
    for (const p of this.points) this.group.remove(p.root);
    this.seams = this.plain = this.hot = null;
    this.points = [];
    this.vertexTris = null;
  }

  private drop(lines: Lines | null) {
    if (!lines) return;
    this.group.remove(lines.mesh);
    lines.mesh.geometry.dispose();
    lines.mesh.material.dispose();
  }

  /** Lines along edges of the garment, each in its colour, `width` pixels wide (their positions are written by drawLines). */
  private lines(width: number, edges: { vertices: Uint32Array; color: string }[], extra: number): Lines {
    const count = edges.reduce((s, e) => s + Math.max(0, e.vertices.length - 1), 0);
    const a = new Uint32Array(count), b = new Uint32Array(count);
    // Each segment twice (lifted off either face of the fabric), then `extra` free segments.
    const buffer = new Float32Array(6 * (2 * count + extra)), colors = new Float32Array(buffer.length);
    const c = new THREE.Color();
    let k = 0;
    for (const e of edges) {
      c.set(e.color);
      for (let i = 1; i < e.vertices.length; i++, k++) {
        a[k] = e.vertices[i - 1];
        b[k] = e.vertices[i];
        for (const o of [k, count + k]) for (let end = 0; end < 2; end++) colors.set([c.r, c.g, c.b], 6 * o + 3 * end);
      }
    }
    c.set(INK);
    for (let o = 2 * count; o < 2 * count + extra; o++) for (let end = 0; end < 2; end++) colors.set([c.r, c.g, c.b], 6 * o + 3 * end);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(buffer);
    geometry.setColors(colors);
    const material = new THREE.Line2NodeMaterial({ vertexColors: true, linewidth: width });
    material.toneMapped = false;
    const mesh = new LineSegments2(geometry, material);
    mesh.frustumCulled = false; // positions are rewritten with the simulation
    this.group.add(mesh);
    return { mesh, a, b, buffer };
  }

  /** The highlighted edges drawn over the others, which are dimmed meanwhile. */
  private rebuildHot() {
    this.drop(this.hot);
    this.hot = null;
    const g = this.garment, colorOf = this.colorOf;
    const edges = g && colorOf && this.highlight.size ? g.outline.filter((e) => this.highlight.has(`${e.piece}/${e.edge}`)) : [];
    if (edges.length) {
      this.hot = this.lines(WIDTH.hot, edges.map((e) => ({ vertices: e.vertices, color: colorOf!(e.piece, e.edge) ?? ACCENT })), 0);
      this.hot.mesh.renderOrder = 1;
    }
    for (const l of [this.seams, this.plain]) {
      if (!l) continue;
      l.mesh.material.transparent = !!this.hot;
      l.mesh.material.opacity = this.hot ? DIMMED : 1;
    }
  }

  private rebuild() {
    this.clear();
    const g = this.garment, colorOf = this.colorOf;
    if (!g || !colorOf) return;

    // Triangles at each vertex.
    const T = g.triangles, n = g.rest.length / 2;
    const start = new Uint32Array(n + 1);
    for (const v of T) start[v + 1]++;
    for (let v = 0; v < n; v++) start[v + 1] += start[v];
    const cursor = start.slice(0, n), list = new Uint32Array(T.length);
    for (let i = 0; i < T.length; i++) list[cursor[T[i]]++] = (i / 3) | 0;
    this.vertexTris = { start, list };

    // Lines: the sewn edges in their seam's colour, the others (hems, openings) in ink.
    const sewn: { vertices: Uint32Array; color: string }[] = [], open: { vertices: Uint32Array; color: string }[] = [];
    for (const e of g.outline) {
      const color = colorOf(e.piece, e.edge);
      if (color) sewn.push({ vertices: e.vertices, color });
      else open.push({ vertices: e.vertices, color: INK });
    }
    const dressed = g.pattern.handles;
    this.seams = this.lines(WIDTH.seam, sewn, 0);
    this.plain = this.lines(WIDTH.plain, open, dressed.filter((h) => h.anchor).length); // + the curve controls' tethers
    this.rebuildHot();

    // Points: placed by the pattern the garment was cut from, then moved with the pattern being edited.
    for (const h of dressed) {
      const piece = g.pieceIds.indexOf(h.piece);
      const tri = piece < 0 ? -1 : this.locate(piece, h.anchor ?? h.pos);
      if (tri < 0) continue;
      const root = new THREE.Group();
      const shape = h.anchor ? this.shapes.disc : this.shapes.square;
      const fill = new THREE.Mesh(shape, this.materials.fill);
      const rim = new THREE.Mesh(shape, this.materials.rim);
      rim.position.z = -0.0005; // the outline: the same shape, larger, just behind
      const pick = new THREE.Mesh(this.shapes.pick, this.materials.pick);
      root.add(rim, fill, pick);
      this.group.add(root);
      const now = this.handles.find((x) => x.key === h.key) ?? h;
      this.points.push({ key: h.key, tri, pos: now.pos, anchor: now.anchor, at: new THREE.Vector3(), du: new THREE.Vector3(), dv: new THREE.Vector3(), root, fill, rim, pick });
    }
    this.paint();
    this.place();
    this.drawLines();
  }

  /** Triangle of a piece under a pattern position (cm), or the nearest one. */
  private locate(piece: number, [x, y]: P2): number {
    const g = this.garment!, T = g.triangles, R = g.rest;
    const px = x / 100, py = y / 100;
    let best = -1, bestD = Infinity;
    for (let t = 0; t < T.length; t += 3) {
      if (g.piece[T[t]] !== piece) continue;
      const a = 2 * T[t], b = 2 * T[t + 1], c = 2 * T[t + 2];
      const e1x = R[b] - R[a], e1y = R[b + 1] - R[a + 1], e2x = R[c] - R[a], e2y = R[c + 1] - R[a + 1];
      const det = e1x * e2y - e1y * e2x;
      if (Math.abs(det) < 1e-12) continue;
      const qx = px - R[a], qy = py - R[a + 1];
      const u = (qx * e2y - qy * e2x) / det, v = (e1x * qy - e1y * qx) / det;
      // Distance to the triangle, in barycentric terms: 0 inside.
      const out = Math.max(0, -u, -v, u + v - 1);
      if (out === 0) return t / 3;
      const d = out * Math.sqrt(Math.abs(det));
      if (d < bestD) [bestD, best] = [d, t / 3];
    }
    return best;
  }

  // --- Following the simulation and the pattern ---------------------------------

  /** Places the points: the triangle's flat-to-draped map, read at the point's pattern position. */
  private place() {
    const g = this.garment, P = this.positions;
    if (!g || !P || !this.group.visible) return;
    const T = g.triangles, R = g.rest;
    const x0 = new THREE.Vector3(), X1 = new THREE.Vector3(), X2 = new THREE.Vector3();
    for (const p of this.points) {
      const i0 = T[3 * p.tri], i1 = T[3 * p.tri + 1], i2 = T[3 * p.tri + 2];
      x0.fromArray(P, 3 * i0);
      X1.fromArray(P, 3 * i1).sub(x0);
      X2.fromArray(P, 3 * i2).sub(x0);
      const e1x = R[2 * i1] - R[2 * i0], e1y = R[2 * i1 + 1] - R[2 * i0 + 1], e2x = R[2 * i2] - R[2 * i0], e2y = R[2 * i2 + 1] - R[2 * i0 + 1];
      const det = e1x * e2y - e1y * e2x;
      p.du.copy(X1).multiplyScalar(e2y / det).addScaledVector(X2, -e1y / det);
      p.dv.copy(X1).multiplyScalar(-e2x / det).addScaledVector(X2, e1x / det);
      p.at.copy(x0).addScaledVector(p.du, p.pos[0] / 100 - R[2 * i0]).addScaledVector(p.dv, p.pos[1] / 100 - R[2 * i0 + 1]);
    }
    // Tethers of the curve controls, after the open edges.
    const l = this.plain;
    if (!l) return;
    let o = 6 * 2 * l.a.length;
    const anchor = new THREE.Vector3();
    for (const p of this.points) {
      if (!p.anchor) continue;
      anchor.copy(p.at).addScaledVector(p.du, (p.anchor[0] - p.pos[0]) / 100).addScaledVector(p.dv, (p.anchor[1] - p.pos[1]) / 100);
      anchor.toArray(l.buffer, o);
      p.at.toArray(l.buffer, o + 3);
      o += 6;
    }
    touch(l.mesh);
  }

  private drawLines() {
    const g = this.garment, P = this.positions, adj = this.vertexTris;
    if (!g || !P || !adj || !this.group.visible) return;
    const T = g.triangles, lift = g.thickness / 2 + LIFT;
    const normal = [0, 0, 0];
    const normalAt = (v: number) => {
      let nx = 0, ny = 0, nz = 0;
      for (let k = adj.start[v]; k < adj.start[v + 1]; k++) {
        const t = 3 * adj.list[k], a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      normal[0] = (nx / len) * lift; normal[1] = (ny / len) * lift; normal[2] = (nz / len) * lift;
    };
    for (const l of [this.seams, this.plain, this.hot]) {
      if (!l) continue;
      const count = l.a.length, out = l.buffer;
      for (let k = 0; k < count; k++)
        for (let end = 0; end < 2; end++) {
          const v = end ? l.b[k] : l.a[k];
          normalAt(v);
          for (let axis = 0; axis < 3; axis++) {
            out[6 * k + 3 * end + axis] = P[3 * v + axis] + normal[axis];
            out[6 * (count + k) + 3 * end + axis] = P[3 * v + axis] - normal[axis];
          }
        }
      touch(l.mesh);
    }
  }

  /** The point under the pointer, dragged, or pointed at in the 2D editor: outline and inside in the accent colour. */
  private paint() {
    for (const p of this.points) {
      const hot = p.key === this.focus || p.key === this.hover || p === this.drag?.point;
      p.rim.material = hot ? this.materials.focus : this.materials.rim;
      p.fill.material = hot ? this.materials.focus : this.materials.fill;
    }
  }

  // --- Pointer ------------------------------------------------------------------

  /** The pointer's ray, in the world. */
  private ray(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /**
   * The point under the pointer, unless cloth or skin hides it. Of several (a curve control
   * next to its anchor), the one whose centre is nearest to the pointer.
   */
  private pick(e: { clientX: number; clientY: number }): Point | null {
    if (!this.group.visible || !this.points.length) return null;
    const ray = this.ray(e);
    this.group.updateMatrixWorld(true); // points just built or resized have not been rendered yet
    const hits = this.raycaster.intersectObjects(this.points.map((p) => p.pick), false);
    if (!hits.length) return null;
    const local = ray.clone().applyMatrix4(this.figure.matrixWorld.clone().invert());
    const under = hits.map((hit) => this.points.find((p) => p.pick === hit.object)!).sort((a, b) => local.distanceSqToPoint(a.at) - local.distanceSqToPoint(b.at));
    // What lies in front along the pointer's ray (the points under it are within a few cm of it).
    const nearest = this.occluders().map((m) => (m && raycast(m, local.origin, local.direction)?.distance) ?? Infinity);
    return under.find((p) => nearest.every((d) => d >= p.at.distanceTo(local.origin) - OCCLUSION)) ?? null;
  }

  /**
   * The edge of the pattern the pointer is on, on the garment: the one that passes nearest to
   * the pointer's ray on screen, within EDGE_PX — unless cloth or skin lies in front of it
   * (the back's seams are not pointed at through the front).
   */
  private pickEdge(e: { clientX: number; clientY: number }): string | null {
    const g = this.garment, P = this.positions;
    if (!this.group.visible || !g || !P) return null;
    const local = this.ray(e).clone().applyMatrix4(this.figure.matrixWorld.clone().invert());
    const px = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, this.dom.clientHeight);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), on = new THREE.Vector3();
    let best: { key: string; pixels: number; distance: number } | null = null;
    for (const edge of g.outline) {
      const V = edge.vertices;
      for (let i = 1; i < V.length; i++) {
        a.fromArray(P, 3 * V[i - 1]);
        b.fromArray(P, 3 * V[i]);
        const apart = Math.sqrt(local.distanceSqToSegment(a, b, undefined, on));
        const distance = on.distanceTo(local.origin);
        const pixels = apart / (distance * px || 1);
        if (pixels <= EDGE_PX && (!best || pixels < best.pixels)) best = { key: `${edge.piece}/${edge.edge}`, pixels, distance };
      }
    }
    if (!best) return null;
    const nearest = this.occluders().map((m) => (m && raycast(m, local.origin, local.direction)?.distance) ?? Infinity);
    return nearest.every((d) => d >= best.distance - OCCLUSION) ? best.key : null;
  }

  private setEdge(key: string | null) {
    if (key === this.edge) return;
    this.edge = key;
    this.onEdge?.(key);
  }

  private onDown(e: PointerEvent) {
    if (this.drag || e.button !== 0 || !e.isPrimary) return;
    const point = this.pick(e);
    if (!point) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const world = this.figure.localToWorld(point.at.clone());
    const cloth = point.du.clone().cross(point.dv).transformDirection(this.figure.matrixWorld);
    const facing = Math.abs(cloth.dot(this.ray(e).direction)) >= GRAZING;
    this.drag = {
      point,
      pointer: e.pointerId,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing ? cloth : this.camera.getWorldDirection(new THREE.Vector3()), world),
      start: point.at.clone(),
      du: point.du.clone(),
      dv: point.dv.clone(),
      last: [0, 0],
    };
    this.moved = null;
    this.controls.enabled = false;
    this.dom.setPointerCapture(e.pointerId);
    this.paint();
    this.onFocus?.(point.key);
  }

  /** The pointer's move since the point was taken, on the pattern (cm): least squares on the tangent basis. */
  private patternMove(e: PointerEvent): P2 | null {
    const d = this.drag!;
    const hit = this.ray(e).intersectPlane(d.plane, new THREE.Vector3());
    if (!hit) return null;
    const m = this.figure.worldToLocal(hit).sub(d.start);
    const aa = d.du.dot(d.du), ab = d.du.dot(d.dv), bb = d.dv.dot(d.dv), am = d.du.dot(m), bm = d.dv.dot(m);
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) return null;
    return [(100 * (bb * am - ab * bm)) / det, (100 * (aa * bm - ab * am)) / det];
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      this.moved = e.buttons === 0 ? { clientX: e.clientX, clientY: e.clientY } : null;
      return;
    }
    if (e.pointerId !== d.pointer) return;
    const move = this.patternMove(e);
    if (!move) return;
    d.last = move;
    this.onEdit?.(d.point.key, move, false);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    // Cancelled (the pointer was taken away): nothing is edited.
    const move: P2 = e.type === "pointerup" ? (this.patternMove(e) ?? d.last) : [0, 0];
    this.release();
    this.onEdit?.(d.point.key, move, true);
    this.moved = { clientX: e.clientX, clientY: e.clientY };
  }

  private release() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.controls.enabled = true;
    if (this.dom.hasPointerCapture(d.pointer)) this.dom.releasePointerCapture(d.pointer);
    this.paint();
    this.onFocus?.(this.hover);
  }

  /** Drops a drag under way without editing (the garment is replaced, the overlay hidden). */
  private cancel() {
    const d = this.drag;
    if (!d) return;
    this.release();
    this.onEdit?.(d.point.key, [0, 0], true);
  }

  private setHover(key: string | null) {
    if (key === this.hover) return;
    this.hover = key;
    this.paint();
    if (!this.drag) this.onFocus?.(key);
  }

  dispose() {
    this.dom.removeEventListener("pointerleave", this.leave);
    this.cancel();
    this.clear();
    for (const g of Object.values(this.shapes)) g.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.dom.removeEventListener("pointerdown", this.down, { capture: true });
    this.dom.removeEventListener("pointermove", this.move);
    this.dom.removeEventListener("pointerup", this.up);
    this.dom.removeEventListener("pointercancel", this.up);
    this.dom.removeEventListener("lostpointercapture", this.up);
    this.figure.remove(this.group);
  }
}
