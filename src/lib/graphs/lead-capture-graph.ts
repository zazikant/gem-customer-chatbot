/**
 * LeadCaptureGraph (LG1) — LangGraph conversion of the original
 * conversational lead-capture state machine.
 *
 * Per the sequence diagram:
 *   • No tools
 *   • No reducers (uses last-write-wins on every channel)
 *   • Hardcoded edges only — branching is deterministic
 *
 * Nodes:
 *   validate_input → update_partial → complete_lead → generate_bot_message
 *                 ↘ handle_retry  ↗
 *
 * The graph streams SSE events to the client via the `emit` channel
 * (a non-serializable function — fine because we don't use a checkpointer).
 */

import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import {
  FIELD_ORDER,
  FIELD_PROMPTS,
  validateField,
  type CaptureState,
  type Lead,
  type LeadField,
} from "@/lib/lead-capture";
import {
  traceNode,
  type GraphTrace,
  type LeadCaptureGraphInput,
  type LeadCaptureGraphOutput,
} from "./types";

// ─── State annotation (no reducers — last-write-wins) ─────────

const LG1State = Annotation.Root({
  trace: Annotation<GraphTrace>,
  captureState: Annotation<CaptureState>,
  userMessage: Annotation<string>,
  emit: Annotation<(type: string, payload: Record<string, unknown>) => void>,
  // Internal scratchpad:
  validationOk: Annotation<boolean>,
  validatedValue: Annotation<string | undefined>,
  validationError: Annotation<string | undefined>,
  isLastField: Annotation<boolean>,
  // Output:
  botMessage: Annotation<string>,
  completedLead: Annotation<Lead | undefined>,
});

type LG1StateType = typeof LG1State.State;

// ─── Node: validate_input ─────────────────────────────────────

const validateInputNode = traceNode<LG1StateType>(
  "validate_input",
  (state) => {
    const cs = state.captureState;
    if (cs.status !== "capturing" || !cs.current) {
      return {
        validationOk: false,
        validationError: "Capture is not active.",
        isLastField: false,
        __nodeSummary: "skip (not capturing)",
      } as any;
    }
    const field: LeadField = cs.retrying ?? cs.current;
    const result = validateField(field, state.userMessage);
    if (result.ok) {
      const isLast = field === FIELD_ORDER[FIELD_ORDER.length - 1];
      return {
        validationOk: true,
        validatedValue: result.value,
        validationError: undefined,
        isLastField: isLast,
        __nodeSummary: `valid ${field}="${result.value.slice(0, 40)}"${isLast ? " (last)" : ""}`,
      } as any;
    }
    return {
      validationOk: false,
      validatedValue: undefined,
      validationError: result.error,
      isLastField: false,
      __nodeSummary: `invalid ${field}: ${result.error}`,
    } as any;
  },
);

// ─── Node: update_partial ─────────────────────────────────────

const updatePartialNode = traceNode<LG1StateType>(
  "update_partial",
  (state) => {
    const cs = state.captureState;
    const field = (cs.retrying ?? cs.current)!;
    const value = state.validatedValue!;
    const partial: Partial<Lead> = { ...cs.partial, [field]: value };
    const nextIndex = FIELD_ORDER.indexOf(field) + 1;
    const nextField = FIELD_ORDER[nextIndex];

    const newCaptureState: CaptureState = {
      status: "capturing",
      current: nextField,
      partial,
      retrying: undefined,
    };

    state.emit("capture", {
      status: newCaptureState.status,
      current: newCaptureState.current,
      partial: newCaptureState.partial,
    });

    return {
      captureState: newCaptureState,
      __nodeSummary: `+${field}, next=${nextField ?? "(end)"}`,
    } as any;
  },
);

// ─── Node: complete_lead ──────────────────────────────────────

const completeLeadNode = traceNode<LG1StateType>(
  "complete_lead",
  (state) => {
    const cs = state.captureState;
    const partial = cs.partial;
    const lead: Lead = {
      name: partial.name!,
      email: partial.email!,
      phone: partial.phone!,
      company: partial.company || undefined,
      capturedAt: Date.now(),
    };
    const newCaptureState: CaptureState = {
      status: "complete",
      partial: lead,
      current: undefined,
      retrying: undefined,
    };
    state.emit("capture", { status: "complete", lead });
    return {
      captureState: newCaptureState,
      completedLead: lead,
      __nodeSummary: `lead=${lead.email}`,
    } as any;
  },
);

