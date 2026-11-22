import { z } from "zod";
import { LOCAL_CHANGE_LABELS, MORPHOLOGY_SLIDERS } from "../avatar/morphology";
import { CADENCE, RUN_CADENCE } from "../avatar/motion";
import { BELT_STRETCH } from "../pattern/belt";
import { DESCRIPTION_MAX } from "../pattern/describe";
import { GARMENTS } from "../pattern/garments";
import { CUSTOM_TEXTILE, PALETTE, TEXTILE_FIELDS, TEXTILES } from "../textiles/catalog";

/**
 * The workshop's assistant: a conversation, kept open beside the 3D view, with a language
 * model that sets the workshop's own controls — the mannequin, its pose, the textile, the
 * garment — as the user would with the panels.
 *
 * Everything it sets lives in the page (components/Studio.tsx), so its tools have no server
 * side: the model, reached through app/api/assistant/route.ts, only says which tool to call
 * with what; the page runs it (components/hooks/useAssistant.ts) and answers with what was
 * done. This file is what the two share: the tools' names and inputs, what the model is told
 * of the workshop (assistantPrompt), and how a call reads in the conversation (callLabel).
 */

const LOCAL_KEYS = Object.keys(LOCAL_CHANGE_LABELS) as [string, ...string[]];
const TEXTILE_IDS: [string, ...string[]] = [CUSTOM_TEXTILE, ...TEXTILES.map((t) => t.id)];
const LOOK_IDS = TEXTILES.map((t) => t.id) as [string, ...string[]];
const GARMENT_IDS = GARMENTS.map((g) => g.id) as [string, ...string[]];
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const assistantInputs = {
  setMorphology: z.object({
    gender: z.enum(["homme", "femme"]).optional(),
    statureCm: z.number().optional(),
    ageYears: z.number().optional(),
    weight: z.number().optional(),
    muscle: z.number().optional(),
    cupsize: z.number().optional(),
    firmness: z.number().optional(),
  }),
  setGirths: z.object({
    bust: z.number().nullable().optional(),
    waist: z.number().nullable().optional(),
    hips: z.number().nullable().optional(),
  }),
  setBodyDetails: z.object({ changes: z.array(z.object({ key: z.enum(LOCAL_KEYS), value: z.number() })) }),
  setPose: z.object({
    posture: z.enum(["standing", "sitting", "squatting"]).optional(),
    walking: z.boolean().optional(),
    cadence: z.number().optional(),
  }),
  setTextile: z.object({ id: z.enum(TEXTILE_IDS).optional(), color: hex.optional(), secondaryColor: hex.optional() }),
  setCustomTextile: z.object({
    name: z.string().max(60).optional(),
    look: z.enum(LOOK_IDS).optional(),
    weight: z.number().optional(),
    thickness: z.number().optional(),
    bending: z.number().optional(),
    warp: z.number().optional(),
    weft: z.number().optional(),
    friction: z.number().optional(),
  }),
  setGarment: z.object({
    id: z.enum(GARMENT_IDS).optional(),
    params: z.array(z.object({ key: z.string(), value: z.number() })).optional(),
  }),
  drawGarment: z.object({ description: z.string().min(3).max(DESCRIPTION_MAX), startFrom: z.string().nullable() }),
  wearSaved: z.object({ id: z.string() }),
  removePieces: z.object({ pieces: z.array(z.string()).min(1) }),
  reshapeGarment: z.object({ change: z.string().min(3).max(DESCRIPTION_MAX) }),
  addClasp: z.object({
    a: z.object({ piece: z.string(), edge: z.string(), t: z.number() }),
    b: z.object({ piece: z.string(), edge: z.string(), t: z.number() }),
  }),
  addBelt: z.object({ piece: z.string(), edge: z.string(), stretch: z.number().optional() }),
  removeAccessories: z.object({ clasps: z.boolean().optional(), belts: z.boolean().optional() }),
  setView: z.object({
    view: z.enum(["face", "profil", "dos", "buste"]).optional(),
    display: z.enum(["tissu", "tension", "stretch"]).optional(),
    autoRotate: z.boolean().optional(),
  }),
};

export type AssistantTool = keyof typeof assistantInputs;
export type AssistantInput<T extends AssistantTool> = z.infer<(typeof assistantInputs)[T]>;

const slider = (key: string) => MORPHOLOGY_SLIDERS.find((s) => s.key === key)!;
const F = TEXTILE_FIELDS;

