import { BONE_STRIDE } from "../avatar/skeleton";
import type { BodySdf } from "./bodySdf";

/**
 * Collisions with the animated (skinned) mannequin, in rest space.
 *
 * "Rest" here is the pose the collision field was built in, and the bone transforms are
 * counted from: the body as it stands (avatar/motion.ts standingBody), not the morphology's own
 * A-pose. Standing still, the transforms are the identity and none of what follows runs: the
 * cloth collides with the very body that is shown. What follows is an approximation whose
 * error grows with how far the bones have moved from the reference pose (the skin weights
 * are those of the closest body vertex, interpolated on the grid: a little off for a point
 * above the skin) — which is why the reference is the pose the mannequin spends its time in.
 *
 * The body is posed by linear blend skinning: x ↦ M(x)·x with M(x) = Σ wₖ(x) Bₖ.
 * Rebuilding the distance field every frame would be costly; instead each cloth
 * vertex p is brought back to the rest pose, q = M⁻¹·p, tested against the
 * rest-pose field, pushed out there and posed again, p' = M·q'.
 *
 * M is blended from the skin influences stored on the field's grid (those of
 * the closest body vertex), trilinearly interpolated: first at the vertex's
 * rest position from the previous substep (M₀, q₀ = M₀⁻¹·p), then at q₀
 * (M₁, q = M₁⁻¹·p) — a fixed-point iteration. Friction is applied to the
 * rest-space motion, i.e. relative to the skin that carries the cloth.
 *
 * Consistency: where body parts overlap differently in the rest and the posed
 * body, the preimage is ambiguous. E.g. arms raised: the space the arm leaves
 * under the shoulder maps into the torso with the arm's weights, and into the
 * rest-pose arm with the torso's; the rest field would report a collision
 * either way and fling the cloth along the arm. There M₁·q₀ ≠ p: when they
 * differ by more than POSE_TOLERANCE, the vertex is in free space and gets no
 * contact.
 *
 * Limbs: the iteration above follows a cloth vertex continuously from where it was, so it
 * only ever finds the body part the vertex already lies against. Cloth hanging in front of
 * the torso maps back to a rest-space point in front of the torso — where the rest pose has
 * nothing — even while a forearm, raised and swung by a run, goes right through it. A vertex
 * with no contact is therefore also brought back by the rigid transform of each far-swinging
 * limb (SdfGrid.limbs: forearms, hands, lower legs, feet): q = Bₖ⁻¹·p, kept if it falls in
 * the limb's bounding capsule, under the skin offset, and in skin that the limb's bone does
 * drive (blend at q ≈ Bₖ, same tolerance). The deepest such contact pushes the vertex out;
 * no friction there (the reference position belongs to the other preimage).
 *
 * Impacts (on the limbs above only — rest-space points inside a limb's capsule —, where the
 * cloth meets fast-moving skin): contacts are
 * tested at the vertices only, and a vertex is pushed out along the
 * field's gradient — away from the limb's axis. A forearm arriving fast thus pushes the
 * vertices on either side of it apart, like a wedge, faster than the stretch constraints
 * pull them back: the triangle opens to two or three times its size and ends up threaded on
 * the arm, every vertex duly at the skin offset. Real cloth is carried by what hits it. So a
 * vertex entering the body faster than IMPACT_SPEED (relative to the skin) is put back where
 * its path from its previous rest-space position crossed the offset surface — it sticks where
 * it was hit, and moves with the limb — instead of sliding round it. Below, Coulomb friction
 * as usual. And the offset itself grows with that relative speed (IMPACT_MARGIN: the distance
 * covered in a few milliseconds), so that the cloth starts moving before a fast hand reaches it —
 * a fingertip is a finer wedge than the mesh — with no gap left once it moves with the skin.
 * Measured on a cape, running: forearms through the cloth 85–91 % of the time with neither,
 * hands still through with either alone (or with half the sticking), nothing through with
 * both. The price: a limb that carries the cloth throws it about — a cape with no clasp
 * comes off a runner's shoulders, and folds over itself more than self-collisions untangle.
 *
 * Same formulas as the contact kernels of the GPU solver (lib/sim/gpu/shaders.ts).
 */

