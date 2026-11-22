import { Animator, standingBody } from "../avatar/motion";
import { Skeleton } from "../avatar/skeleton";
import { meshPattern, type GarmentMesh } from "../pattern/mesh";
import { BodySdf } from "../sim/bodySdf";
import { buildClothModel, type ClothModel, type ClothParams, DEFAULT_CLOTH } from "../sim/model";
import { orientOutward } from "./orient";
import { placeGarment, seatGarment } from "./place";
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

/**
 * Clearance kept between the skin and the cloth (ClothParams.skinGap, m) for a mesh of that
 * spacing (cm). The solvers keep the cloth's vertices off a distance field of the body, and
 * what must not show is the skin between them. Two things eat into the clearance:
 *
 *  - the field itself: distances to the plane of the closest body vertex, interpolated on
 *    1 cm cells — up to 3 mm off where the body curves most (the base of the neck);
 *  - the mesh: laid on a part of radius R, a triangle of side L dips L² / (6R) at its
 *    centre under the surface its vertices are kept on.
 *
 * Hence a part for the field plus the dip, fitted on the cape's shoulders (tools/sim-bench,
 * "skin through" and "cross"; and in the application for the 2.2 cm mesh): with 3 mm, a
 * 2.2 cm mesh hides the skin at rest but lets a speck of it through at the neck after a walk,
 * and a 3.3 cm mesh leaves it out by up to 6 mm at rest and 12 mm walking; with 6 mm the
 * latter hides it; with 9 mm too, but cloth held that far from the skin has no room left
 * between the arm and the body and crosses itself there (460 crossings walking, against 0 to
 * 13). The finer meshes keep the default: 1.5 cm gives 3 mm.
 */
const FIELD_SLACK = 0.00225;
const BODY_RADIUS = 0.05;
export const skinGapFor = (spacing: number) => Math.max(DEFAULT_CLOTH.skinGap, FIELD_SLACK + (spacing / 100) ** 2 / (6 * BODY_RADIUS));

/**
 * Size of the cloth's largest triangles, in mesh spacings: those along the pieces' edges,
 * where the interior points stop short of the outline (lib/pattern/mesh.ts) — up to 1.75 on a
 * cape. The body's sharp parts are inflated for them (BodySdf, `chord`).
 */
const LARGEST_TRIANGLE = 1.75;

/** Hands' collision offset (m): about a finger's thickness, fills the gaps between fingers. */
const HAND_INFLATE = 0.012;
/**
 * Limbs that swing far from where they are in the standing pose (a runner's forearms and heels):
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
   * Positions before sewing, around the body as it stands (arms along the body: avatar/motion.ts
   * standingBody): where the simulation starts, in the pose the body collisions are solved in
   * (lib/sim/posedBody.ts) — the garment is sewn on the body as shown, and the collision field
   * is that very body.
   */
  initial: Float32Array;
  /** Collision field of the standing body. */
  sdf: BodySdf;
  params: ClothParams;
  model: ClothModel;
}

export function prepareGarment(req: Pick<DressRequest, "mode" | "pattern" | "body" | "torso" | "cloth">): PreparedGarment {
  const { mode, pattern, body, torso } = req;
  const spacing = SPACING[mode] * (pattern.sim?.spacingScale ?? 1);
  const mesh = meshPattern(pattern, spacing);
  // Everything from here on is about the body as it stands: the garment is placed around it,
  // and collides with it.
  const skeleton = new Skeleton(body.rig.labels, body.rig.parents, body.joints, body.positions, body.skin);
  const stand = standingBody(new Animator(skeleton), body, body.skin);
  const initial = placeGarment(mesh, stand, torso, pattern.kind);
  const { min, max, h } = collisionBox(initial, stand.positions, pattern.sim?.fallRoom ?? DEFAULT_FALL);
  // Hands as mittens: fingers are thinner than a cloth triangle (see BodySdf).
  const hands = ["wrist.L", "wrist.R"].map((l) => body.rig.labels.indexOf(l)).filter((i) => i >= 0);
  const limbs = LIMBS.map((l) => body.rig.labels.indexOf(l)).filter((i) => i >= 0);
  const sdf = new BodySdf(stand.positions, stand.normals, min, max, h, 0.05, body.skin, { joints: hands, offset: HAND_INFLATE }, limbs, body.indices, (LARGEST_TRIANGLE * spacing) / 100);
  seatGarment(mesh, initial, torso, pattern.kind, sdf);
  orientOutward(mesh, initial, sdf);
  const hints = pattern.sim ?? {};
  const params: ClothParams = {
    ...DEFAULT_CLOTH,
    substeps: SUBSTEPS[mode],
    selfInterval: SELF_INTERVAL[mode],
    selfIntervalHeld: SELF_INTERVAL_HELD[mode],
    skinGap: skinGapFor(spacing),
    ...req.cloth,
    ...(hints.damping !== undefined && { damping: hints.damping }),
    ...(hints.duration !== undefined && { duration: hints.duration }),
    ...(hints.settleTime !== undefined && { settleTime: hints.settleTime }),
    floorY: torso.floorY,
  };
  return { mesh, initial, sdf, params, model: buildClothModel(mesh, initial, params) };
}