/** The tools as the model is given them: no `execute` — the page runs them. */
export const assistantTools = {
  setMorphology: {
    description: `Set the mannequin's overall build. Only the fields given change. statureCm ${slider("statureCm").min}–${slider("statureCm").max}; ageYears ${slider("ageYears").min}–${slider("ageYears").max}; weight (corpulence), muscle, cupsize (bust) and firmness from 0 to 1, 0.5 being average (weight 0 thin, 1 heavy).`,
    inputSchema: assistantInputs.setMorphology,
  },
  setGirths: {
    description:
      "Pin the bust, waist or hips girth to a measure in centimetres: the body is reshaped locally to reach it, and keeps it when the rest changes. null releases a girth. Use this when the user gives a girth in cm; use setMorphology for 'bigger', 'thinner'.",
    inputSchema: assistantInputs.setGirths,
  },
  setBodyDetails: {
    description: `Local adjustments of the body, each from -1 to 1 (0: as the build gives it). Keys: ${Object.entries(LOCAL_CHANGE_LABELS)
      .map(([k, label]) => `${k} (${label})`)
      .join(", ")}.`,
    inputSchema: assistantInputs.setBodyDetails,
  },
  setPose: {
    description: `Pose and motion. posture: standing, sitting or squatting (a posture other than standing stops the walk). walking: true to walk on the spot. cadence in steps per minute, ${CADENCE.min}–${CADENCE.max}: a walk below ${RUN_CADENCE.from}, a run from ${RUN_CADENCE.to} (to make it run: walking true, cadence 170).`,
    inputSchema: assistantInputs.setPose,
  },
  setTextile: {
    description: `Choose the garment's textile by its id, and/or its colours as #rrggbb (secondaryColor only for textiles with a second colour: stripes, checks, denim). The id "${CUSTOM_TEXTILE}" is the user's own textile (see setCustomTextile).`,
    inputSchema: assistantInputs.setTextile,
  },
  setCustomTextile: {
    description: `Set the user's own textile and wear it: only the fields given change. look: the library textile it looks like. weight ${F.weight.min}–${F.weight.max} g/m²; thickness ${F.thickness.min}–${F.thickness.max} mm; bending (rigidity) ${F.bending.min * 1e6}–${F.bending.max * 1e6} µN·m (below 3 fluid, 3–12 supple, 12–40 structured, above rigid); warp and weft stretch ${F.warp.min}–${F.warp.max} %; friction ${F.friction.min}–${F.friction.max}.`,
    inputSchema: assistantInputs.setCustomTextile,
  },
  setGarment: {
    description:
      "Wear a garment of the catalogue (id) and/or change settings of the garment (params: key and value in cm, as listed for each garment; 0 for a length means automatic). Without id, the settings are those of the garment worn.",
    inputSchema: assistantInputs.setGarment,
  },
  drawGarment: {
    description:
      "Have a garment the user asks for drawn (a pattern maker model draws its pieces and sews them; 30 to 90 seconds), and saved to the user's library. `description`: the garment, in the user's words, completed with what they said earlier. `startFrom` is a decision you must make each time: the id of the model the drawing starts from — the saved pattern (state.library) or the catalogue garment that is the same kind of garment as the one asked (a poncho for a poncho, a dress for a dress, a hooded top for a hooded top) — so that it is adjusted instead of being drawn again from nothing; null only when no saved pattern and no catalogue garment is of that kind. A saved pattern of that kind comes before a catalogue garment.",
    inputSchema: assistantInputs.drawGarment,
  },
  wearSaved: {
    description:
      "Wear one of the user's saved patterns (state.library: the garments drawn for them earlier, by id). A copy of it is worn; what is changed on it afterwards is saved as a variant, the saved pattern itself stays as it was.",
    inputSchema: assistantInputs.wearSaved,
  },
  removePieces: {
    description:
      "Take pieces off the garment worn, with their seams: a hood (its two halves), the sleeves (both), a panel. Instant, and nothing else changes. `pieces`: their ids as listed in the state (garment.pieces). A garment of the catalogue becomes a drawn pattern doing so (it has no settings any more, only its drawing).",
    inputSchema: assistantInputs.removePieces,
  },
  reshapeGarment: {
    description:
      "Change the shape of the garment worn and keep the rest as it is: longer or shorter sleeves or hem, a wider or closer cut, a deeper neckline, a more pointed hood, a piece added (a hood, sleeves). A pattern maker model redraws the current pattern with the change (30 to 90 seconds). `change`: what to change, in the user's words. Not for what a setting of a catalogue garment already does (setGarment), nor for only removing pieces (removePieces). The garment becomes a drawn pattern.",
    inputSchema: assistantInputs.reshapeGarment,
  },
  addClasp: {
    description:
      "Put a clasp on the garment worn: two points fastened together once it is on, each told by a piece, one of its edges and how far along it (t: 0 at the edge's `from` end, 1 at its `to` end, as listed in the state's garment.pieces). A cape open down the front is closed at the neck by a clasp between the two front pieces, at the ends of their neck edges nearest the centre front (x nearest 0) — without it, it slides off the shoulders.",
    inputSchema: assistantInputs.addClasp,
  },
  addBelt: {
    description: `Put a belt (an elastic or a waistband) along a free edge of the garment worn — one that is not sewn — and on round the garment: a skirt's waist, a hem, the end of a sleeve. Told by one piece and one of the edges it runs along. stretch: 0 a rigid waistband (default), negative gathers the cloth (-0.2: 20 % shorter), positive lets it give; ${BELT_STRETCH.min} to ${BELT_STRETCH.max}. It replaces a belt already on that edge.`,
    inputSchema: assistantInputs.addBelt,
  },
  removeAccessories: {
    description: "Take off every clasp and/or every belt of the garment worn.",
    inputSchema: assistantInputs.removeAccessories,
  },
  setView: {
    description: "The 3D view: camera (face, profil, dos, buste), what is shown on the garment (tissu: the fabric; tension: where it is tight; stretch: how much it is stretched), and whether the mannequin turns by itself.",
    inputSchema: assistantInputs.setView,
  },
};

