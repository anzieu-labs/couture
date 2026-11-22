import type { BodyShape } from "../avatar/anny";
import type { TorsoFrame } from "../avatar/bodyMeasures";
import type { GarmentMesh } from "../pattern/mesh";
import type { GarmentKind } from "../pattern/types";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quarter perimeter of an ellipse (Ramanujan). */
const quarterPerimeter = (a: number, b: number) => (Math.PI / 4) * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

/** Minimum clearance between the body and the panels before sewing (m). */
const MIN_CLEARANCE = 0.015;

/**
 * Elliptic cylinder around the torso whose quarter perimeter equals the
 * panels' half width, so wrapping them does not stretch the fabric; and the
 * angle reached at each arc length (to wrap without distortion).
 */
function torsoWrap(torso: TorsoFrame, halfWidth: number) {
  let lo = MIN_CLEARANCE, hi = 0.3;
  for (let i = 0; i < 40; i++) {
    const d = (lo + hi) / 2;
    if (quarterPerimeter(torso.halfWidth + d, torso.halfDepth + d) < halfWidth) lo = d;
    else hi = d;
  }
  const rx = torso.halfWidth + lo, rz = torso.halfDepth + lo;
  // Arc length → angle table on [0, π/2] (angle measured from the centre front).
  const N = 256;
  const arc = new Float64Array(N + 1);
  for (let k = 1; k <= N; k++) {
    const t0 = ((k - 1) / N) * (Math.PI / 2), t1 = (k / N) * (Math.PI / 2);
    arc[k] = arc[k - 1] + Math.hypot(rx * (Math.sin(t1) - Math.sin(t0)), rz * (Math.cos(t1) - Math.cos(t0)));
  }
  const angleAt = (s: number) => {
    const target = Math.min(Math.abs(s), arc[N]);
    let k = 1;
    while (k < N && arc[k] < target) k++;
    const t = (target - arc[k - 1]) / (arc[k] - arc[k - 1] || 1);
    return Math.sign(s) * ((k - 1 + t) / N) * (Math.PI / 2);
  };
  return { rx, rz, angleAt };
}

/**
 * Axis of the arm (shoulder → elbow → wrist) as a function of the distance s
 * from the shoulder joint, with a cross-section frame (up: outer side of the
 * arm, fwd: front) that turns smoothly around the elbow. Long sleeves follow
 * the forearm instead of continuing straight past the elbow.
 */
function armPath(shape: BodyShape, side: "L" | "R") {
  const j = shape.joints;
  const J = j[`upperarm01.${side}`], E = j[`lowerarm01.${side}`], W = j[`wrist.${side}`];
  const dA = norm(sub(E, J)), dB = norm(sub(W, E));
  const lenA = Math.hypot(...sub(E, J));
  const BEND = 0.05; // half-length of the elbow transition (m)
  const frameOf = (d: V3) => {
    const up = norm(sub([0, 1, 0], [d[0] * d[1], d[1] * d[1], d[2] * d[1]]));
    return { up, fwd: cross(d, up) };
  };
  // Same handedness all along the sleeve, chosen so that fwd faces the front.
  const flip = frameOf(dA).fwd[2] < 0 ? -1 : 1;
  return (s: number) => {
    const center: V3 = s <= lenA
      ? [J[0] + dA[0] * s, J[1] + dA[1] * s, J[2] + dA[2] * s]
      : [E[0] + dB[0] * (s - lenA), E[1] + dB[1] * (s - lenA), E[2] + dB[2] * (s - lenA)];
    const t = Math.min(1, Math.max(0, (s - lenA + BEND) / (2 * BEND)));
    const k = t * t * (3 - 2 * t);
    const d = norm([dA[0] + (dB[0] - dA[0]) * k, dA[1] + (dB[1] - dA[1]) * k, dA[2] + (dB[2] - dA[2]) * k]);
    const { up, fwd } = frameOf(d);
    return { center, up, fwd: [fwd[0] * flip, fwd[1] * flip, fwd[2] * flip] as V3 };
  };
}

/**
 * Initial 3D placement before sewing (like the "arrangement points" of a 3D
 * garment CAD), per garment kind. Lengths are preserved, so the fabric starts
 * unstretched.
 */
export function placeGarment(mesh: GarmentMesh, shape: BodyShape, torso: TorsoFrame, kind: GarmentKind): Float32Array {
  if (kind === "cape") return placeCape(mesh, shape, torso);
  if (kind === "skirt") return placeSkirt(mesh, torso);
  return placeTShirt(mesh, shape, torso);
}

