/**
 * ChatGraph (LG2) — LangGraph conversion of the chat-brain → reducer
 * → contact-persistence flow.
 *
 * Per the sequence diagram:
 *   • Tools: brain_proxy, glm_reducer, contacts_upsert, contacts_update_field
 *   • No HITL / checkpointer / time-travel
 *
 * Nodes:
 *   call_brain → refine_answer → decide_verdict
 *     → emit_good   → persist_turn → detect_late_company → END
 *     → emit_fallback ↗
 *
 * Tools are invoked explicitly from inside nodes (no agent loop, no
 * ToolNode) — each call is recorded in the trace via `traceTool()`.
 *
 * Live SSE streaming: brain_proxy's chunks are forwarded to the
 * client immediately via the `emit` channel, so the user sees the
 * answer streaming in real time even though the graph is running.
 */

import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { callBrain, type BrainResult } from "@/lib/brain-client";
import { refineAnswer, type RefinedAnswer } from "@/lib/reducer";
import { deriveSummary, type OperationalSummary } from "@/lib/summarizer";
import {
  saveContactWithConversation,
  updateContactField,
  type ContactWriteResult,
  type RemarkContext,
  type TurnSummary,
} from "@/lib/contacts";
import { getConfig } from "@/lib/config";
import type { Lead } from "@/lib/lead-capture";
import {
  traceNode,
  traceTool,
  type GraphTrace,
  type ChatGraphInput,
  type ChatGraphOutput,
} from "./types";

// ─── State annotation ─────────────────────────────────────────

const LG2State = Annotation.Root({
  trace: Annotation<GraphTrace>,
  query: Annotation<string>,
  history: Annotation<Array<{ role: "user" | "assistant" | "system"; content: string }>>,
  lead: Annotation<Lead | undefined>,
  emit: Annotation<(type: string, payload: Record<string, unknown>) => void>,
  // Client context (IP + device) for the remarks header:
  context: Annotation<RemarkContext | undefined>,
  // Internal scratchpad:
  brainResult: Annotation<BrainResult | undefined>,
  refined: Annotation<RefinedAnswer | undefined>,
  verdict: Annotation<"good" | "no_answer">,
  // Operational summary derived by GLM-5.1 — replaces the full transcript in remarks:
  summary: Annotation<TurnSummary | undefined>,
  // Output:
  finalAnswer: Annotation<string>,
  source: Annotation<string>,
  isFallback: Annotation<boolean>,
  elapsedMs: Annotation<number>,
  contactResult: Annotation<ContactWriteResult | null>,
  lateCompanyResult: Annotation<ContactWriteResult | null>,
});

type LG2StateType = typeof LG2State.State;

// ─── Node: call_brain [tool: brain_proxy] ─────────────────────

const callBrainNode = traceNode<LG2StateType>(
  "call_brain",
  async (state) => {
    const cfg = getConfig();
    const INACTIVITY_MS = cfg.inactivityMs;

    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const armInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        state.emit("log", {
          line: `[brain] no response for ${INACTIVITY_MS / 1000}s — handing off`,
        });
      }, INACTIVITY_MS);
    };
    armInactivity();

    const [result, toolTrace] = await traceTool("brain_proxy", async () => {
      return callBrain({
        query: state.query,
        history: state.history,
        onLog: (line) => {
          armInactivity();
          if (!timedOut) state.emit("log", { line });
        },
        onSource: (source) => {
          armInactivity();
          if (!timedOut) state.emit("source", { source });
        },
        onCitations: (citations) => {
          armInactivity();
          if (!timedOut) state.emit("citations", { citations });
        },
        onDiagnostics: (d) => {
          armInactivity();
          if (!timedOut)
            state.emit("diagnostics", {
              bestScore: d.bestScore,
              elapsedMs: d.elapsedMs,
              ragHits: d.ragHits,
            });
        },
        onChunk: (text) => {
          armInactivity();
          if (!timedOut) state.emit("chunk", { text });
        },
      });
    });

    if (inactivityTimer) clearTimeout(inactivityTimer);

    const trace = { ...state.trace, tools: [...state.trace.tools, toolTrace] };

    // Inactivity timeout path
    if (timedOut && !result.answer.trim()) {
      state.emit("log", {
        line: `[brain] timed out after ${INACTIVITY_MS / 1000}s with no answer`,
      });
      return {
        brainResult: { ...result, error: `inactivity timeout (${INACTIVITY_MS / 1000}s)` },
        trace,
        __nodeSummary: `timeout (${INACTIVITY_MS / 1000}s)`,
      } as any;
    }

    if (result.error) {
      state.emit("log", { line: `[brain] error: ${result.error}` });
    }

    return {
      brainResult: result,
      trace,
      __nodeSummary: result.error
        ? `error: ${result.error.slice(0, 60)}`
        : `${result.answer.length} chars, source=${result.source}`,
    } as any;
  },
);

