import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB as HOLD } from "../../lib/sim/grab";
import { loadBody, runScenario, type Result, type Scenario } from "./scene";

/**
 * Headless bench of the garment simulation (CPU solver, the reference of the GPU
 * one): the app's garments sewn on the default mannequin, at rest and in motion.
 * See README.md for the measures and how to read them.
 *
 *   npm run bench -- [--label name] [--compare name] [--only regex] [--cloth json] [--full] [--grab] [--hold json] [--verbose]
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

const QUICK: Scenario[] = [
  { name: "tshirt jersey rest", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 5 },
  { name: "tshirt denim rest", garment: "tshirt", textile: "denim", mode: "cpu", duration: 5 },
  { name: "tshirt jersey walk", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 9, walk: true },
  { name: "skirt jersey walk", garment: "skirt", textile: "jersey", mode: "cpu", duration: 9, walk: true },
  { name: "skirt denim walk", garment: "skirt", textile: "denim", mode: "cpu", duration: 9, walk: true },
  { name: "cape wool walk", garment: "cape", textile: "wool", mode: "cpu", duration: 11, walk: true },
  { name: "cape wool run", garment: "cape", textile: "wool", mode: "cpu", duration: 11, walk: true, cadence: 170 },
  { name: "tshirt jersey run", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 8, walk: true, cadence: 170 },
  { name: "tshirt jersey squat", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 7, posture: "squatting" },
  { name: "skirt denim sit", garment: "skirt", textile: "denim", mode: "cpu", duration: 7, posture: "sitting" },
  // Waistband elasticity: 10 % sits lower on the hips; none, the skirt falls — onto the floor.
  { name: "skirt jersey walk, elastic waistband", garment: "skirt", textile: "jersey", mode: "cpu", duration: 9, walk: true, garmentParams: { waistband: 10 } },
  { name: "skirt jersey, no waistband (falls)", garment: "skirt", textile: "jersey", mode: "cpu", duration: 6, garmentParams: { waistband: 40 } },
];
/**
 * The cloth held by hand (lib/sim/grab.ts): lifted where it is free to follow, pulled where the
 * garment holds it back (a hem pulled down, a chest pulled sideways) — it must not be stretched
 * without limit, and must fall back in place.
 */
