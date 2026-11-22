import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { assistantPrompt, assistantTools, STATE_MAX } from "@/lib/assistant/tools";

/**
 * The workshop's assistant (lib/assistant/tools.ts): the conversation and the workshop's state
 * come in, the model's answer goes out as a stream — text, and calls to tools the page runs
 * itself. Through the Vercel AI Gateway, like the drawing of patterns (app/api/pattern), and on
 * the same budget; ASSISTANT_MODEL names another model of the gateway.
 */
const MODEL = process.env.ASSISTANT_MODEL ?? "google/gemini-2.5-flash";
/** Messages of the conversation the model is given: the page sends the latest (useAssistant.ts), and no more are read. */
const MESSAGES_MAX = 40;

export const maxDuration = 60;

/** The HTTP status the gateway answered with, when the error (or the one it wraps) carries one. */
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
  const { messages, state } = (body ?? {}) as { messages?: unknown; state?: unknown };
  if (!Array.isArray(messages) || !messages.length || messages.length > MESSAGES_MAX || !state || typeof state !== "object" || JSON.stringify(state).length > STATE_MAX)
    return Response.json({ error: "Demande illisible." }, { status: 400 });

  let conversation;
  try {
    conversation = await convertToModelMessages(messages as UIMessage[]);
  } catch {
    return Response.json({ error: "Conversation illisible." }, { status: 400 });
  }
  const result = streamText({
    model: MODEL,
    system: assistantPrompt(state),
    messages: conversation,
    tools: assistantTools,
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      sendReasoning: false,
      // What the page shows when the model cannot be reached (no detail of the failure leaves the server).
      onError: (error) => {
        console.error("assistant:", error);
        const status = statusOf(error);
        return status === 402 ? "budget" : status === 429 ? "busy" : "unreachable";
      },
    }),
  });
}