// ─── Node: handle_retry ───────────────────────────────────────

const handleRetryNode = traceNode<LG1StateType>(
  "handle_retry",
  (state) => {
    const cs = state.captureState;
    const field = (cs.retrying ?? cs.current)!;
    const newCaptureState: CaptureState = {
      ...cs,
      retrying: field,
      prompt: state.validationError,
    };
    state.emit("capture", {
      status: newCaptureState.status,
      current: newCaptureState.current,
      partial: newCaptureState.partial,
      retrying: field,
    });
    return {
      captureState: newCaptureState,
      __nodeSummary: `retry ${field}`,
    } as any;
  },
);

// ─── Node: generate_bot_message ───────────────────────────────

const generateBotMessageNode = traceNode<LG1StateType>(
  "generate_bot_message",
  (state) => {
    const cs = state.captureState;
    let botMessage = "";

    if (cs.status === "complete") {
      const lead = state.completedLead;
      const firstName = (lead?.name ?? "").split(" ")[0] || "there";
      botMessage =
        `Thank you, ${firstName}! You're all set. ` +
        `How can I help you today?`;
      state.emit("chat", { phase: "chat" });
    } else if (!state.validationOk) {
      botMessage = state.validationError ?? "Could you try that again?";
    } else {
      const nextField = cs.current;
      botMessage = nextField ? FIELD_PROMPTS[nextField] : "";
      state.emit("chat", { phase: "capture" });
    }

    if (botMessage) {
      state.emit("bot", { text: botMessage });
    }

    return {
      botMessage,
      __nodeSummary: botMessage.slice(0, 60),
    } as any;
  },
);

// ─── Routing functions (deterministic — "hardcoded edges") ────

function routeAfterValidate(state: LG1StateType): "update_partial" | "handle_retry" {
  return state.validationOk ? "update_partial" : "handle_retry";
}

function routeAfterUpdate(state: LG1StateType): "complete_lead" | "generate_bot_message" {
  return state.isLastField ? "complete_lead" : "generate_bot_message";
}

// ─── Build the graph ──────────────────────────────────────────

const workflow = new StateGraph(LG1State)
  .addNode("validate_input", validateInputNode)
  .addNode("update_partial", updatePartialNode)
  .addNode("complete_lead", completeLeadNode)
  .addNode("handle_retry", handleRetryNode)
  .addNode("generate_bot_message", generateBotMessageNode)
  .addEdge(START, "validate_input")
  .addConditionalEdges("validate_input", routeAfterValidate, {
    update_partial: "update_partial",
    handle_retry: "handle_retry",
  })
  .addConditionalEdges("update_partial", routeAfterUpdate, {
    complete_lead: "complete_lead",
    generate_bot_message: "generate_bot_message",
  })
  .addEdge("complete_lead", "generate_bot_message")
  .addEdge("handle_retry", "generate_bot_message")
  .addEdge("generate_bot_message", END);

// No checkpointer → no HITL, no time-travel
export const leadCaptureGraph = workflow.compile();

// ─── Public entry point ───────────────────────────────────────

export async function runLeadCaptureGraph(
  input: LeadCaptureGraphInput,
): Promise<LeadCaptureGraphOutput> {
  const startedAt = Date.now();
  const initialTrace: GraphTrace = {
    graphName: "LeadCaptureGraph",
    startedAt,
    endedAt: 0,
    durationMs: 0,
    nodes: [],
    tools: [],
  };

  const finalState = await leadCaptureGraph.invoke({
    trace: initialTrace,
    captureState: input.captureState,
    userMessage: input.userMessage,
    emit: input.emit,
    validationOk: false,
    validatedValue: undefined,
    validationError: undefined,
    isLastField: false,
    botMessage: "",
    completedLead: undefined,
  });

  const endedAt = Date.now();
  const trace: GraphTrace = {
    ...finalState.trace,
    endedAt,
    durationMs: endedAt - startedAt,
  };

  return {
    captureState: finalState.captureState,
    botMessage: finalState.botMessage,
    completedLead: finalState.completedLead,
    trace,
  };
}
