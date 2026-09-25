"use client";

/**
 * GEM Customer Chatbot — main page (clean chat-only UI).
 *
 * Single full-screen chat window:
 *   • Phase 1: LeadCaptureGraph (LG1) collects name → email → phone → company
 *   • Phase 2: ChatGraph (LG2) answers questions via brain + GLM-5.1 reducer
 *
 * Streaming chunks from the brain are NOT shown to the user — they're
 * accumulated internally and replaced by the final refined answer
 * when the `done` event arrives. This gives a clean experience: the
 * user sees a "Thinking…" indicator while the brain + reducer work,
 * then the final answer appears all at once.
 *
 * Only chat-phase Q&A turns are sent as history to the brain, so the
 * brain can correctly answer questions like "what was my first
 * question?" without being confused by the capture-phase exchanges.
 */

import { useEffect, useRef, useState } from "react";
import {
  INITIAL_STATE,
  type CaptureState,
  type Lead,
} from "@/lib/lead-capture";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send } from "lucide-react";

type Role = "user" | "assistant";
type Source = "rag" | "llm" | "fallback" | "unknown";

interface Message {
  role: Role;
  content: string;
  source?: Source;
  isFallback?: boolean;
  /** True for chat-phase Q&A turns (included in brain history). */
  isChatTurn?: boolean;
}

const INACTIVITY_FOLLOWUP_MS = 120_000;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>(INITIAL_STATE);
  const [lead, setLead] = useState<Lead | null>(null);
  const [contactStatus, setContactStatus] = useState<
    "saving" | "saved" | "failed" | null
  >(null);
  const [business, setBusiness] = useState<{
    phone: string;
    email: string;
  } | null>(null);

  // Internal accumulator for brain chunks — NOT rendered directly.
  // The user only sees the final refined answer after the `done` event.
  const chunksRef = useRef<string>("");

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

    const userMsg: Message = {
      role: "user",
      content: text,
      isChatTurn: captureState.status === "complete",
    };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setStreaming(true);
    chunksRef.current = "";
    cancelInactivityFollowup();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Only send chat-phase Q&A turns as history to the brain.
    // Capture-phase exchanges (greeting, name, email, phone, company)
    // are excluded so the brain isn't confused about what the user's
    // "first question" was.
    const history = messages
      .filter((m) => m.isChatTurn)
      .map((m) => ({
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
          device: detectDevice(),
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
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "", isChatTurn: captureState.status === "complete" },
        ]);
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
      // Show the error as an assistant message so the user sees it
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `⚠️ ${(err as Error).message}`,
          source: "fallback",
          isFallback: true,
        },
      ]);
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
        // Debug logs are hidden in the UI
        break;

      case "bot":
        // Capture-phase bot messages — show immediately
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
        } else {
          setContactStatus("failed");
        }
        break;

      case "remarks-saved":
        // Hidden in the clean UI
        break;

      case "source":
      case "citations":
      case "diagnostics":
        // Hidden in the clean UI — the user only sees the final answer
        break;

      case "chunk":
        // ── Fix #3: Do NOT render streaming chunks to the user. ──
        // Accumulate internally; the placeholder bubble stays empty
        // (showing "…") until the final `done` event arrives with the
        // refined answer.
        ensureAssistantPlaceholder();
        chunksRef.current += data.text;
        break;

      case "reducer":
        // Hidden in the clean UI
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
        // ── The ONLY time the chat-phase answer becomes visible. ──
        // Replace the placeholder with the final refined answer.
        setMessages((m) =>
          m.map((msg, i) =>
            i === m.length - 1
              ? {
                  ...msg,
                  content: data.answer ?? "",
                  source: (data.source ?? "unknown") as Source,
                  isFallback: !!data.isFallback,
                  isChatTurn: !data.isFallback, // mark as a real Q&A turn for history
                }
              : msg,
          ),
        );
        if (!data.isFallback) {
          startInactivityFollowup();
        }
        break;

      case "contact-updated":
        if (data.field === "company") {
          setLead((prev) =>
            prev ? { ...prev, company: data.value as string } : prev,
          );
        }
        break;

      case "trace":
        // Trace panel removed from the clean UI
        break;

      case "error":
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: `⚠️ ${data.message}`,
            source: "fallback",
            isFallback: true,
          },
        ]);
        break;
    }
  }

  const isCapturePhase = captureState.status === "capturing";

  function reset() {
    setMessages([]);
    setCaptureState(INITIAL_STATE);
    setLead(null);
    setContactStatus(null);
    chunksRef.current = "";
    cancelInactivityFollowup();
    setTimeout(() => {
      setMessages([{ role: "assistant", content: INITIAL_STATE.prompt! }]);
    }, 0);
  }

  return (
    <main
      className="flex flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50"
      style={{
        // dvh = dynamic viewport height — adjusts to browser chrome
        // (address bar, toolbar). Falls back through svh → 100vh so
        // older browsers still get a full-height layout. This is the
        // fix for the input box being pushed below the fold on first
        // load — 100vh alone includes the address bar on mobile and
        // some desktop configs, so the input ended up off-screen.
        height: "100dvh",
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
        {/* ─── Minimal header ─── */}
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <h1 className="text-base font-semibold">GEM Customer Chatbot</h1>
            {lead && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {lead.name}
                {lead.email && ` · ${lead.email}`}
                {contactStatus === "saving" && " · saving…"}
                {contactStatus === "saved" && " · saved"}
              </p>
            )}
            {!lead && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {isCapturePhase
                  ? `Lead capture · ${captureState.current}`
                  : "Ask me anything"}
              </p>
            )}
          </div>
          <button
            onClick={reset}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          >
            Reset
          </button>
        </header>

        {/* ─── Messages ─── */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin" }}
        >
          <div className="space-y-4 p-4">
            {messages.map((msg, i) => (
              <Bubble key={i} msg={msg} streaming={streaming} />
            ))}
            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2 text-sm text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                  {isCapturePhase ? "…" : "Thinking…"}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ─── Input ─── */}
        <div className="shrink-0 border-t border-zinc-200 p-4 dark:border-zinc-800">
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
      </div>
    </main>
  );
}

function Bubble({
  msg,
  streaming,
}: {
  msg: Message;
  streaming: boolean;
}) {
  const isUser = msg.role === "user";
  const isFallback = !!msg.isFallback;

  // Hide the placeholder assistant bubble if it's empty and we're still
  // streaming (the "Thinking…" indicator handles that case instead).
  if (
    !isUser &&
    msg.content === "" &&
    streaming &&
    !msg.isFallback
  ) {
    return null;
  }

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
        <div className="whitespace-pre-wrap break-words text-sm">
          {msg.content || "…"}
        </div>
      </div>
    </div>
  );
}

/**
 * Detect the device type + OS from the browser's userAgent + screen size.
 * Returns a compact string like "desktop/macOS", "mobile/iOS", or
 * "tablet/Android". Used in the remarks header so the team can see at
 * a glance what device the lead was on.
 */
function detectDevice(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const isMobile = /Mobi|Android|iPhone/i.test(ua);
  const isTablet = /iPad|Tablet|Silk/i.test(ua) ||
    (/Android/i.test(ua) && !/Mobi/i.test(ua));
  let os = "unknown";
  if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/Linux/i.test(ua)) os = "Linux";
  const kind = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  return `${kind}/${os}`;
}