/**
 * T-shirt, and any top made of pieces worn on the trunk or on an arm (mesh.zones): the pieces
 * of the front and of the back wrapped on an elliptic cylinder around the torso, those of an
 * arm on a tube following it (a sleeve's underarm seam at the bottom) — each where its own
 * coordinates put it. Unstretched unless the garment is narrower than the body (e.g. a tight
 * sleeve).
 */
function placeTShirt(mesh: GarmentMesh, shape: BodyShape, torso: TorsoFrame): Float32Array {
  const n = mesh.rest.length / 2;
  const out = new Float32Array(n * 3);
  const r = mesh.rest;

  // Per-piece half width of the flat pattern.
  const halfWidth = new Map<number, number>();
  for (let i = 0; i < n; i++) halfWidth.set(mesh.piece[i], Math.max(halfWidth.get(mesh.piece[i]) ?? 0, Math.abs(r[2 * i])));
  const panelHalfWidth = Math.max(
    ...[...halfWidth].filter(([p]) => mesh.zones[p] === "front" || mesh.zones[p] === "back").map(([, w]) => w),
    0.05,
  );
  const wrap = torsoWrap(torso, panelHalfWidth);
  const top = torso.hpsY + 0.02;

  const arms = { armL: armPath(shape, "L"), armR: armPath(shape, "R") };

  for (let i = 0; i < n; i++) {
    const zone = mesh.zones[mesh.piece[i]];
    const x = r[2 * i], y = r[2 * i + 1];
    const o = 3 * i;
    if (zone === "front" || zone === "back") {
      const theta = wrap.angleAt(x);
      out[o] = wrap.rx * Math.sin(theta);
      out[o + 1] = top + y;
      out[o + 2] = torso.centerZ + (zone === "front" ? 1 : -1) * wrap.rz * Math.cos(theta);
    } else {
      const hw = halfWidth.get(mesh.piece[i])!;
      // Circumference = sleeve width, unless the arm is wider (tight sleeve).
      const radius = Math.max(hw / Math.PI, torso.upperArmRadius + 0.008);
      const phi = x / radius;
      const { center, up, fwd } = arms[zone](-0.03 - y);
      const c = Math.cos(phi) * radius, sn = Math.sin(phi) * radius;
      for (let a = 0; a < 3; a++) out[o + a] = center[a] + up[a] * c + fwd[a] * sn;
    }
  }
  return out;
}

/**
 * Second step of the placement, once the body's distance field is there to tell its inside
 * from its outside (prepare.ts builds it around the garment as placeGarment leaves it).
 *
 * A cape is laid flat above everything it could cut through, which puts it level with the
 * chin: left there, its neckline came down onto the jaw and stayed hooked on the chin, the
 * hood pulled over the face — a neckline is shorter than the way round chin and nape. It is
 * worn round the neck, under the chin: the disc is brought down to the height, from just above
 * the shoulder line, where the fewest of its points start inside the body (the lowest of them;
 * a few always do, by a few millimetres: the throat is not as round as the neckline), and the
 * hood comes down with it.
 */
export function seatGarment(mesh: GarmentMesh, placed: Float32Array, torso: TorsoFrame, kind: GarmentKind, body: { sample(x: number, y: number, z: number): number }) {
  if (kind !== "cape") return;
  const n = placed.length / 3;
  const disc: number[] = [];
  for (let i = 0; i < n; i++) if (!mesh.pieceIds[mesh.piece[i]].startsWith("hood")) disc.push(3 * i);
  const laid = placed[disc[0] + 1];
  let seat = laid, fewest = Infinity;
  for (let y = torso.hpsY + CAPE_SEAT.lowest; y < laid; y += CAPE_SEAT.step) {
    let inside = 0;
    for (const o of disc) if (body.sample(placed[o], y, placed[o + 2]) < 0) inside++;
    if (inside < fewest) [fewest, seat] = [inside, y];
  }
  for (let o = 1; o < placed.length; o += 3) placed[o] += seat - laid;
}

/** Heights tried for the disc of a cape (seatGarment): from `lowest` above the HPS up to where it is laid, every `step` (m). */
const CAPE_SEAT = { lowest: 0.005, step: 0.005 };

/**
 * Cape (lib/pattern/cape.ts): the full circle is flat, so it is laid horizontally
 * around the neck, above the highest point of the body under it bar the head (seatGarment
 * then brings it down round the neck), with no distortion: the circle's centre (pattern
 * origin) on the neck axis, the back towards −z, the fronts towards +z. Gravity drapes it
 * once sewn. The hood halves stand in vertical planes on either side of the head, face edge
 * at the front: sewing closes the back seam over the head and joins the neck edge to the cape.
 */
