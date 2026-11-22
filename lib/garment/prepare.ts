import { Animator } from "../avatar/motion";
import { BONE_STRIDE, Skeleton } from "../avatar/skeleton";
import { meshPattern, type GarmentMesh } from "../pattern/mesh";
import { BodySdf } from "../sim/bodySdf";
import { buildClothModel, type ClothModel, type ClothParams, DEFAULT_CLOTH } from "../sim/model";
import { orientOutward } from "./orient";
import { placeGarment } from "./place";
import type { DressRequest } from "./protocol";

/**
 * Pattern → mesh → placement → body collision field → coloured XPBD constraints.
 * Shared by the simulation worker (lib/garment/sim.worker.ts) and the headless
 * bench (tools/sim-bench), so that both run the very same garment.
 */

/** Mesh resolution (cm): the GPU affords a finer mesh, hence finer folds. */
export const SPACING = { gpu: 1.0, cpu: 1.5 };
/**
 * Substeps: stiffness only converges with small steps (stretch error ∝ h²).
 * The CPU fallback trades some accuracy (slightly stretchier cloth) for speed.
 */
export const SUBSTEPS = { gpu: 20, cpu: 10 };
/** Substeps between two self-collision passes. */
export const SELF_INTERVAL = { gpu: 2, cpu: 5 };
/**
 * The same while the cloth is held by hand (lib/sim/grab.ts). Measured on a hem lifted by
 * 27 cm (tools/sim-bench, --grab): on the fine mesh, passes every other substep leave 30 to 45
 * crossings where the lifted garment gathers under the arms, every substep none; the coarse
 * mesh leaves none either way.
 */
export const SELF_INTERVAL_HELD = { gpu: 1, cpu: 5 };

/** Hands' collision offset (m): about a finger's thickness, fills the gaps between fingers. */
const HAND_INFLATE = 0.012;
/**
 * Limbs that swing far from where they are in the rest pose (a runner's forearms and heels):
 * tested on their own against the cloth, see lib/sim/posedBody.ts.
 */
const LIMBS = ["lowerarm01.L", "lowerarm01.R", "wrist.L", "wrist.R", "lowerleg01.L", "lowerleg01.R", "foot.L", "foot.R"];
/** Room below the garment's starting position for it to fall into (m). */
const DEFAULT_FALL = 0.25;
/** Cell budget of the collision field: past it the grid gets coarser. */
const MAX_SDF_CELLS = 1.5e6;

/**
 * Collision field box: the garment's working volume (+ room to fall), clipped to
 * the body's own box (outside it nothing can be hit: the field reads "far"). Cell
 * size 1 cm, coarser if the volume is large (a long cape falls the body's height).
 */
function collisionBox(initial: Float32Array, body: Float32Array, fall: number) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const bMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const bMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < initial.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], initial[i + a] - 0.1);
      max[a] = Math.max(max[a], initial[i + a] + 0.1);
    }
  for (let i = 0; i < body.length; i += 3)
    for (let a = 0; a < 3; a++) {
      bMin[a] = Math.min(bMin[a], body[i + a] - 0.12);
      bMax[a] = Math.max(bMax[a], body[i + a] + 0.12);
    }
  min[1] -= fall;
  for (let a = 0; a < 3; a++) {
    min[a] = Math.max(min[a], bMin[a]);
    max[a] = Math.min(max[a], bMax[a]);
  }
  const volume = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  const h = Math.max(0.01, Math.cbrt(volume / MAX_SDF_CELLS));
  return { min, max, h };
}

export interface PreparedGarment {
  mesh: GarmentMesh;
  /**
   * Positions before sewing around the body's rest pose (an A-pose): the space the body
   * collisions are solved in (lib/sim/posedBody.ts).
   */
  initial: Float32Array;
  /**
   * Positions before sewing around the body as it stands (arms along the body): where the
   * simulation starts. The garment is sewn in that pose — the rest pose is never shown.
   */
  start: Float32Array;
  sdf: BodySdf;
  params: ClothParams;
  model: ClothModel;
}

export function prepareGarment(req: Pick<DressRequest, "mode" | "pattern" | "body" | "torso" | "cloth">): PreparedGarment {
  const { mode, pattern, body, torso } = req;
  const mesh = meshPattern(pattern, SPACING[mode] * (pattern.sim?.spacingScale ?? 1));
  const initial = placeGarment(mesh, { positions: body.positions, joints: body.joints }, torso, pattern.kind);
  const { min, max, h } = collisionBox(initial, body.positions, pattern.sim?.fallRoom ?? DEFAULT_FALL);
  // Hands as mittens: fingers are thinner than a cloth triangle (see BodySdf).
  const hands = ["wrist.L", "wrist.R"].map((l) => body.rig.labels.indexOf(l)).filter((i) => i >= 0);
  const limbs = LIMBS.map((l) => body.rig.labels.indexOf(l)).filter((i) => i >= 0);
  const sdf = new BodySdf(body.positions, body.normals, min, max, h, 0.05, body.skin, { joints: hands, offset: HAND_INFLATE }, limbs);
  orientOutward(mesh, initial, sdf);
  // The same placement around the standing body: its joints as posed at time 0 (the pieces
  // placed along the arms — sleeves — follow them; the others do not move).
  const skeleton = new Skeleton(body.rig.labels, body.rig.parents, body.joints, body.positions, body.skin);
  const bones = new Float32Array(skeleton.count * BONE_STRIDE);
  let start = initial;
  if (new Animator(skeleton).sample(0, bones)) {
    const joints: typeof body.joints = {};
    body.rig.labels.forEach((label, k) => {
      const [x, y, z] = body.joints[label], o = k * BONE_STRIDE;
      joints[label] = [0, 1, 2].map((r) => bones[o + 4 * r] * x + bones[o + 4 * r + 1] * y + bones[o + 4 * r + 2] * z + bones[o + 4 * r + 3]) as [number, number, number];
    });
    start = placeGarment(mesh, { positions: body.positions, joints }, torso, pattern.kind);
  }
  const hints = pattern.sim ?? {};
  const params: ClothParams = {
    ...DEFAULT_CLOTH,
    substeps: SUBSTEPS[mode],
    selfInterval: SELF_INTERVAL[mode],
    selfIntervalHeld: SELF_INTERVAL_HELD[mode],
    ...req.cloth,
    ...(hints.damping !== undefined && { damping: hints.damping }),
    ...(hints.duration !== undefined && { duration: hints.duration }),
    ...(hints.settleTime !== undefined && { settleTime: hints.settleTime }),
    floorY: torso.floorY,
  };
  return { mesh, initial, start, sdf, params, model: buildClothModel(mesh, start, params) };
}