// ─── Node: refine_answer [tool: glm_reducer] ──────────────────

const refineAnswerNode = traceNode<LG2StateType>(
  "refine_answer",
  async (state) => {
    const brain = state.brainResult;
    const raw = brain?.answer.trim() ?? "";

    if (!raw) {
      state.emit("log", { line: `[reducer] empty brain answer — skipping` });
      return {
        refined: {
          verdict: "no_answer",
          text: "NO_ANSWER",
          reason: "empty brain answer",
          elapsedMs: 0,
        } as RefinedAnswer,
        __nodeSummary: "skip (empty)",
      } as any;
    }

    state.emit("log", {
      line: `[reducer] judging + refining ${raw.length}-char answer with GLM-5.1…`,
    });

    const [refined, toolTrace] = await traceTool("glm_reducer", () =>
      refineAnswer(state.query, raw, state.history),
    );

    const trace = { ...state.trace, tools: [...state.trace.tools, toolTrace] };

    state.emit("reducer", {
      verdict: refined.verdict,
      reason: refined.reason,
      elapsedMs: refined.elapsedMs,
      usedFallback: !!refined.usedFallback,
    });
    state.emit("log", {
      line: `[reducer] verdict=${refined.verdict} (${refined.elapsedMs}ms${refined.usedFallback ? " heuristic" : ""}) reason="${refined.reason}"`,
    });

    return {
      refined,
      trace,
      __nodeSummary: `${refined.verdict} (${refined.elapsedMs}ms)`,
    } as any;
  },
);

// ─── Node: decide_verdict ─────────────────────────────────────

const decideVerdictNode = traceNode<LG2StateType>(
  "decide_verdict",
  (state) => {
    const brain = state.brainResult;
    let verdict: "good" | "no_answer" = state.refined?.verdict ?? "no_answer";

    // Override: if the brain itself errored or timed out, force no_answer
    if (brain?.error) verdict = "no_answer";

    return {
      verdict,
      __nodeSummary: verdict,
    } as any;
  },
);

// ─── Node: emit_good ──────────────────────────────────────────

const emitGoodNode = traceNode<LG2StateType>(
  "emit_good",
  (state) => {
    const refined = state.refined!;
    const brain = state.brainResult!;
    const text = refined.text;
    const source = brain.source || "rag";
    const elapsedMs = brain.elapsedMs;

    state.emit("done", {
      answer: text,
      source,
      elapsedMs,
      isFallback: false,
    });

    return {
      finalAnswer: text,
      source,
      isFallback: false,
      elapsedMs,
      __nodeSummary: `${text.length} chars`,
    } as any;
  },
);

// ─── Node: emit_fallback ──────────────────────────────────────

const emitFallbackNode = traceNode<LG2StateType>(
  "emit_fallback",
  (state) => {
    const { business } = getConfig();
    const reason = state.refined?.reason ?? state.brainResult?.error ?? "no_answer";
    const message =
      `I'm sorry — I couldn't find a clear answer to your question. ` +
      `For detailed assistance, please contact our team directly:\n\n` +
      `📞 Phone: ${business.phone}\n` +
      `📧 Email: ${business.email}`;

    state.emit("fallback", {
      phone: business.phone,
      email: business.email,
      message,
      reason,
    });
    state.emit("done", {
      answer: message,
      source: "fallback",
      elapsedMs: 0,
      isFallback: true,
    });

    return {
      finalAnswer: message,
      source: "fallback",
      isFallback: true,
      elapsedMs: 0,
      __nodeSummary: `reason=${reason.slice(0, 40)}`,
    } as any;
  },
);

