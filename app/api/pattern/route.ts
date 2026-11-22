import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";
import { changePrompt, DESCRIPTION_MAX, describePrompt, readSketch, retryPrompt, unchangedPieces, ZONE_IDS, type Sketch } from "@/lib/pattern/describe";
import { addShared, libraryConfigured } from "@/lib/library/store";
import type { FreePattern } from "@/lib/pattern/free";
import type { Belt, BodyMeasures, Clasp } from "@/lib/pattern/types";

/**
 * A pattern drawn from its description (lib/pattern/describe.ts): the description and the
 * body's measurements come in, a drawn pattern — pieces, seams, belts — goes out. With `base`,
 * the pattern being worn (as a sketch), the description is a change to make to it, and what
 * goes out is that pattern changed. The drawing
 * is asked of a language model through the Vercel AI Gateway (a plain "provider/model" string:
 * authenticated by the project's OIDC token on Vercel and after `vercel env pull` locally, or
 * by AI_GATEWAY_API_KEY).
 *
 * The model: the best Gemini the gateway's free monthly credit gives access to (2026-11: the
 * Gemini 3 and 4 families are refused to a team without paid credits). PATTERN_MODEL names
 * another model of the gateway — "google/gemini-4-hydrogen" once the team has credits.
 */
const MODEL = process.env.PATTERN_MODEL ?? "google/gemini-2.5-flash";
/** Answers asked of the model for one pattern: the first, then one more when it cannot be sewn as it is (each takes 20 to 50 s). */
const ATTEMPTS = 2;

export const maxDuration = 240;

const point = z.object({ x: z.number(), y: z.number() });
const side = z.object({ piece: z.string(), edge: z.string() });
const sketchSchema = z.object({
  name: z.string(),
  note: z.string(),
  pieces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      zone: z.enum(ZONE_IDS),
      points: z.array(point),
      edges: z.array(z.object({ id: z.string(), via: z.array(point) })),
    }),
  ),
  seams: z.array(z.object({ a: side, b: side })),
  belts: z.array(z.object({ piece: z.string(), edge: z.string(), stretch: z.number() })),
  clasps: z.array(z.object({ a: side.extend({ t: z.number() }), b: side.extend({ t: z.number() }) })),
});

const MEASURES: readonly (keyof BodyMeasures)[] = [
  "bust", "waist", "hips", "neck", "upperArm", "shoulderWidth", "hpsToArmpit", "hpsToHip", "hpsToFloor", "headHeight", "headDepth", "headWidth",
  "waistToHip", "waistToKnee", "hpsToWaist", "waistToFloor", "armLength",
];

/** The body's measurements as sent by the page: every one of them, a plausible length (cm). */
function readMeasures(value: unknown): BodyMeasures | null {
  if (!value || typeof value !== "object") return null;
  const out: Partial<BodyMeasures> = {};
  for (const key of MEASURES) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== "number" || !(v > 1) || !(v < 400)) return null;
    out[key] = v;
  }
  return out as BodyMeasures;
}

export interface DescribedPattern {
  name: string;
  note: string;
  free: FreePattern;
  belts: Belt[];
  clasps: Clasp[];
  /** What is still wrong with the pattern, for the user to put right in the editor. */
  issues: string[];
  /** When a pattern was changed (`base`): the ids of its pieces that came back as they were. */
  unchanged?: string[];
  /** The pattern as it was added to the shared library (lib/library/store.ts): a new model, drawn without a fault. */
  shared?: { id: string; name: string };
}

/** How much of a pattern to change the route reads (characters of JSON): a garment's pieces, not a file. */
const BASE_MAX = 30000;

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/**
 * The HTTP status the gateway answered with, when the error (or the one it wraps) carries one:
 * 402 once a budget is spent — the project's monthly one (`vercel ai-gateway budgets`) or the
 * team's credit — and 429 past the rate limit.
 */
function statusOf(error: unknown): number | undefined {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const { statusCode, lastError, cause } = e as { statusCode?: unknown; lastError?: unknown; cause?: unknown };
    if (typeof statusCode === "number") return statusCode;
    e = lastError ?? cause;
  }
  return undefined;
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  // `asNew`: the change made to `base` is a garment of its own (drawn from a model of the same kind), not a retouch of the one worn.
  const { description, measures, base: told, asNew } = (body ?? {}) as { description?: unknown; measures?: unknown; base?: unknown; asNew?: unknown };
  const m = readMeasures(measures);
  if (typeof description !== "string" || !description.trim() || description.length > DESCRIPTION_MAX || !m)
    return refuse(400, `Décrivez le vêtement en quelques mots (${DESCRIPTION_MAX} caractères au plus).`);
  const base = told === undefined ? null : sketchSchema.safeParse(told);
  if (base && (!base.success || JSON.stringify(base.data).length > BASE_MAX)) return refuse(400, "Le patron à retoucher n'a pas pu être lu.");

  const messages: ModelMessage[] = [{ role: "user", content: base ? changePrompt(base.data, description.trim()) : `The garment to draw: ${description.trim()}` }];
  const started = Date.now();
  let attempts = 0, tokens = 0;
  try {
    let answer: { sketch: Sketch; read: ReturnType<typeof readSketch> } | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { output, usage } = await generateText({ model: MODEL, system: describePrompt(m), messages, output: Output.object({ schema: sketchSchema }) });
      attempts++;
      tokens += usage.totalTokens ?? 0;
      const read = readSketch(output, m);
      // A second answer is kept only if it is better than the first.
      if (!answer || (read.usable && (!answer.read.usable || read.issues.length <= answer.read.issues.length))) answer = { sketch: output, read };
      if (!read.issues.length) break;
      messages.push({ role: "assistant", content: JSON.stringify(output) }, { role: "user", content: retryPrompt(read.issues) });
    }
    if (!answer?.read.usable) return refuse(422, "Le patron dessiné n'a pas pu être cousu. Reformulez la description, ou partez de formes simples.");
    const { sketch, read } = answer;
    // A new model, drawn without a fault, is kept for everyone in the shared library; a retouch
    // of the garment worn, or a pattern left with something to put right, stays the visitor's.
    let shared: DescribedPattern["shared"];
    if ((!base || asNew === true) && !read.issues.length && libraryConfigured()) {
      try {
        const kept = await addShared(sketch.name, sketch.note, { free: read.free, clasps: read.clasps, belts: read.belts });
        shared = { id: kept.id, name: kept.name };
      } catch (e) {
        console.error("pattern from description: not added to the shared library:", e);
      }
    }
    console.info(`pattern from description: ${MODEL}, ${attempts} answer(s), ${tokens} tokens, ${((Date.now() - started) / 1000).toFixed(0)} s, ${read.issues.length} issue(s) left`);
    return Response.json({ name: sketch.name.trim(), note: sketch.note.trim(), free: read.free, belts: read.belts, clasps: read.clasps, issues: read.issues, ...(base && { unchanged: unchangedPieces(base.data, sketch) }), ...(shared && { shared }) } satisfies DescribedPattern);
  } catch (e) {
    console.error("pattern from description:", e);
    // What the gateway refuses for a reason the user can do something about (or wait for).
    const status = statusOf(e);
    if (status === 402) return refuse(402, "Le budget mensuel du dessin par IA est épuisé : il revient le mois prochain. Les autres façons de dessiner un patron restent là.");
    if (status === 429) return refuse(429, "Trop de demandes à la fois. Réessayez dans une minute.");
    return refuse(502, "Le service de dessin n'a pas répondu. Réessayez dans un instant.");
  }
}
