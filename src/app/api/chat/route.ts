/**
 * POST /api/chat — single SSE endpoint that dispatches to either
 * LeadCaptureGraph (LG1) or ChatGraph (LG2) based on captureState.status.
 *
 * Phase 1 (captureState.status != "complete") → LeadCaptureGraph
 * Phase 2 (captureState.status == "complete") → ChatGraph
 *
 * Client context (IP + device) is resolved here:
 *   • IP — extracted from standard forwarded-for headers
 *   • device — sent by the client in the request body (detected
 *     client-side from userAgent + screen size)
 * Both are passed into the graphs so they end up in the remarks
 * header line: "[date] Conversation captured via GEM chatbot (ip: …, device: …)"
 */
import { runLeadCaptureGraph } from "@/lib/graphs/lead-capture-graph";
import { runChatGraph } from "@/lib/graphs/chat-graph";
import {
  INITIAL_STATE,
  type CaptureState,
  type Lead,
} from "@/lib/lead-capture";
import type { RemarkContext } from "@/lib/contacts";

export const runtime = "nodejs";
export const maxDuration = 150;

interface ChatRequest {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  captureState?: CaptureState;
  lead?: Lead;
  /** Client-detected device string, e.g. "desktop/macOS" or "mobile/iOS". */
  device?: string;
}

/**
 * Resolve the client's IP from standard proxy headers. On Vercel,
 * `x-forwarded-for` is set by the edge; `x-real-ip` is a fallback
 * some CDNs set. Returns the first valid IP or undefined.
 */
function resolveClientIp(req: Request): string | undefined {
  const headers = req.headers;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for is a comma-separated list; the first entry is
    // the original client IP.
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const xRealIp = headers.get("x-real-ip");
  if (xRealIp && xRealIp.trim().length > 0) return xRealIp.trim();
  return undefined;
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

  // Build the remark context: IP from headers, device from body.
  const context: RemarkContext = {
    ip: resolveClientIp(req),
    device: body.device?.trim() || undefined,
  };

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
            context,
          });

          // If lead was completed, fire-and-forget the initial contact save.
          if (result.completedLead) {
            emit("log", { line: `[graph] lead complete — saving contact` });
            const { saveContactWithConversation } = await import("@/lib/contacts");
            // Initial lead save — no Q&A yet, so use a simple outcome
            // summary instead of a transcript.
            const leadSummary = {
              outcome: "lead captured",
              fields: {
                Outcome: "lead captured",
                "Lead stage": "captured",
                Status: "awaiting first question",
              },
            };
            saveContactWithConversation(
              result.completedLead,
              [], // no transcript — summary replaces it
              context,
              leadSummary,
            )
              .then((r) => emit("contact-saved", r))
              .catch((err) =>
                emit("log", { line: `[contact] save failed: ${err.message}` }),
              );
          }

          emit("trace", { trace: result.trace });
        } else {
          // ── Phase 2: ChatGraph ──
          emit("log", { line: `[graph] invoke ChatGraph` });
          // Defensively filter the history the client sends: only keep
          // real chat-phase Q&A turns.
          const chatHistory = (body.history ?? [])
            .filter((h) => h && h.role && h.content)
            .map((h) => ({
              role: h.role as "user" | "assistant" | "system",
              content: h.content,
            }));
          const result = await runChatGraph({
            query: message,
            history: chatHistory,
            lead: lead ?? undefined,
            emit,
            context,
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