function placeCape(mesh: GarmentMesh, shape: BodyShape, torso: TorsoFrame): Float32Array {
  const n = mesh.rest.length / 2;
  const out = new Float32Array(n * 3);
  const r = mesh.rest;
  const backIdx = mesh.pieceIds.indexOf("back");

  // Neckline radius = closest back-panel vertex to the circle's centre.
  let r1 = Infinity;
  for (let i = 0; i < n; i++) if (mesh.piece[i] === backIdx) r1 = Math.min(r1, Math.hypot(r[2 * i], r[2 * i + 1]));

  // Height: above every body point under the disc near the neck (shoulders, trapezius),
  // the head excluded (chin and skull are higher up but inside or above the hood).
  const z0 = torso.neckCenterZ;
  let top = torso.hpsY;
  const p = shape.positions;
  for (let v = 0; v < p.length; v += 3) {
    const d = Math.hypot(p[v], p[v + 2] - z0);
    if (d > r1 - 0.01 && d < 0.45 && p[v + 1] < torso.hpsY + 0.05) top = Math.max(top, p[v + 1]);
  }
  const capeY = top + 0.015;

  const hx = torso.headHalfWidth + 0.025;
  const hoodY = capeY + 0.02;
  const faceZ = torso.headFrontZ + 0.01;

  for (let i = 0; i < n; i++) {
    const id = mesh.pieceIds[mesh.piece[i]];
    const x = r[2 * i], y = r[2 * i + 1];
    const o = 3 * i;
    if (id === "back") {
      out[o] = x; out[o + 1] = capeY; out[o + 2] = z0 + y;
    } else if (id === "front+" || id === "front-") {
      out[o] = x; out[o + 1] = capeY; out[o + 2] = z0 - y;
    } else {
      // hood+: u = x ≥ 0 (towards the back); hood-: its mirror image, u = −x.
      const left = id === "hood+";
      out[o] = left ? hx : -hx;
      out[o + 1] = hoodY + y;
      out[o + 2] = faceZ - Math.abs(x);
    }
  }
  return out;
}

/**
 * Skirt (lib/pattern/skirt.ts): each horizontal row of the panels (pattern y =
 * height below the waist) is wrapped on an ellipse around the body section at that
 * height (legs together below the crotch), its quarter perimeter equal to the
 * row's half width — the waist hugs the waist, the flare stands off the legs. The
 * slope of an A-line is small: rows to ellipses stretches the fabric by ~2 %.
 */
function placeSkirt(mesh: GarmentMesh, torso: TorsoFrame): Float32Array {
  const n = mesh.rest.length / 2;
  const out = new Float32Array(n * 3);
  const r = mesh.rest;
  const sections = torso.lowerSections;
  const sectionAt = (y: number) => {
    const k = Math.min(sections.length - 1, Math.max(0, Math.round((torso.waistY - y) / 0.02)));
    return sections[k];
  };

  // Half width of each 1 cm row of each panel.
  const ROW = 0.01;
  const rowKey = (p: number, y: number) => p * 100000 + Math.round(-y / ROW);
  const half = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = rowKey(mesh.piece[i], r[2 * i + 1]);
    half.set(k, Math.max(half.get(k) ?? 0, Math.abs(r[2 * i])));
  }
  // Wrap per row (both panels share the side seam: use the wider of the two, so it closes).
  const wraps = new Map<number, ReturnType<typeof torsoWrap> & { cz: number }>();
  const wrapFor = (y: number) => {
    const key = Math.round(-y / ROW);
    let w = wraps.get(key);
    if (!w) {
      const s = sectionAt(torso.waistY + y);
      let hw = 0;
      for (let p = 0; p < mesh.pieceIds.length; p++) hw = Math.max(hw, half.get(p * 100000 + key) ?? 0);
      const frame = { ...torso, halfWidth: s.halfWidth, halfDepth: (s.zMax - s.zMin) / 2 };
      w = { ...torsoWrap(frame, Math.max(hw, 0.01)), cz: (s.zMax + s.zMin) / 2 };
      wraps.set(key, w);
    }
    return w;
  };

  for (let i = 0; i < n; i++) {
    const id = mesh.pieceIds[mesh.piece[i]];
    const x = r[2 * i], y = r[2 * i + 1];
    const w = wrapFor(y);
    const theta = w.angleAt(x);
    const o = 3 * i;
    out[o] = w.rx * Math.sin(theta);
    out[o + 1] = torso.waistY + y;
    out[o + 2] = w.cz + (id === "front" ? 1 : -1) * w.rz * Math.cos(theta);
  }
  return out;
}