const GRAB: Scenario[] = [
  { name: "grab: tshirt jersey, hem lifted", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [0.1, 0.2, 0.15], ramp: 0.5, hold: 1 } },
  { name: "grab: tshirt jersey, hem pulled down", garment: "tshirt", textile: "jersey", mode: "cpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [0, -0.5, 0], ramp: 0.5, hold: 1 } },
  { name: "grab: tshirt denim, chest pulled sideways", garment: "tshirt", textile: "denim", mode: "cpu", duration: 7.5, grab: { where: "chest", at: 3, pull: [0.4, 0, 0], ramp: 0.5, hold: 1 } },
  { name: "grab: skirt jersey, hem lifted", garment: "skirt", textile: "jersey", mode: "cpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [0.2, 0.3, 0.1], ramp: 0.5, hold: 1 } },
  { name: "grab: cape wool, hem pulled away", garment: "cape", textile: "wool", mode: "cpu", duration: 9.5, grab: { where: "hem", at: 5, pull: [0.3, 0.3, 0.4], ramp: 0.6, hold: 1 } },
  { name: "grab: tshirt jersey, hem lifted (gpu preset)", garment: "tshirt", textile: "jersey", mode: "gpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [0.1, 0.2, 0.15], ramp: 0.5, hold: 1 } },
  // Folded up against the body, to the chest: the layers slide on each other under the hand.
  { name: "grab: tshirt jersey, hem folded up (gpu preset)", garment: "tshirt", textile: "jersey", mode: "gpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [-0.2, 0.3, 0], ramp: 0.5, hold: 1 } },
  { name: "grab: tshirt jersey, hem pulled down (gpu preset)", garment: "tshirt", textile: "jersey", mode: "gpu", duration: 7.5, grab: { where: "hem", at: 3, pull: [0, -0.5, 0], ramp: 0.5, hold: 1 } },
];
/** The GPU solver's settings (1 cm mesh, 20 substeps) on the CPU: slow, the reference for what ships. */
const FULL: Scenario[] = [
  { name: "tshirt denim rest (gpu preset)", garment: "tshirt", textile: "denim", mode: "gpu", duration: 5 },
  { name: "tshirt jersey walk (gpu preset)", garment: "tshirt", textile: "jersey", mode: "gpu", duration: 7, walk: true },
  { name: "skirt jersey walk (gpu preset)", garment: "skirt", textile: "jersey", mode: "gpu", duration: 7, walk: true },
];

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const resultsDir = join(here, "results");
const only = option("only");
/** Solver overrides for every scenario, e.g. --cloth '{"coarse":[]}' (to compare settings). */
const cloth = JSON.parse(option("cloth") ?? "{}");
const scenarios = [...(flag("grab") ? GRAB : QUICK), ...(flag("full") ? FULL : [])]
  .filter((s) => !only || new RegExp(only).test(s.name))
  .map((s) => ({ ...s, cloth: { ...s.cloth, ...cloth } }));

/** Settings of the hold (lib/sim/grab.ts GRAB) for the --grab scenarios, e.g. --hold '{"force":1.5}'. */
Object.assign(HOLD, JSON.parse(option("hold") ?? "{}"));

const body = loadBody(root);
const results: Result[] = [];
for (const sc of scenarios) {
  const t0 = performance.now();
  process.stdout.write(`${sc.name}…${flag("verbose") ? "\n" : " "}`);
  const r = runScenario(body, sc, flag("verbose") ? (l) => console.log(l) : undefined);
  results.push(r);
  console.log(`${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

const columns: [string, (r: Result) => number | string, number?][] = [
  ["verts", (r) => r.vertices],
  ["ms/frame", (r) => r.msPerFrame, 1],
  ["strain mean %", (r) => r.strain.mean, 2],
  ["p99 %", (r) => r.strain.p99, 2],
  ["max %", (r) => r.strain.max, 1],
  ["p99 worst %", (r) => r.strainP99Max, 2],
  ["cross end", (r) => r.crossings.end],
  ["cross mean", (r) => r.crossings.mean, 1],
  ["cross max", (r) => r.crossings.max],
  ["pen verts", (r) => r.penetration.count],
  ["pen mm", (r) => r.penetration.depth, 1],
  ["limbs through %", (r) => r.limbsThrough?.samples ?? 0],
  ["drop cm", (r) => r.drop, 1],
  ["above floor cm", (r) => r.aboveFloor, 2],
  ["speed mm/s", (r) => r.speedEnd.mean, 1],
  ["rest at s", (r) => (r.restAt === null ? "–" : r.restAt.toFixed(1))],
  ["held verts", (r) => r.grab?.vertices ?? "–"],
  ["pull asked cm", (r) => r.grab?.asked ?? "–", 1],
  ["pull moved cm", (r) => r.grab?.moved ?? "–", 1],
  ["held p99 %", (r) => r.grab?.strainP99 ?? "–", 1],
  ["held max %", (r) => r.grab?.strainMax ?? "–", 1],
  ["back to cm", (r) => r.grab?.back ?? "–", 1],
];
const fmt = (v: number | string, digits = 0) => (typeof v === "string" ? v : v.toFixed(digits));

const baselineName = option("compare");
const baselineFile = baselineName && join(resultsDir, `${baselineName}.json`);
const baseline: Result[] | null = baselineFile && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
if (baselineName && !baseline) console.warn(`No results named "${baselineName}" to compare with.`);

for (const r of results) {
  const ref = baseline?.find((b) => b.name === r.name);
  console.log(`\n${r.name}${r.finite ? "" : "  !! NaN !!"}   ms/frame: ${Object.entries(r.phases).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
  for (const [label, get, digits] of columns) {
    const now = get(r);
    const was = ref ? get(ref) : undefined;
    const delta = typeof now === "number" && typeof was === "number" && was !== now ? `   (was ${fmt(was, digits)})` : "";
    console.log(`  ${label.padEnd(15)} ${fmt(now, digits).padStart(9)}${delta}`);
  }
}

const label = option("label");
if (label) {
  mkdirSync(resultsDir, { recursive: true });
  // Merge into an existing file, so that --only refreshes a part of it.
  const file = join(resultsDir, `${label}.json`);
  const previous: Result[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const merged = [...previous.filter((p) => !results.some((r) => r.name === p.name)), ...results];
  writeFileSync(file, JSON.stringify(merged, null, 1));
  console.log(`\nSaved to tools/sim-bench/results/${label}.json`);
}
