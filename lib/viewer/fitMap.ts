/**
 * Fit map: colours the garment by how much the fabric works.
 *
 * Per triangle, the deformation gradient F = Ds · Dm⁻¹ maps the flat pattern
 * (warp = pattern y, weft = pattern x) to the draped cloth:
 *  - "tension" (N/m): elongation along warp / weft × the fabric's tensile
 *    modulus in that direction — what the fabric "feels", comparable across fabrics;
 *  - "stretch" (%): largest principal elongation, whatever the direction.
 * Vertices average their incident triangles; compression counts as zero.
 * Shared by the CPU shell (ClothShell) and the GPU shell (GpuClothShell).
 */

export type FitMode = "tension" | "stretch";

export const FIT_SCALES: Record<FitMode, { max: number; unit: string; ticks: number[]; label: string }> = {
  tension: { max: 15, unit: "N/m", ticks: [0, 5, 10, 15], label: "Tension" },
  stretch: { max: 0.1, unit: "%", ticks: [0, 0.025, 0.05, 0.075, 0.1], label: "Étirement" },
};

/** Colour ramp from "free" to "tight" (sRGB). */
export const FIT_RAMP = ["#2f5fd0", "#2bb3a3", "#9fd03a", "#f2c12e", "#e0442f"];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Ramp stops in linear RGB (vertex colours are linear). */
export const FIT_RAMP_LINEAR: [number, number, number][] = FIT_RAMP.map((hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
});

export const FIT_MODE_INDEX: Record<FitMode, number> = { tension: 0, stretch: 1 };

/** Tensile moduli of the fabric (N/m), used by the tension mode. */
export interface Tensile {
  warp: number;
  weft: number;
}

/**
 * Inverse of the rest-shape matrix Dm = [r1 - r0, r2 - r0] of every triangle,
 * row-major (i00, i01, i10, i11).
 */
export function restInverses(rest: Float32Array, triangles: Uint32Array): Float32Array {
  const out = new Float32Array((triangles.length / 3) * 4);
  for (let t = 0, o = 0; t < triangles.length; t += 3, o += 4) {
    const a = 2 * triangles[t], b = 2 * triangles[t + 1], c = 2 * triangles[t + 2];
    const u0 = rest[b] - rest[a], u1 = rest[b + 1] - rest[a + 1];
    const v0 = rest[c] - rest[a], v1 = rest[c + 1] - rest[a + 1];
    const det = u0 * v1 - v0 * u1 || 1e-12;
    out[o] = v1 / det;
    out[o + 1] = -v0 / det;
    out[o + 2] = -u1 / det;
    out[o + 3] = u0 / det;
  }
  return out;
}

/** Fit value of one triangle (see module comment). e1 = x1 - x0, e2 = x2 - x0. */
export function triangleFit(
  e1x: number, e1y: number, e1z: number, e2x: number, e2y: number, e2z: number,
  inv: Float32Array, o: number, mode: FitMode, tensile: Tensile,
): number {
  // F columns: f0 = F·weft, f1 = F·warp
  const f0x = e1x * inv[o] + e2x * inv[o + 2], f0y = e1y * inv[o] + e2y * inv[o + 2], f0z = e1z * inv[o] + e2z * inv[o + 2];
  const f1x = e1x * inv[o + 1] + e2x * inv[o + 3], f1y = e1y * inv[o + 1] + e2y * inv[o + 3], f1z = e1z * inv[o + 1] + e2z * inv[o + 3];
  const a = f0x * f0x + f0y * f0y + f0z * f0z, c = f1x * f1x + f1y * f1y + f1z * f1z;
  if (mode === "tension")
    return Math.max(tensile.weft * Math.max(0, Math.sqrt(a) - 1), tensile.warp * Math.max(0, Math.sqrt(c) - 1));
  const b = f0x * f1x + f0y * f1y + f0z * f1z;
  const l2 = (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b);
  return Math.max(0, Math.sqrt(l2) - 1);
}

/** Linear RGB colour of a fit value. */
export function fitColor(value: number, mode: FitMode, out: number[] = [0, 0, 0]): number[] {
  const x = Math.min(1, Math.max(0, value / FIT_SCALES[mode].max)) * (FIT_RAMP_LINEAR.length - 1);
  const i = Math.min(FIT_RAMP_LINEAR.length - 2, Math.floor(x)), t = x - i;
  for (let k = 0; k < 3; k++) out[k] = FIT_RAMP_LINEAR[i][k] * (1 - t) + FIT_RAMP_LINEAR[i + 1][k] * t;
  return out;
}

/** WGSL counterparts (generated from the same constants). */
export const fitWGSL = /* wgsl */ `
struct FitParams { mode: u32, scale: f32, warp: f32, weft: f32 }

fn triangleFit(e1: vec3f, e2: vec3f, inv: vec4f, fp: FitParams) -> f32 {
  let f0 = e1 * inv.x + e2 * inv.z;
  let f1 = e1 * inv.y + e2 * inv.w;
  let a = dot(f0, f0);
  let c = dot(f1, f1);
  if (fp.mode == 0u) {
    return max(fp.weft * max(0.0, sqrt(a) - 1.0), fp.warp * max(0.0, sqrt(c) - 1.0));
  }
  let b = dot(f0, f1);
  let l2 = (a + c) * 0.5 + sqrt(((a - c) * 0.5) * ((a - c) * 0.5) + b * b);
  return max(0.0, sqrt(l2) - 1.0);
}

const RAMP = array<vec3f, ${FIT_RAMP_LINEAR.length}>(${FIT_RAMP_LINEAR.map((c) => `vec3f(${c.map((v) => v.toFixed(5)).join(", ")})`).join(", ")});

fn fitColor(value: f32, fp: FitParams) -> vec3f {
  let x = clamp(value / fp.scale, 0.0, 1.0) * ${FIT_RAMP_LINEAR.length - 1}.0;
  let i = min(u32(floor(x)), ${FIT_RAMP_LINEAR.length - 2}u);
  var ramp = RAMP; // runtime indexing needs a variable, not a const
  return mix(ramp[i], ramp[i + 1u], x - f32(i));
}
`;