// ─── Node: derive_summary [tool: glm_reducer] ─────────────────
// GLM-5.1 derives operational key-value pairs from the conversation
// turn. The summary replaces the full transcript in the remarks
// column so the business team sees what happened, not the full answer.

const deriveSummaryNode = traceNode<LG2StateType>(
  "derive_summary",
  async (state) => {
    const [summary, toolTrace] = await traceTool("glm_summary", () =>
      deriveSummary(
        state.query,
        state.finalAnswer,
        state.isFallback,
        state.history,
      ),
    );

    const trace = { ...state.trace, tools: [...state.trace.tools, toolTrace] };

    state.emit("log", {
      line: `[summary] ${Object.entries(summary.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")} (${summary.elapsedMs}ms${summary.usedFallback ? " heuristic" : ""})`,
    });

    const turnSummary: TurnSummary = {
      outcome: summary.fields["Outcome"] ?? (state.isFallback ? "handed off to team" : "answered by chatbot"),
      fields: summary.fields,
    };

    return {
      summary: turnSummary,
      trace,
      __nodeSummary: `${Object.keys(summary.fields).length} fields (${summary.elapsedMs}ms)`,
    } as any;
  },
);

// ─── Node: persist_turn [tool: contacts_upsert] ───────────────

const persistTurnNode = traceNode<LG2StateType>(
  "persist_turn",
  async (state) => {
    if (!state.lead) {
      return {
        contactResult: null,
        __nodeSummary: "skip (no lead)",
      } as any;
    }

    // The transcript is still passed for the legacy fallback path in
    // renderRemarks, but when a summary is present it is NOT used —
    // the summary replaces the full transcript in the remarks column.
    const transcript = [
      { role: "user" as const, content: state.query },
      {
        role: "assistant" as const,
        content: state.finalAnswer,
        source: state.source,
      },
    ];

    const [result, toolTrace] = await traceTool("contacts_upsert", () =>
      saveContactWithConversation(
        { ...state.lead!, capturedAt: state.lead!.capturedAt || 0 },
        transcript,
        state.context,
        state.summary,
      ),
    );

    const trace = { ...state.trace, tools: [...state.trace.tools, toolTrace] };

    state.emit("remarks-saved", result);

    return {
      contactResult: result,
      trace,
      __nodeSummary: result.ok ? result.action : `fail: ${result.reason}`,
    } as any;
  },
);

// ─── Node: detect_late_company [tool: contacts_update_field] ──

