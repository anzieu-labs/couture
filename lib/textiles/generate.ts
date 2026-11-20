import type { Pattern, Textile } from "./catalog";

/**
 * Procedural, seamlessly tiling textile maps (albedo + tangent-space normal).
 * Every pattern is periodic over one tile so the texture can repeat freely.
 */

export interface TextileColors {
  primary: string;
  secondary?: string;
}

export interface TextileMaps {
  size: number;
  /** sRGB RGBA8 */
  albedo: Uint8ClampedArray<ArrayBuffer>;
  /** Tangent-space normal map RGBA8 (OpenGL convention) */
  normal: Uint8ClampedArray<ArrayBuffer>;
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------------------
// Periodic noise
// ---------------------------------------------------------------------------

function hash(i: number, j: number, seed = 0): number {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Value noise with an integer lattice period (px, py). */
function noise(x: number, y: number, px: number, py: number, seed = 0): number {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const i0 = mod(i, px), i1 = mod(i + 1, px), j0 = mod(j, py), j1 = mod(j + 1, py);
  const a = hash(i0, j0, seed), b = hash(i1, j0, seed), c = hash(i0, j1, seed), d = hash(i1, j1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(u: number, v: number, base: number, octaves: number, seed = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u * f, v * f, f, f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Knits: rows of interlocked V-shaped loops
// ---------------------------------------------------------------------------

interface KnitSample { h: number; i: number; j: number }

function knit(u: number, v: number, W: number, C: number, out: KnitSample): KnitSample {
  const gx = u * W, gy = v * C;
  const ci = Math.floor(gx), cj = Math.floor(gy);
  const aspect = W / C; // course height expressed in wale widths
  const a = 0.78 * aspect, b = 0.27;
  out.h = 0; out.i = mod(ci, W); out.j = mod(cj, C);
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj;
      for (let s = -1; s <= 1; s += 2) {
        const dx = gx - (i + 0.5 + s * 0.22);
        const dy = (gy - (j + 0.5)) * aspect;
        // leg axis: top splayed outwards, bottom towards the wale centre
        const axx = -s * 0.33, axy = 0.944;
        const along = dx * axx + dy * axy;
        const across = -dx * axy + dy * axx;
        const r2 = (along / a) ** 2 + (across / b) ** 2;
        if (r2 < 1) {
          const h = Math.sqrt(1 - r2) * (0.92 + 0.16 * hash(mod(i, W), mod(j, C), 3));
          if (h > out.h) { out.h = h; out.i = mod(i, W); out.j = mod(j, C); }
        }
      }
    }
  return out;
}

// ---------------------------------------------------------------------------
// Wovens: generic interlacing of warp (vertical) and weft (horizontal) threads
// ---------------------------------------------------------------------------

interface WeaveSpec {
  nWarp: number;
  nWeft: number;
  /** true when the warp thread passes over the weft at cell (i, j) */
  up: (i: number, j: number) => boolean;
  warpWidth: (i: number, v: number) => number;
  weftWidth: (j: number, u: number) => number;
}

interface WeaveSample { h: number; warp: boolean; i: number; j: number }

function weave(u: number, v: number, s: WeaveSpec, out: WeaveSample): WeaveSample {
  const gx = u * s.nWarp, gy = v * s.nWeft;
  const i = Math.floor(gx), j = Math.floor(gy);
  const fx = gx - i, fy = gy - j;
  const W = s.nWarp, H = s.nWeft;
  const up = (a: number, b: number) => s.up(mod(a, W), mod(b, H));
  const prof = (f: number, w: number) => {
    const d = Math.abs(f - 0.5) * 2 / w;
    return d < 1 ? Math.sqrt(1 - d * d) : 0;
  };
  const warpP = prof(fx, s.warpWidth(mod(i, W), v));
  const weftP = prof(fy, s.weftWidth(mod(j, H), u));
  const warpUp = up(i, j);
  // Threads dip only where they change side, so floats stay flat.
  let along: number;
  if (warpUp) {
    along = 1 - 0.4 * ((up(i, j - 1) ? 0 : (1 - fy) ** 3) + (up(i, j + 1) ? 0 : fy ** 3));
  } else {
    along = 1 - 0.4 * ((!up(i - 1, j) ? 0 : (1 - fx) ** 3) + (!up(i + 1, j) ? 0 : fx ** 3));
  }
  const topP = warpUp ? warpP : weftP;
  const botP = warpUp ? weftP : warpP;
  out.i = mod(i, W); out.j = mod(j, H);
  if (topP > 0.08) { out.h = 0.35 + 0.65 * topP * along; out.warp = warpUp; }
  else if (botP > 0) { out.h = 0.3 * botP; out.warp = !warpUp; }
  else { out.h = 0; out.warp = warpUp; }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern painters: write height (0..1) and colour for one pixel
// ---------------------------------------------------------------------------

type Painter = (u: number, v: number, out: { h: number; c: RGB }) => void;

function makePainter(pattern: Pattern, primary: RGB, secondary: RGB): Painter {
  const k: KnitSample = { h: 0, i: 0, j: 0 };
  const w: WeaveSample = { h: 0, warp: true, i: 0, j: 0 };
  const shade = (c: RGB, f: number, o: { c: RGB }) => {
    o.c[0] = c[0] * f; o.c[1] = c[1] * f; o.c[2] = c[2] * f;
  };

  switch (pattern) {
    case "jersey":
      return (u, v, o) => {
        knit(u, v, 16, 22, k);
        const heather = 0.94 + 0.1 * fbm(u, v, 32, 3, 1);
        o.h = k.h;
        shade(primary, (0.6 + 0.4 * k.h) * heather, o);
      };
    case "breton":
      return (u, v, o) => {
        knit(u, v, 18, 24, k);
        o.h = k.h;
        shade(k.j % 24 < 8 ? primary : secondary, 0.62 + 0.38 * k.h, o);
      };
    case "rib":
      return (u, v, o) => {
        knit(u, v, 16, 22, k);
        const face = k.i % 4 < 2;
        o.h = face ? 0.25 + 0.75 * k.h : 0.3 * k.h;
        shade(primary, face ? 0.62 + 0.38 * k.h : 0.5 + 0.2 * k.h, o);
      };
    case "chunkyKnit":
      return (u, v, o) => {
        knit(u, v, 6, 8, k);
        const fuzz = fbm(u, v, 48, 4, 5);
        o.h = Math.min(1, k.h * (0.85 + 0.3 * fuzz));
        shade(primary, (0.5 + 0.5 * k.h) * (0.88 + 0.2 * fuzz), o);
      };
    case "pique":
      return (u, v, o) => {
        const C = 14, W = 10;
        const gy = v * C, j = Math.floor(gy);
        const gx = u * W + (mod(j, 2) ? 0.5 : 0), i = Math.floor(gx);
        const dx = (gx - i - 0.5) * 2, dy = (gy - j - 0.5) * 2;
        const r = Math.sqrt(dx * dx * 0.9 + dy * dy);
        const cell = Math.min(1, Math.max(0, (r - 0.3) / 0.6));
        knit(u, v, 40, 56, k);
        o.h = 0.25 + 0.55 * cell * cell * (3 - 2 * cell) + 0.2 * k.h;
        shade(primary, 0.66 + 0.34 * o.h, o);
      };
    case "linen": {
      const spec: WeaveSpec = {
        nWarp: 24, nWeft: 24,
        up: (i, j) => ((i + j) & 1) === 0,
        warpWidth: (i, v) => 0.62 + 0.3 * noise(i * 3.1, v * 6, 75, 6, 11) + 0.1 * hash(i, 0, 2),
        weftWidth: (j, u) => 0.62 + 0.3 * noise(j * 3.1, u * 6, 75, 6, 13) + 0.1 * hash(j, 0, 4),
      };
      return (u, v, o) => {
        weave(u, v, spec, w);
        // heathered yarn: tone drifts along each thread instead of per-thread bands
        const tone = w.warp
          ? 0.9 + 0.14 * noise(w.i * 1.7, v * 4, 41, 4, 7)
          : 0.88 + 0.14 * noise(w.j * 1.7, u * 4, 41, 4, 9);
        o.h = w.h;
        shade(primary, (0.55 + 0.45 * w.h) * tone, o);
      };
    }
    case "denim": {
      const spec: WeaveSpec = {
        nWarp: 32, nWeft: 32,
        up: (i, j) => mod(i - j, 4) !== 3,
        warpWidth: () => 0.95,
        weftWidth: () => 0.9,
      };
      return (u, v, o) => {
        weave(u, v, spec, w);
        o.h = w.h;
        if (w.warp) {
          const slub = noise(w.i * 2.7, v * 8, 86, 8, 21); // ring-dyed irregularity along the yarn
          shade(primary, (0.55 + 0.45 * w.h) * (0.72 + 0.5 * slub), o);
        } else {
          shade(secondary, 0.45 + 0.4 * w.h, o);
        }
      };
    }
    case "gingham": {
      const spec: WeaveSpec = {
        nWarp: 48, nWeft: 48,
        up: (i, j) => ((i + j) & 1) === 0,
        warpWidth: () => 0.85,
        weftWidth: () => 0.85,
      };
      return (u, v, o) => {
        weave(u, v, spec, w);
        const colored = w.warp ? Math.floor(w.i / 8) % 2 === 0 : Math.floor(w.j / 8) % 2 === 0;
        o.h = w.h;
        shade(colored ? primary : secondary, 0.62 + 0.38 * w.h, o);
      };
    }
    case "satin": {
      const spec: WeaveSpec = {
        nWarp: 40, nWeft: 40,
        up: (i, j) => mod(j - 2 * i, 5) !== 0,
        warpWidth: () => 1.0,
        weftWidth: () => 0.9,
      };
      return (u, v, o) => {
        weave(u, v, spec, w);
        o.h = w.h;
        shade(primary, 0.86 + 0.14 * w.h, o);
      };
    }
    case "velvet":
      return (u, v, o) => {
        const pile = fbm(u, v, 64, 3, 31);
        const crush = fbm(u, v, 3, 3, 41);
        o.h = pile;
        shade(primary, 0.78 + 0.3 * crush, o);
      };
  }
}

/** Renders the albedo + normal maps of a textile at `size`×`size` pixels. */
export function generateTextileMaps(textile: Textile, colors: TextileColors, size = 512): TextileMaps {
  const primary = hexToRgb(colors.primary);
  const secondary = hexToRgb(colors.secondary ?? textile.secondary?.default ?? "#ffffff");
  const paint = makePainter(textile.pattern, primary, secondary);
  const n = size * size;
  const height = new Float32Array(n);
  const albedo = new Uint8ClampedArray(n * 4);
  const o = { h: 0, c: [0, 0, 0] as RGB };

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      paint((x + 0.5) / size, (y + 0.5) / size, o);
      const p = y * size + x;
      height[p] = o.h;
      albedo[p * 4] = o.c[0] * 255;
      albedo[p * 4 + 1] = o.c[1] * 255;
      albedo[p * 4 + 2] = o.c[2] * 255;
      albedo[p * 4 + 3] = 255;
    }

  const normal = new Uint8ClampedArray(n * 4);
  const s = 6 * (size / 512);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = height[y * size + mod(x - 1, size)], r = height[y * size + mod(x + 1, size)];
      const t = height[mod(y - 1, size) * size + x], b = height[mod(y + 1, size) * size + x];
      // image rows go down, tangent-space +V goes up
      const nx = -(r - l) * s, ny = (b - t) * s, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const p = (y * size + x) * 4;
      normal[p] = (nx / len * 0.5 + 0.5) * 255;
      normal[p + 1] = (ny / len * 0.5 + 0.5) * 255;
      normal[p + 2] = (nz / len * 0.5 + 0.5) * 255;
      normal[p + 3] = 255;
    }

  return { size, albedo, normal };
}
