// Measures the garment being simulated on the GPU, from the page's console (development
// build: `window.__couture` is the viewer). Paste this file, then: await coutureProbe()
//
//  - ms: GPU time per simulated frame (1/60 s), over `frames` frames submitted at once;
//  - strain: elongation of the mesh edges against the flat pattern (%), as tools/sim-bench/metrics.ts;
//  - top: mean height of the highest 5 % of the vertices (m): a garment sliding off comes down.
//
// The numbers are the GPU solver's own: compare them with `npm run bench -- --full` (same
// mesh and settings on the CPU solver) to check that both solvers agree.
window.coutureProbe = async function coutureProbe(frames = 120) {
  const viewer = window.__couture;
  const gpu = viewer?.garment?.gpu;
  if (!gpu) return { error: "no garment on the GPU" };
  const { solver } = gpu;
  const m = solver.m;
  const device = solver.device;
  await device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  // The body holds its current pose.
  solver.simulate(frames, 1 / 60, undefined, (_t, out) => viewer.animator.sample(viewer.clock, out));
  await device.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / frames;
  let pos = null;
  while (!pos) pos = await (solver.readPositions() ?? new Promise((r) => setTimeout(() => r(null), 20)));
  const n = m.edgeRest.length;
  const e = new Float64Array(n);
  let sum = 0, len = 0, rest = 0;
  for (let c = 0; c < n; c++) {
    const a = 3 * m.edges[2 * c], b = 3 * m.edges[2 * c + 1];
    const l = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
    e[c] = l / m.edgeRest[c] - 1;
    sum += Math.max(0, e[c]);
    len += l;
    rest += m.edgeRest[c];
  }
  e.sort();
  const q = (f) => +(100 * e[Math.min(n - 1, Math.floor(f * n))]).toFixed(2);
  const ys = Array.from({ length: m.vertexCount }, (_, i) => pos[3 * i + 1]).sort((a, b) => b - a);
  const k = Math.max(1, Math.round(0.05 * ys.length));
  let finite = true;
  for (const x of pos) if (!Number.isFinite(x)) finite = false;
  return {
    vertices: m.vertexCount,
    substeps: m.params.substeps,
    sweeps: [m.params.stretchSweeps, m.params.bendSweeps],
    colours: { edges: m.edgeColors.length, bending: m.bendColors.length, seams: m.seamColors.length },
    bands: m.bands.rest.length,
    ms: +ms.toFixed(2),
    strain: { mean: +((100 * sum) / n).toFixed(2), p95: q(0.95), p99: q(0.99), max: q(1), total: +(100 * (len / rest - 1)).toFixed(2) },
    top: +(ys.slice(0, k).reduce((s, y) => s + y, 0) / k).toFixed(4),
    time: +solver.time.toFixed(2),
    finite,
  };
};
