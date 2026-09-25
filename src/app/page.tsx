"use client";

/**
 * GEM Customer Chatbot — main page.
 *
 * Two-pane layout:
 *   • Left  — Chat panel (LeadCaptureGraph → ChatGraph via /api/chat)
 *   • Right — LangGraph execution trace (live nodes + tools)
 *
 * The chat panel runs through the lead-capture conversation first
 * (name → email → phone → company), then hands off to the chat-brain
 * + GLM-5.1 reducer for real Q&A. Every turn's graph trace is sent
 * back via the `trace` SSE event and rendered on the right.
 */

import { useEffect, useRef, useState } from "react";
import {
  INITIAL_STATE,
  type CaptureState,
  type Lead,
} from "@/lib/lead-capture";
import type { GraphTrace } from "@/lib/graphs/types";
import { TracePanel } from "@/components/chat/trace-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Send,
  RotateCcw,
  PanelRightClose,
  PanelRightOpen,
  Phone,
} from "lucide-react";

type Role = "user" | "assistant";
type Source = "rag" | "llm" | "fallback" | "unknown";

interface Message {
  role: Role;
  content: string;
  source?: Source;
  citations?: Array<{ id: string; title?: string; score: number }>;
  isFallback?: boolean;
  elapsedMs?: number;
  judgeVerdict?: "good" | "no_answer";
  judgeReason?: string;
}

const SUGGESTIONS_BY_PHASE = {
  capture: ["Jane Doe", "jane@example.com", "+91 98765 43210", "Acme Inc"],
  chat: [
    "What's your return policy?",
    "How long does shipping take?",
    "What is the meaning of life?",
    "How can I track my order?",
  ],
} as const;

