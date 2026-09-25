/**
 * POST /api/chat — single SSE endpoint that dispatches to either
 * LeadCaptureGraph (LG1) or ChatGraph (LG2) based on captureState.status.
 *
 * Phase 1 (captureState.status != "complete") → LeadCaptureGraph
 *   validate_input → update_partial → complete_lead → generate_bot_message
 *                  ↘ handle_retry  ↗
 *
 * Phase 2 (captureState.status == "complete") → ChatGraph
 *   call_brain → refine_answer → decide_verdict
 *     → emit_good   → persist_turn → detect_late_company → END
 *     → emit_fallback ↗
 *
 * Response: text/event-stream. Events:
 *   capture, contact-saved, chat, bot, source, citations, diagnostics,
 *   chunk, reducer, fallback, done, remarks-saved, contact-updated,
 *   log, trace, error
 *
 * The `trace` event fires at the end and carries the full LangGraph
 * execution trace (nodes + tools + timings) for the UI's debug panel.
 */
import { runLeadCaptureGraph } from "@/lib/graphs/lead-capture-graph";
import { runChatGraph } from "@/lib/graphs/chat-graph";
import {
  INITIAL_STATE,
  type CaptureState,
  type Lead,
} from "@/lib/lead-capture";

export const runtime = "nodejs";
export const maxDuration = 150;

interface ChatRequest {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  captureState?: CaptureState;
  lead?: Lead;
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const message: string =
    typeof body?.message === "string" ? body.message.trim() : "";
  if (!message)
    return Response.json({ error: "message is required" }, { status: 400 });
  if (message.length > 2000)
    return Response.json(
      { error: "message too long (max 2000 chars)" },
      { status: 400 },
    );

  const captureState: CaptureState = body.captureState ?? INITIAL_STATE;
  const lead = body.lead;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      function emit(type: string, payload: object) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`),
          );
        } catch {
          closed = true;
        }
      }
      function close() {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      try {
        if (captureState.status !== "complete") {
          // ── Phase 1: LeadCaptureGraph ──
          emit("log", { line: `[graph] invoke LeadCaptureGraph` });
          const result = await runLeadCaptureGraph({
            captureState,
            userMessage: message,
            emit,
          });

          // If lead was completed, fire-and-forget the initial contact save
          // (mirrors the source repo behavior).
          if (result.completedLead) {
            emit("log", { line: `[graph] lead complete — saving contact` });
            const { saveContactWithConversation } = await import("@/lib/contacts");
            const initialTranscript = [
              {
                role: "assistant" as const,
                content: "Lead captured via GEM chatbot.",
              },
              {
                role: "user" as const,
                content: `name=${result.completedLead.name}; email=${result.completedLead.email}; phone=${result.completedLead.phone}; company=${result.completedLead.company ?? "(none)"}`,
              },
            ];
            saveContactWithConversation(result.completedLead, initialTranscript)
              .then((r) => emit("contact-saved", r))
              .catch((err) =>
                emit("log", { line: `[contact] save failed: ${err.message}` }),
              );
          }

          emit("trace", { trace: result.trace });
        } else {
          // ── Phase 2: ChatGraph ──
          emit("log", { line: `[graph] invoke ChatGraph` });
          const result = await runChatGraph({
            query: message,
            history: (body.history ?? []).map((h) => ({
              role: h.role as "user" | "assistant" | "system",
              content: h.content,
            })),
            lead: lead ?? undefined,
            emit,
          });
          emit("trace", { trace: result.trace });
        }
        close();
      } catch (err) {
        emit("error", { message: (err as Error).message });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