const COMPANY_PATTERNS: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => string }> = [
  {
    re: /\b(?:my company is|company(?:'s)? name is|i work at|i work for|we are from|we're from|from)\s+([A-Z][\w&.,\- ]{1,60})/i,
    pick: (m) => m[1].trim().replace(/[.,]+$/, ""),
  },
  {
    re: /\bcompany[:\s]+([A-Z][\w&.,\- ]{1,60})/i,
    pick: (m) => m[1].trim().replace(/[.,]+$/, ""),
  },
];

const detectLateCompanyNode = traceNode<LG2StateType>(
  "detect_late_company",
  async (state) => {
    if (!state.lead) {
      return {
        lateCompanyResult: null,
        __nodeSummary: "skip (no lead)",
      } as any;
    }

    let detectedValue: string | null = null;
    for (const { re, pick } of COMPANY_PATTERNS) {
      const match = state.query.match(re);
      if (match) {
        const value = pick(match);
        if (value && value.length >= 2) {
          // Skip if the value is identical to current — no-op update
          if (state.lead.company && state.lead.company.trim() === value) break;
          detectedValue = value;
          break;
        }
      }
    }

    if (!detectedValue) {
      return {
        lateCompanyResult: null,
        __nodeSummary: "no pattern",
      } as any;
    }

    state.emit("log", {
      line: `[contact] company update: "${state.lead.company ?? ""}" → "${detectedValue}"`,
    });

    const [result, toolTrace] = await traceTool("contacts_update_field", () =>
      updateContactField(state.lead!.email, "company", detectedValue!),
    );

    const trace = { ...state.trace, tools: [...state.trace.tools, toolTrace] };

    state.emit("contact-updated", {
      field: "company",
      value: detectedValue,
      ...result,
    });

    return {
      lateCompanyResult: result,
      trace,
      __nodeSummary: result.ok ? `company="${detectedValue}"` : `fail: ${result.reason}`,
    } as any;
  },
);

// ─── Routing ──────────────────────────────────────────────────

function routeAfterCallBrain(state: LG2StateType): "refine_answer" | "emit_fallback" {
  const brain = state.brainResult;
  // If the brain errored AND produced no answer text, jump straight to fallback.
  if (brain?.error && !brain.answer.trim()) return "emit_fallback";
  return "refine_answer";
}

function routeAfterDecide(state: LG2StateType): "emit_good" | "emit_fallback" {
  return state.verdict === "good" ? "emit_good" : "emit_fallback";
}

// ─── Build the graph ──────────────────────────────────────────

const workflow = new StateGraph(LG2State)
  .addNode("call_brain", callBrainNode)
  .addNode("refine_answer", refineAnswerNode)
  .addNode("decide_verdict", decideVerdictNode)
  .addNode("emit_good", emitGoodNode)
  .addNode("emit_fallback", emitFallbackNode)
  .addNode("derive_summary", deriveSummaryNode)
  .addNode("persist_turn", persistTurnNode)
  .addNode("detect_late_company", detectLateCompanyNode)
  .addEdge(START, "call_brain")
  .addConditionalEdges("call_brain", routeAfterCallBrain, {
    refine_answer: "refine_answer",
    emit_fallback: "emit_fallback",
  })
  .addEdge("refine_answer", "decide_verdict")
  .addConditionalEdges("decide_verdict", routeAfterDecide, {
    emit_good: "emit_good",
    emit_fallback: "emit_fallback",
  })
  .addEdge("emit_good", "derive_summary")
  .addEdge("emit_fallback", "derive_summary")
  .addEdge("derive_summary", "persist_turn")
  .addEdge("persist_turn", "detect_late_company")
  .addEdge("detect_late_company", END);

// No checkpointer → no HITL, no time-travel
export const chatGraph = workflow.compile();

// ─── Public entry point ───────────────────────────────────────

export async function runChatGraph(input: ChatGraphInput): Promise<ChatGraphOutput> {
  const startedAt = Date.now();
  const initialTrace: GraphTrace = {
    graphName: "ChatGraph",
    startedAt,
    endedAt: 0,
    durationMs: 0,
    nodes: [],
    tools: [],
  };

  const finalState = await chatGraph.invoke({
    trace: initialTrace,
    query: input.query,
    history: input.history,
    lead: input.lead,
    emit: input.emit,
    context: input.context,
    brainResult: undefined,
    refined: undefined,
    verdict: "no_answer",
    summary: undefined,
    finalAnswer: "",
    source: "",
    isFallback: false,
    elapsedMs: 0,
    contactResult: null,
    lateCompanyResult: null,
  });

  const endedAt = Date.now();
  const trace: GraphTrace = {
    ...finalState.trace,
    endedAt,
    durationMs: endedAt - startedAt,
  };

  return {
    finalAnswer: finalState.finalAnswer,
    source: finalState.source,
    isFallback: finalState.isFallback,
    elapsedMs: finalState.elapsedMs,
    citations: finalState.brainResult?.citations ?? [],
    diagnostics: finalState.brainResult?.diagnostics,
    refined: finalState.refined ?? null,
    contactResult: finalState.contactResult,
    lateCompanyResult: finalState.lateCompanyResult,
    trace,
  };
}