/** What the page tells the model of where the workshop stands, with every message. */
export interface AssistantState {
  morphology: { gender: "homme" | "femme"; statureCm: number; ageYears: number; weight: number; muscle: number; cupsize: number; firmness: number; details: Record<string, number> };
  /** As measured on the mannequin (cm); missing while it is being measured. */
  measures: { stature: number; bust: number; waist: number; hips: number } | null;
  pinnedGirths: { bust?: number; waist?: number; hips?: number };
  pose: { posture: string; walking: boolean; cadence: number };
  textile: { id: string; name: string; weight: number; thickness: number; bending: number; warp: number; weft: number; friction: number; color: string; secondaryColor?: string };
  /**
   * `params`: its settings, when it is of the catalogue. `pieces`: what it is made of, each with
   * its edges — sewn or free, and where they start and end on the pattern (cm). The accessories on it.
   */
  garment: {
    id: string;
    name: string;
    params: Record<string, number>;
    pieces: { id: string; name: string; edges: { id: string; sewn: boolean; from: [number, number]; to: [number, number] }[] }[];
    clasps: { a: string; b: string }[];
    belts: { edge: string; stretch: number }[];
  };
  /** The user's saved patterns (the garments drawn for them earlier), the latest first. */
  library: { id: string; name: string; note: string; worn?: boolean }[];
  /** Whether the garment is still being sewn and draped. */
  draping: boolean;
}

/** How much of what the page sends the route reads (characters of JSON): a state, not a text. */
export const STATE_MAX = 12000;