const INACTIVITY_FOLLOWUP_MS = 120_000;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [captureState, setCaptureState] = useState<CaptureState>(INITIAL_STATE);
  const [lead, setLead] = useState<Lead | null>(null);
  const [contactStatus, setContactStatus] = useState<
    "saving" | "saved" | "failed" | null
  >(null);
  const [business, setBusiness] = useState<{
    phone: string;
    email: string;
  } | null>(null);
  const [trace, setTrace] = useState<GraphTrace | null>(null);
  const [showTrace, setShowTrace] = useState(true);

  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load non-secret business contact on mount
  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => setBusiness(data.business))
      .catch(() => {
        /* silent — fallback will use empty phone/email */
      });
  }, []);

  // Seed the initial greeting on first mount
  useEffect(() => {
    if (
      messages.length === 0 &&
      captureState.status === "capturing" &&
      captureState.prompt
    ) {
      setMessages([{ role: "assistant", content: captureState.prompt }]);
    }
  }, []);

  // Auto-scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streaming]);

  function cancelInactivityFollowup() {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }

  function startInactivityFollowup() {
    cancelInactivityFollowup();
    inactivityTimerRef.current = setTimeout(() => {
      const phone = business?.phone ?? "";
      const email = business?.email ?? "";
      const contactBlock =
        (phone ? `📞 Phone: ${phone}\n` : "") +
        (email ? `📧 Email: ${email}` : "");
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            phone || email
              ? `Still need help with that? No worries — for more in-depth assistance, reach our team directly:\n\n${contactBlock}`
              : `Still need help with that? Please contact our team for more in-depth assistance.`,
          source: "fallback",
          isFallback: true,
        },
      ]);
      inactivityTimerRef.current = null;
    }, INACTIVITY_FOLLOWUP_MS);
  }

  useEffect(() => {
    return () => cancelInactivityFollowup();
  }, []);

  async function send(text: string) {
    if (!text.trim() || streaming) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setStreaming(true);
    setStatus(captureState.status === "capturing" ? "…" : "Thinking…");
    setTrace(null);
    cancelInactivityFollowup();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const history = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          captureState,
          lead: lead ?? undefined,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let placeholderAdded = false;

      const ensureAssistantPlaceholder = () => {
        if (placeholderAdded) return;
        setMessages((m) => [...m, { role: "assistant", content: "" }]);
        placeholderAdded = true;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const evt = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            handleEvent(JSON.parse(payload), ensureAssistantPlaceholder);
          } catch {
            /* partial */
          }
        }
      }
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleEvent(
    data: any,
    ensureAssistantPlaceholder: () => void,
  ) {
    switch (data.type) {
      case "log":
        // Debug logs are hidden in the UI; they appear in the trace panel summaries
        break;

      case "bot":
        ensureAssistantPlaceholder();
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1 && msg.role === "assistant"
              ? { ...msg, content: msg.content + data.text }
              : msg,
          ),
        );
        break;

      case "capture":
        setCaptureState((prev) => ({
          status: data.status ?? prev.status,
          current: data.current ?? prev.current,
          partial: { ...prev.partial, ...(data.partial ?? {}) },
          retrying: data.retrying,
          prompt: data.status === "complete" ? undefined : prev.prompt,
        }));
        if (data.status === "complete" && data.lead) {
          const newLead: Lead = {
            name: data.lead.name,
            email: data.lead.email,
            phone: data.lead.phone,
            company: data.lead.company,
            capturedAt: Date.now(),
          };
          setLead(newLead);
          setContactStatus("saving");
        }
        break;

      case "contact-saved":
        if (data.ok) {
          setContactStatus("saved");
          setStatus(
            data.action === "created"
              ? "Contact created ✓"
              : data.action === "updated"
                ? "Contact updated ✓"
                : "Contact saved ✓",
          );
        } else {
          setContactStatus("failed");
          setStatus(
            `Contact save failed: ${data.error ?? data.reason ?? "unknown"}`,
          );
        }
        break;

      case "remarks-saved":
        if (data.ok) {
          setStatus((s) => `${s.replace(/ · updated.*$/i, "")} · updated ✓`);
        }
        break;

      case "source":
        setStatus(
          data.source === "rag"
            ? "Searching knowledge base…"
            : data.source === "llm"
              ? "Thinking…"
              : data.source === "fallback"
                ? "Handing off…"
                : `Source: ${data.source}`,
        );
        break;

      case "citations":
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1 ? { ...msg, citations: data.citations } : msg,
          ),
        );
        break;

      case "chunk":
        ensureAssistantPlaceholder();
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1
              ? { ...msg, content: msg.content + data.text }
              : msg,
          ),
        );
        setStatus("Streaming…");
        break;

      case "reducer":
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1
              ? {
                  ...msg,
                  judgeVerdict: data.verdict,
                  judgeReason: data.reason,
                }
              : msg,
          ),
        );
        setStatus(data.verdict === "good" ? "✓ Ready" : "Handing off…");
        break;

      case "fallback":
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1
              ? { ...msg, isFallback: true, source: "fallback" }
              : msg,
          ),
        );
        break;

      case "done":
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1
              ? {
                  ...msg,
                  content: data.answer ?? "",
                  source: (data.source ?? "unknown") as Source,
                  elapsedMs: data.elapsedMs,
                  isFallback: !!data.isFallback,
                }
              : msg,
          ),
        );
        setStatus(data.isFallback ? "Connected to our team" : "Done");
        if (!data.isFallback) {
          startInactivityFollowup();
        }
        break;

      case "contact-updated":
        setStatus((s) =>
          `${s.replace(/ · updated.*$/i, "")} · ${data.field} updated ✓`,
        );
        if (data.field === "company") {
          setLead((prev) =>
            prev ? { ...prev, company: data.value as string } : prev,
          );
        }
        break;

      case "trace":
        setTrace(data.trace as GraphTrace);
        break;

      case "error":
        setStatus(`Error: ${data.message}`);
        break;
    }
  }

  const isCapturePhase = captureState.status === "capturing";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastIsFallback = !!lastAssistant?.isFallback;
  const showSuggestions = !isCapturePhase && !lastIsFallback;
  const suggestions = isCapturePhase
    ? SUGGESTIONS_BY_PHASE.capture
    : SUGGESTIONS_BY_PHASE.chat;

  function reset() {
    setMessages([]);
    setCaptureState(INITIAL_STATE);
    setLead(null);
    setContactStatus(null);
    setStatus("");
    setTrace(null);
    cancelInactivityFollowup();
    // Re-seed the initial greeting
    setTimeout(() => {
      setMessages([{ role: "assistant", content: INITIAL_STATE.prompt! }]);
    }, 0);
  }

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-b from-zinc-50 to-zinc-100 text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-50">
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">GEM Customer Chatbot</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              LangGraph live conversion · LG1 capture → LG2 chat brain + GLM-5.1
              reducer
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTrace((v) => !v)}
              className="gap-1.5 text-xs"
            >
              {showTrace ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
              {showTrace ? "Hide trace" : "Show trace"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              className="gap-1.5 text-xs"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-4 px-4 py-4">
        {/* ─── Chat panel ─── */}
        <section
          className={
            "flex flex-col rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 " +
            (showTrace ? "flex-1" : "flex-1")
          }
        >
          {/* Status bar */}
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {isCapturePhase ? (
                <>
                  <Badge
                    variant="outline"
                    className="mr-2 border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300"
                  >
                    LG1 · LeadCaptureGraph
                  </Badge>
                  collecting:{" "}
                  <code className="text-[10px]">{captureState.current}</code>
                </>
              ) : (
                <>
                  <Badge
                    variant="outline"
                    className="mr-2 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                  >
                    LG2 · ChatGraph
                  </Badge>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {lead?.name ?? "Chat"}
                  </span>
                  {lead?.email && (
                    <span className="ml-2 text-zinc-400">· {lead.email}</span>
                  )}
                  {contactStatus === "saving" && (
                    <span className="ml-2 text-amber-600">
                      · saving contact…
                    </span>
                  )}
                  {contactStatus === "saved" && (
                    <span className="ml-2 text-green-600">
                      · contact saved ✓
                    </span>
                  )}
                  {contactStatus === "failed" && (
                    <span className="ml-2 text-red-500">· save failed</span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin" }}
          >
            <div className="space-y-4 p-4">
              {messages.map((msg, i) => (
                <Bubble key={i} msg={msg} />
              ))}
            </div>
          </div>

          {/* Status line */}
          {status && (
            <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              {status}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            {showSuggestions && (
              <div className="mb-2 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={streaming}
                    className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {!showSuggestions && (
              <div className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                Or type your question below to keep chatting.
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder={
                  isCapturePhase ? "Type your reply…" : "Ask a question…"
                }
                disabled={streaming}
                className="flex-1"
              />
              <Button
                onClick={() => send(input)}
                disabled={!input.trim() || streaming}
                size="icon"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>

        {/* ─── Trace panel ─── */}
        {showTrace && (
          <aside className="hidden w-[380px] shrink-0 md:block">
            <TracePanel trace={trace} isStreaming={streaming} />
          </aside>
        )}
      </div>

      {/* Mobile trace panel — shown below chat on small screens */}
      {showTrace && (
        <aside className="border-t border-zinc-200 px-4 pb-4 dark:border-zinc-800 md:hidden">
          <div className="h-64">
            <TracePanel trace={trace} isStreaming={streaming} />
          </div>
        </aside>
      )}

      <footer className="mt-auto border-t border-zinc-200 bg-white/50 px-4 py-2 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-500">
        LeadCaptureGraph (LG1) · ChatGraph (LG2) · No HITL · No checkpointer ·
        No time-travel
      </footer>
    </main>
  );
}

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const isFallback = !!msg.isFallback;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          "max-w-[85%] rounded-2xl px-4 py-2 " +
          (isUser
            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
            : isFallback
              ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800"
              : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50")
        }
      >
        {!isUser && (
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-60">
            {msg.source === "fallback" ? (
              <>
                <Phone className="h-3 w-3" /> Handoff to team
              </>
            ) : msg.source === "rag" ? (
              "📚 Knowledge base"
            ) : msg.source === "llm" ? (
              "💬 Language model"
            ) : (
              "Assistant"
            )}
            {msg.elapsedMs != null && ` · ${(msg.elapsedMs / 1000).toFixed(1)}s`}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-sm">
          {msg.content || "…"}
        </div>
        {msg.citations && msg.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 border-t border-zinc-300 pt-2 dark:border-zinc-600">
            {msg.citations.map((c, i) => (
              <span
                key={i}
                className="rounded bg-white/30 px-2 py-0.5 text-[10px] dark:bg-zinc-700"
                title={`Score: ${c.score.toFixed(3)}`}
              >
                [{i + 1}] {c.title || c.id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
