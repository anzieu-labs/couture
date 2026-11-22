"use client";

import { getToolName, isTextUIPart, isToolUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import { callLabel } from "@/lib/assistant/tools";
import type { Assistant } from "./hooks/useAssistant";

interface Props {
  assistant: Assistant;
  onClose: () => void;
}

/** What to ask, shown while the conversation is empty. */
const IDEAS = ["Rends-le plus grand et plus mince", "Passe-le en lin, couleur sauge", "Mets-lui une robe et fais-le marcher", "Dessine un sweat à capuche ample"];

/** When a conversation was last added to: the time today, else the day. */
function when(at: number): string {
  const date = new Date(at), now = new Date();
  const today = date.toDateString() === now.toDateString();
  return today ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
}

/**
 * The assistant's conversation (lib/assistant/tools.ts), a column kept open beside the 3D
 * view: the user's messages, the assistant's answers, and — between them — what it set in the
 * workshop, each as a line that is ticked once done. Its header opens the history: the
 * conversations kept in this browser (hooks/useAssistant.ts), to take up again or to forget.
 */
export function AssistantPanel({ assistant, onClose }: Props) {
  const { messages, busy, error } = assistant;
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, error]);

  const send = (text: string) => {
    if (busy || !text.trim()) return;
    assistant.send(text);
    setDraft("");
  };
  // Waiting for the first words of an answer (or between two steps of one).
  const last = messages[messages.length - 1];
  const waiting = busy && (last?.role !== "assistant" || !last.parts.some((p) => isTextUIPart(p) && p.state === "streaming"));

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">Assistant</h2>
          <p className="truncate text-[11px] text-muted">Règle le mannequin, le tissu et le vêtement pour vous.</p>
        </div>
        {assistant.conversations.length > 0 && (
          <button
            type="button"
            onClick={() => setBrowsing((b) => !b)}
            aria-pressed={browsing}
            title="Les conversations précédentes, gardées dans ce navigateur"
            className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-ink hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white"
          >
            Historique
          </button>
        )}
        {(messages.length > 0 || browsing) && (
          <button
            type="button"
            onClick={() => {
              assistant.clear();
              setBrowsing(false);
            }}
            title="Commencer une autre conversation : celle-ci reste dans l'historique"
            className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-ink hover:text-ink"
          >
            Nouvelle
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Replier l'assistant" title="Replier" className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-muted transition-colors hover:border-ink hover:text-ink">
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M8 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      {browsing && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <p className="px-1 pb-2 text-[11px] leading-snug text-muted">Conversations gardées dans ce navigateur, la plus récente d&apos;abord.</p>
          <ul className="space-y-1">
            {assistant.conversations.map((c) => (
              <li key={c.id} className="group flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => {
                    assistant.open(c.id);
                    setBrowsing(false);
                  }}
                  aria-current={c.id === assistant.current}
                  className="min-w-0 flex-1 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-white/70 aria-[current=true]:border-line aria-[current=true]:bg-white/80"
                >
                  <span className="block truncate text-xs font-medium">{c.title}</span>
                  <span className="block text-[10.5px] text-muted">
                    {when(c.updatedAt)} · {c.messages.filter((m) => m.role === "user").length} message{c.messages.filter((m) => m.role === "user").length > 1 ? "s" : ""}
                    {c.id === assistant.current ? " · en cours" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => assistant.forget(c.id)}
                  aria-label={`Oublier la conversation « ${c.title} »`}
                  title="Oublier cette conversation"
                  className="grid w-7 shrink-0 place-items-center rounded-lg text-muted opacity-60 transition hover:bg-white/70 hover:text-[#b2442f] hover:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {assistant.conversations.length === 0 && <p className="px-1 text-xs text-muted">Aucune conversation gardée.</p>}
        </div>
      )}

      <div className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 ${browsing ? "hidden" : ""}`} role="log" aria-live="polite" aria-label="Conversation avec l'assistant">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              Dites ce que vous voulez voir : la stature ou la corpulence du mannequin, sa pose, le tissu, le vêtement et ses réglages. Vos conversations et vos réglages sont gardés dans ce navigateur, sans compte.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {IDEAS.map((idea) => (
                <button key={idea} type="button" onClick={() => send(idea)} className="rounded-full border border-line bg-white/70 px-3 py-1.5 text-left text-xs transition-colors hover:border-ink">
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <p key={message.id} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3 py-2 text-xs leading-relaxed text-white">
              {message.parts.filter(isTextUIPart).map((p) => p.text).join("")}
            </p>
          ) : (
            <div key={message.id} className="mr-6 space-y-1.5">
              {message.parts.map((part, i) => {
                if (isTextUIPart(part))
                  return part.text.trim() ? (
                    <p key={i} className="w-fit max-w-full whitespace-pre-wrap rounded-2xl rounded-bl-md border border-line bg-white/80 px-3 py-2 text-xs leading-relaxed">
                      {part.text}
                    </p>
                  ) : null;
                if (!isToolUIPart(part)) return null;
                const failed = part.state === "output-error";
                const done = part.state === "output-available";
                return (
                  <p key={part.toolCallId} className={`flex items-start gap-1.5 pl-1 text-[11px] leading-snug ${failed ? "text-[#b2442f]" : "text-muted"}`}>
                    <span className="mt-px w-3 shrink-0 text-center" aria-hidden>
                      {failed ? "×" : done ? "✓" : "…"}
                    </span>
                    <span>
                      {callLabel(getToolName(part), part.input, done ? part.output : undefined)}
                      {failed && part.errorText ? ` — ${part.errorText}` : ""}
                    </span>
                  </p>
                );
              })}
            </div>
          ),
        )}
        {waiting && (
          <p className="pl-1 text-[11px] text-muted" role="status">
            {assistant.working ? "L'assistant travaille sur le vêtement…" : "L'assistant réfléchit…"}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-[#b2442f]/30 bg-[#b2442f]/5 px-3 py-2 text-[11px] leading-snug text-[#b2442f]" role="alert">
            {error}
          </p>
        )}
        <div ref={end} />
      </div>

      <form
        className={`border-t border-line p-3 ${browsing ? "hidden" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-white/80 p-1.5 pl-3 focus-within:border-ink">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
            rows={Math.min(5, Math.max(1, draft.split("\n").length))}
            maxLength={1000}
            placeholder="Demander un réglage…"
            aria-label="Message à l'assistant"
            className="min-h-7 flex-1 resize-none bg-transparent py-1 text-xs leading-relaxed outline-none placeholder:text-muted"
          />
          {busy ? (
            <button type="button" onClick={() => void assistant.stop()} className="shrink-0 rounded-full border border-ink px-3 py-1.5 text-[11px] font-medium transition-colors hover:bg-ink hover:text-white">
              Arrêter
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()} aria-label="Envoyer" className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-white transition-opacity hover:opacity-90 disabled:opacity-30">
              <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <path d="M10 15V5M5.5 9.5 10 5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