/** What the model is told: who it is, what the workshop has, where it stands. */
export function assistantPrompt(state: unknown): string {
  const garments = GARMENTS.map(
    (g) => `- ${g.id}: ${g.name} (${g.cut}) — ${g.description} Settings: ${g.params.map((p) => `${p.key} (${p.label}, ${p.min}–${p.max}${p.auto ? ", 0 = automatic" : ""})`).join("; ")}.`,
  ).join("\n");
  const textiles = TEXTILES.map((t) => `- ${t.id}: ${t.name} — ${t.family}, ${t.weight} g/m², ${t.drape}${t.secondary ? `, second colour: ${t.secondary.label}` : ""}.`).join("\n");
  return `You are the assistant of "Couture", a 3D sewing workshop in the browser: a parametric mannequin, a garment drafted on its measurements, sewn and draped by a cloth simulation, in a textile of the library. The user talks to you in a panel beside the 3D view; you set the workshop's controls for them with your tools, and answer their questions about what they see.

How to work:
- Answer in the user's language (French by default), in one or two short sentences, without lists or headings. Say what you did, with the numbers.
- Nothing changes in the workshop unless you call a tool: your words alone set nothing. When the user asks for a change, your reply IS the tool calls — several at once if needed — with no text before them; you confirm in words only after their results have come back. Never write that something was changed, set or done unless its tool result is in the conversation.
- Do not ask for permission, and only ask a question when the request cannot be acted on.
- "Bigger", "thinner", "more muscular" are relative to the current state below: change the values by a visible step (stature by what they say or 5 cm, weight or muscle by 0.15 to 0.25).
- Only claim what a tool result confirms. If a tool reports an error or a limit reached, say so plainly.
- Reuse before drawing. When the user asks for a garment, first look at the catalogue below and at their saved patterns (state.library). If one of them is exactly the garment asked, wear it (setGarment, wearSaved) and set what its settings allow. If one is the same kind of garment and only differs by a length, a fit, a neckline, a detail, a piece, it is not drawn again from nothing: drawGarment with its id as "startFrom" adjusts it. Say which model you started from. A garment is drawn from nothing (startFrom null) only when nothing of its kind exists. A request that goes on with the garment worn ("longer", "take the hood off") changes it as it is; a request for another garment that happens to be close to a saved pattern starts from a copy of it — call wearSaved first, even when that pattern is the one worn (state.library, "worn"): the saved one is kept, and what you make of the copy is saved as a variant.
- To change the garment being worn — "remove the hood", "longer sleeves", "make it flared" — act on it as it is: a setting if it is of the catalogue and has one for that, else removePieces or reshapeGarment. Do not draw a new garment (drawGarment) when the user is talking about the one they wear: their work on it would be lost.
- Accessories: you put clasps and belts on with addClasp and addBelt, reading the pieces and edges of the garment worn in the state below, and take them off with removeAccessories.
- What you cannot set: a single point of the pattern or a seam by hand (the 2D pattern editor does that), trousers (the mannequin's garments cover the trunk, the arms, the head and, as one tube, the legs). Say so rather than pretend.
- Never mention tool names, ids or JSON to the user.

Garments of the catalogue (id: name (cut) — description, settings in cm):
${garments}
- any other garment: drawGarment.

Textiles (id: name — family, weight, drape):
${textiles}
- ${CUSTOM_TEXTILE}: the user's own textile, set with setCustomTextile.
Colours of the palette: ${PALETTE.map((p) => `${p.name} ${p.hex}`).join(", ")} — any #rrggbb works.

Current state of the workshop:
${JSON.stringify(state).slice(0, STATE_MAX)}`;
}

const cm = (v: number) => `${Math.round(v * 10) / 10} cm`;
const POSTURES: Record<string, string> = { standing: "debout", sitting: "assis", squatting: "accroupi" };
const VIEWS: Record<string, string> = { face: "de face", profil: "de profil", dos: "de dos", buste: "buste" };
const DISPLAYS: Record<string, string> = { tissu: "tissu", tension: "carte de tension", stretch: "carte d'étirement" };

/** A colour as the conversation tells it: by its name in the palette, when it has one. */
const colour = (hex: string) => PALETTE.find((p) => p.hex.toLowerCase() === hex.toLowerCase())?.name.toLowerCase() ?? hex;
/** A garment setting by its label on the panel (the same key has the same label on every garment that has it). */
const setting = (key: string, value: number) => {
  const spec = GARMENTS.flatMap((g) => g.params).find((s) => s.key === key);
  return spec ? `${spec.label.toLowerCase()} ${spec.auto && value <= 0 ? "automatique" : `${Math.round(value * 10) / 10} ${spec.unit ?? "cm"}`}` : `${key} ${value}`;
};