/** Largest |M₁·q₀ − p| (m) for which the rest-space preimage is trusted. */
export const POSE_TOLERANCE = 0.005;
/**
 * Speed of the cloth relative to the skin (m/s) from which a vertex entering the body sticks
 * where it entered, and above which it sticks fully.
 */
export const IMPACT_SPEED = { from: 1.5, to: 3 };
/**
 * Contact margin added to the skin offset for cloth moving relative to the skin: the distance
 * covered in `time` seconds (whatever the substep), up to `max` (m). It stops the cloth that
 * comes in from outside it. Cloth already inside it is pushed back out to it by skin that
 * itself moves fast (IMPACT_SPEED: a runner's forearm, which the cloth must be kept ahead of),
 * and only kept from coming nearer by slow skin: pushed out whatever the skin's speed, a sleeve
 * falling back on a walker's arm was thrown 1 to 2.5 cm off it in one substep, fell back faster
 * still, and so on — on the GPU the hem of a t-shirt's sleeve jumped 1 to 3 cm from one frame
 * to the next, as in a gale (4 mm per frame² rms; 0.9 now, the rest of the t-shirt's). Never
 * pushed out, a runner's forearms were through a cape half of the time.
 */
export const IMPACT_MARGIN = { time: 0.005, max: 0.025 };

// Per-bone weight accumulators (the 8 × 4 grid influences involve a few distinct bones).
const boneWeight = new Float64Array(256);
const touched = new Uint8Array(32);

/** Blended bone transform (3×4, row-major) at rest-space point (x, y, z), written into `out`. */
export function blendAt(sdf: BodySdf, bones: Float32Array, x: number, y: number, z: number, out: Float64Array) {
  const { nx, ny, nz, h, min } = sdf;
  const skin = sdf.skin!;
  const fx = Math.min(Math.max((x - min[0]) / h, 0), nx - 1.001);
  const fy = Math.min(Math.max((y - min[1]) / h, 0), ny - 1.001);
  const fz = Math.min(Math.max((z - min[2]) / h, 0), nz - 1.001);
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const tx = fx - i, ty = fy - j, tz = fz - k;
  let count = 0;
  for (let corner = 0; corner < 8; corner++) {
    const ox = corner & 1, oy = (corner >> 1) & 1, oz = corner >> 2;
    const cw = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty) * (oz ? tz : 1 - tz);
    if (cw === 0) continue;
    const c = i + ox + nx * (j + oy + ny * (k + oz));
    const ids = skin[2 * c], ws = skin[2 * c + 1];
    for (let n = 0; n < 4; n++) {
      const w = (cw * ((ws >>> (8 * n)) & 0xff)) / 255;
      if (w === 0) continue;
      const b = (ids >>> (8 * n)) & 0xff;
      if (boneWeight[b] === 0) touched[count++] = b;
      boneWeight[b] += w;
    }
  }
  out.fill(0);
  for (let t = 0; t < count; t++) {
    const b = touched[t], w = boneWeight[b], o = b * BONE_STRIDE;
    boneWeight[b] = 0;
    for (let e = 0; e < BONE_STRIDE; e++) out[e] += w * bones[o + e];
  }
}

/** out = M·(x, y, z). */
export function applyAffine(m: Float64Array, x: number, y: number, z: number, out: Float64Array | Float32Array, o = 0) {
  out[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

/** out = M⁻¹·(x, y, z) (inverse of the linear part by cofactors). */
export function applyInverse(m: Float64Array, x: number, y: number, z: number, out: Float64Array) {
  const px = x - m[3], py = y - m[7], pz = z - m[11];
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], hh = m[9], i = m[10];
  // Columns of the inverse: r1×r2, r2×r0, r0×r1 (rows r0, r1, r2), over the determinant.
  const c0x = e * i - f * hh, c0y = f * g - d * i, c0z = d * hh - e * g;
  const c1x = hh * c - i * b, c1y = i * a - g * c, c1z = g * b - hh * a;
  const c2x = b * f - c * e, c2y = c * d - a * f, c2z = a * e - b * d;
  const det = a * c0x + b * c0y + c * c0z;
  const s = det !== 0 ? 1 / det : 0;
  out[0] = (c0x * px + c1x * py + c2x * pz) * s;
  out[1] = (c0y * px + c1y * py + c2y * pz) * s;
  out[2] = (c0z * px + c1z * py + c2z * pz) * s;
}
