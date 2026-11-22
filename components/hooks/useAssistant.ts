"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isTextUIPart, isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { assistantInputs, type AssistantInput, type AssistantState, type AssistantTool } from "@/lib/assistant/tools";

/** What each tool of the assistant does in the page: returns what was done (told to the model), or throws with why not. */
export type AssistantHandlers = { [T in AssistantTool]: (input: AssistantInput<T>) => unknown };

/** A conversation as it is kept: named after what the user first asked. */
export interface Conversation {
  id: string;
  title: string;
  /** When it was last added to (ms since the epoch). */
  updatedAt: number;
  messages: UIMessage[];
}

/**
 * The conversations are the assistant's memory, and they are kept where the user is — in this
 * browser's local storage, no account: the one under way is there again when the page is
 * opened again, and the earlier ones can be taken up from the history. `CONVERSATIONS` of them
 * are kept, the oldest forgotten first, `KEPT` messages each; the model is given the last `SENT`.
 */
const STORE = "couture.assistant.v2";
const CONVERSATIONS = 30;
const KEPT = 120;
const SENT = 30;
const TITLE = 60;

interface Archive {
  conversations: Conversation[];
  /** The conversation under way: one of them, or a new one not kept yet. */
  current: string;
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`);
/** Before the storage is read (on the server, and for the first render in the browser). */
const EMPTY: Archive = { conversations: [], current: "" };

/** The conversations kept, as a store React reads (useSyncExternalStore): read from the storage once, written back at each change. */
const archive = (() => {
  let state: Archive | null = null;
  const listeners = new Set<() => void>();
  const read = (): Archive => {
    if (state) return state;
    let kept: Conversation[] = [], current = "";
    try {
      const stored = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Archive> | null;
      if (Array.isArray(stored?.conversations))
        kept = stored.conversations.filter((c) => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.updatedAt === "number" && Array.isArray(c.messages) && c.messages.length > 0);
      if (typeof stored?.current === "string") current = stored.current;
    } catch {
      // Unreadable: no history.
    }
    return (state = { conversations: kept, current: current || newId() });
  };
  const write = (next: Archive) => {
    state = next;
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      // Storage full or refused: the conversations last as long as the page.
    }
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read,
    /** The conversation under way, as it stands: added to the history, or brought up to date in it. */
    keep(messages: UIMessage[]) {
      const { conversations, current } = read();
      // Taken up again and not added to: it stays where it is in the history.
      const was = conversations.find((c) => c.id === current);
      if (was && was.messages.length === messages.length && JSON.stringify(was.messages[was.messages.length - 1]) === JSON.stringify(messages[messages.length - 1])) return;
      const first = messages.find((m) => m.role === "user")?.parts.filter(isTextUIPart).map((p) => p.text).join(" ").trim() ?? "";
      const title = first.length > TITLE ? `${first.slice(0, TITLE - 1).trimEnd()}…` : first || "Conversation";
      const kept: Conversation = { id: current, title, updatedAt: Date.now(), messages: messages.slice(-KEPT) };
      write({ current, conversations: [kept, ...conversations.filter((c) => c.id !== current)].slice(0, CONVERSATIONS) });
    },
    /** Another conversation under way: one of the history, or (no id) a new one. */
    open(id?: string) {
      write({ ...read(), current: id ?? newId() });
    },
    forget(id: string) {
      const { conversations, current } = read();
      write({ conversations: conversations.filter((c) => c.id !== id), current: id === current ? newId() : current });
    },
  };
})();

/** Messages as they can be sent or stored: a tool call left without its result (the page was closed meanwhile) is dropped. */
function settled(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((m) => ({ ...m, parts: m.parts.filter((p) => !isToolUIPart(p) || p.state === "output-available" || p.state === "output-error") }))
    .filter((m) => m.parts.length > 0);
}

/** While a turn is under way its last message holds the calls just answered: only what came before is checked. */
function settledForRequest(messages: UIMessage[]): UIMessage[] {
  return [...settled(messages.slice(0, -1)), ...messages.slice(-1)];
}

/** The end of the conversation, from one of the user's messages on. */
function recent(messages: UIMessage[]): UIMessage[] {
  const last = messages.slice(-SENT);
  const from = last.findIndex((m) => m.role === "user");
  return from > 0 ? last.slice(from) : last;
}

/**
 * How messages leave for the model: the end of the conversation, with where the workshop stands
 * at that moment — asked of the page (there is one workshop a page) each time, the answers to
 * tool calls included, which leave on their own.
 */
const workshop: { state: (() => AssistantState) | null } = { state: null };
const transport = new DefaultChatTransport({
  api: "/api/assistant",
  prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: recent(settledForRequest(messages)), state: workshop.state?.() } }),
});

const ERRORS: Record<string, string> = {
  budget: "Le budget mensuel de l'assistant est épuisé : il revient le mois prochain.",
  busy: "Trop de demandes à la fois. Réessayez dans une minute.",
};

/**
 * Time left to the page between two tools of the same answer (ms): "wear the cape and take
 * its hood off" is two calls, and the second must find the cape worn — the page has to render
 * what the first one set before the next one reads it.
 */
const BETWEEN_TOOLS = 80;

/**
 * The workshop's assistant (lib/assistant/tools.ts) in the page: the conversation with the
 * model, whose tool calls are run here by `handlers`, one after the other, and answered with
 * what they did. `state` tells where the workshop stands; it is read when a message leaves.
 */
export function useAssistant(handlers: AssistantHandlers, state: () => AssistantState) {
  const live = useRef(handlers);
  useEffect(() => {
    live.current = handlers;
    workshop.state = state;
  });
  /** The tool calls being run, in the order they came. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const { messages, status, error, sendMessage, addToolOutput, setMessages, stop, clearError } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      const tool = toolCall.toolName as AssistantTool;
      const fail = (errorText: string) => addToolOutput({ tool, toolCallId: toolCall.toolCallId, state: "output-error", errorText });
      const input = assistantInputs[tool]?.safeParse(toolCall.input);
      if (!input?.success) return void fail("Cette demande n'a pas pu être lue.");
      // Not awaited: the chat waits for this very callback to hand it the output (AI SDK: chatbot tool usage).
      queue.current = queue.current.then(async () => {
        try {
          // The handler of now: the one that sees what the tools before it have set.
          const run = live.current[tool] as (input: unknown) => unknown;
          addToolOutput({ tool, toolCallId: toolCall.toolCallId, output: (await run(input.data)) ?? "fait" });
        } catch (e) {
          fail(e instanceof Error ? e.message : "Cela n'a pas pu être fait.");
        }
        await new Promise((resolve) => setTimeout(resolve, BETWEEN_TOOLS));
      });
    },
  });

  const { conversations, current } = useSyncExternalStore(archive.subscribe, archive.read, () => EMPTY);
  // The conversation under way is kept once a turn is over, and read back when the page opens
  // or another one is taken up. An empty one is not kept: the history holds what was said.
  const shown = useRef("");
  useEffect(() => {
    if (shown.current !== current || status !== "ready" || !messages.length) return;
    archive.keep(settled(messages));
  }, [status, messages, current]);
  useEffect(() => {
    if (!current || shown.current === current) return;
    shown.current = current;
    setMessages(settled(archive.read().conversations.find((c) => c.id === current)?.messages ?? []));
  }, [current, setMessages]);

  const last = messages[messages.length - 1];
  // A tool at work (a garment being redrawn takes a minute): the answer is not over.
  const working = last?.role === "assistant" && last.parts.some((p) => isToolUIPart(p) && p.state !== "output-available" && p.state !== "output-error");
  const busy = status === "submitted" || status === "streaming" || working;
  const take = (id?: string) => {
    void stop();
    clearError();
    archive.open(id);
  };
  return {
    messages,
    busy,
    /** A tool is being run in the page (the model is waiting for it). */
    working,
    /** Why the last message got no answer, in words for the user. */
    error: error
      ? (ERRORS[error.message] ?? "L'assistant n'a pas répondu. Réessayez dans un instant.")
      : // The model sometimes answers nothing at all: said, rather than left as a silence.
        status === "ready" && last?.role === "user"
        ? "L'assistant n'a rien répondu. Renvoyez votre message, ou dites-le autrement."
        : null,
    send: (text: string) => {
      if (!text.trim() || busy) return;
      clearError();
      void sendMessage({ text: text.trim() });
    },
    stop,
    /** The conversations kept, the latest first, and the one under way. */
    conversations,
    current,
    /** A new conversation: the one under way stays in the history. */
    clear: () => take(),
    /** A conversation of the history taken up again. */
    open: (id: string) => take(id),
    /** A conversation forgotten for good. */
    forget: (id: string) => {
      if (id === current) void stop();
      archive.forget(id);
    },
  };
}

export type Assistant = ReturnType<typeof useAssistant>;