/** A tool call as the conversation shows it: a few words, in French — with what it did (`output`), once done, where that says it better. */
export function callLabel(tool: string, input: unknown, output?: unknown): string {
  const read = <T extends AssistantTool>(name: T) => assistantInputs[name].safeParse(input).data as AssistantInput<T> | undefined;
  const list = (parts: (string | false | undefined)[], fallback: string) => parts.filter(Boolean).join(", ") || fallback;
  switch (tool as AssistantTool) {
    case "setMorphology": {
      const i = read("setMorphology");
      return list(
        [
          i?.gender,
          i?.statureCm !== undefined && `stature ${cm(i.statureCm)}`,
          i?.ageYears !== undefined && `${Math.round(i.ageYears)} ans`,
          i?.weight !== undefined && `corpulence ${Math.round(i.weight * 100)} %`,
          i?.muscle !== undefined && `musculature ${Math.round(i.muscle * 100)} %`,
          i?.cupsize !== undefined && `poitrine ${Math.round(i.cupsize * 100)} %`,
          i?.firmness !== undefined && `fermeté ${Math.round(i.firmness * 100)} %`,
        ],
        "Morphologie",
      );
    }
    case "setGirths": {
      const i = read("setGirths");
      const one = (label: string, v: number | null | undefined) => v !== undefined && (v === null ? `${label} libéré` : `${label} ${cm(v)}`);
      return list([one("tour de poitrine", i?.bust), one("tour de taille", i?.waist), one("tour de hanches", i?.hips)], "Tours");
    }
    case "setBodyDetails":
      return list(read("setBodyDetails")?.changes.map((c) => `${LOCAL_CHANGE_LABELS[c.key]?.toLowerCase() ?? c.key} ${c.value > 0 ? "+" : ""}${Math.round(c.value * 100)} %`) ?? [], "Ajustements du corps");
    case "setPose": {
      const i = read("setPose");
      return list([i?.posture && POSTURES[i.posture], i?.walking !== undefined && (i.walking ? "en marche" : "à l'arrêt"), i?.cadence !== undefined && `${Math.round(i.cadence)} pas/min`], "Pose");
    }
    case "setTextile": {
      const i = read("setTextile");
      const name = i?.id === CUSTOM_TEXTILE ? "tissu sur mesure" : TEXTILES.find((t) => t.id === i?.id)?.name.toLowerCase();
      return list([name, i?.color && `couleur ${colour(i.color)}`, i?.secondaryColor && `seconde couleur ${colour(i.secondaryColor)}`], "Tissu");
    }
    case "setCustomTextile": {
      const i = read("setCustomTextile");
      return `tissu sur mesure${i?.weight !== undefined ? `, ${Math.round(i.weight)} g/m²` : ""}${i?.bending !== undefined ? `, rigidité ${i.bending} µN·m` : ""}`;
    }
    case "setGarment": {
      const i = read("setGarment");
      const def = GARMENTS.find((g) => g.id === i?.id);
      return list([def && `${def.name.toLowerCase()} (${def.cut})`, ...(i?.params ?? []).map((p) => setting(p.key, p.value))], "Vêtement");
    }
    case "drawGarment": {
      const i = read("drawGarment");
      const from = typeof (output as { startedFrom?: unknown } | undefined)?.startedFrom === "string" ? (output as { startedFrom: string }).startedFrom : null;
      return `${from ? `d'après « ${from} »` : "dessin"} : ${i?.description ?? "…"}`;
    }
    case "wearSaved":
      return `patron de la bibliothèque${typeof (output as { name?: unknown } | undefined)?.name === "string" ? ` : ${(output as { name: string }).name}` : ""}`;
    case "removePieces": {
      // The pieces by their names, once known: the model tells them by their ids.
      const removed = (output as { removed?: unknown } | undefined)?.removed;
      const names = Array.isArray(removed) ? [...new Set(removed.map((n) => String(n).replace(/ \d+$/, "").toLowerCase()))] : read("removePieces")?.pieces;
      return `pièces retirées : ${names?.join(", ") ?? "…"}`;
    }
    case "reshapeGarment":
      return `retouche : ${read("reshapeGarment")?.change ?? "…"}`;
    case "addClasp": {
      const i = read("addClasp");
      return i ? `fermoir entre ${i.a.piece} (${i.a.edge}) et ${i.b.piece} (${i.b.edge})` : "Fermoir";
    }
    case "addBelt": {
      const i = read("addBelt");
      const s = i?.stretch ?? 0;
      return i ? `ceinture sur ${i.piece} (${i.edge})${s < 0 ? `, froncée de ${Math.round(-s * 100)} %` : s > 0 ? `, élastique de ${Math.round(s * 100)} %` : ", rigide"}` : "Ceinture";
    }
    case "removeAccessories": {
      const i = read("removeAccessories");
      return list([i?.clasps && "fermoirs retirés", i?.belts && "ceintures retirées"], "Accessoires");
    }
    case "setView": {
      const i = read("setView");
      return list([i?.view && `vue ${VIEWS[i.view]}`, i?.display && DISPLAYS[i.display], i?.autoRotate !== undefined && (i.autoRotate ? "rotation" : "rotation arrêtée")], "Vue");
    }
    default:
      return tool;
  }
}
