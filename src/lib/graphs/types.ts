/**
 * Shared types used by both graphs (LeadCaptureGraph + ChatGraph)
 * and the /api/chat route.
 *
 * The trace structures (NodeTrace, ToolTrace, GraphTrace) let the
 * UI render a live execution panel showing which LangGraph nodes
 * ran, which tools were called, and how long each step took.
 */

import type { CaptureState, Lead } from "@/lib/lead-capture";
import type { RefinedAnswer } from "@/lib/reducer";
import type { BrainResult } from "@/lib/brain-client";
import type { ContactWriteResult } from "@/lib/contacts";

export type GraphName = "LeadCaptureGraph" | "ChatGraph";

export interface NodeTrace {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  summary?: string;
}

export interface ToolTrace {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  summary?: string;
}

export interface GraphTrace {
  graphName: GraphName;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  nodes: NodeTrace[];
  tools: ToolTrace[];
}

/** Tracing helper — wraps a node fn so each invocation is logged. */
export function traceNode<TState extends { trace: GraphTrace }>(
  name: string,
  fn: (state: TState) => Promise<Partial<TState>> | Partial<TState>,
) {
  return async (state: TState): Promise<Partial<TState>> => {
    const startedAt = Date.now();
    const update = await fn(state);
    const endedAt = Date.now();
    const nodeTrace: NodeTrace = {
      name,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      summary: (update as any)?.__nodeSummary,
    };
    if (update && typeof (update as any).__nodeSummary !== "undefined") {
      delete (update as any).__nodeSummary;
    }
    // Use update.trace as the base if the node fn returned one (it may
    // already have appended tool traces); otherwise fall back to
    // state.trace. Then append this node's trace entry.
    const baseTrace: GraphTrace =
      (update as any)?.trace ?? state.trace;
    return {
      ...update,
      trace: {
        ...baseTrace,
        nodes: [...(baseTrace.nodes ?? []), nodeTrace],
      },
    } as Partial<TState>;
  };
}

/** Tracing helper for tool calls. Returns [result, toolTrace]. */
export async function traceTool<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<[T, ToolTrace]> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const endedAt = Date.now();
    return [
      result,
      {
        name,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        ok: true,
      },
    ];
  } catch (err) {
    const endedAt = Date.now();
    return [
      null as unknown as T,
      {
        name,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        ok: false,
        summary: (err as Error).message,
      },
    ];
  }
}

// ─── ChatGraph shared state shape ──────────────────────────────

export interface ChatGraphInput {
  query: string;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  lead?: Lead;
  emit: (type: string, payload: Record<string, unknown>) => void;
}

export interface ChatGraphOutput {
  finalAnswer: string;
  source: string;
  isFallback: boolean;
  elapsedMs: number;
  citations: BrainResult["citations"];
  diagnostics?: BrainResult["diagnostics"];
  refined: RefinedAnswer | null;
  contactResult: ContactWriteResult | null;
  lateCompanyResult: ContactWriteResult | null;
  trace: GraphTrace;
}

// ─── LeadCaptureGraph shared state shape ───────────────────────

export interface LeadCaptureGraphInput {
  captureState: CaptureState;
  userMessage: string;
  emit: (type: string, payload: Record<string, unknown>) => void;
}

export interface LeadCaptureGraphOutput {
  captureState: CaptureState;
  botMessage: string;
  completedLead?: Lead;
  trace: GraphTrace;
}
