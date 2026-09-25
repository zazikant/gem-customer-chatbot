/**
 * LangGraph tools used by ChatGraph.
 *
 * Per the sequence diagram, ChatGraph has 4 tools:
 *   - brain_proxy            → calls upstream chat-brain SSE endpoint
 *   - glm_reducer            → judges + rewrites the brain's draft via GLM-5.1
 *   - contacts_upsert        → saves/updates contact + appends remarks
 *   - contacts_update_field  → updates a single contact field (e.g. late company)
 *
 * Tools are defined with `tool()` from @langchain/core/tools so they
 * have a stable name + schema, but they're invoked explicitly from
 * inside ChatGraph nodes (no agent loop, no ToolNode).
 *
 * "No HITL / checkpointer / time-travel" — these tools are
 * deterministic and side-effectful; the graph never interrupts for
 * human approval and never replays state.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callBrain, type BrainResult } from "@/lib/brain-client";
import { refineAnswer, type RefinedAnswer } from "@/lib/reducer";
import {
  saveContactWithConversation,
  updateContactField,
  type ContactWriteResult,
} from "@/lib/contacts";
import type { Lead } from "@/lib/lead-capture";

// ─── brain_proxy ──────────────────────────────────────────────

export interface BrainProxyCallbacks {
  onLog?: (line: string) => void;
  onChunk?: (text: string) => void;
  onSource?: (source: string) => void;
  onCitations?: (citations: BrainResult["citations"]) => void;
  onDiagnostics?: (d: NonNullable<BrainResult["diagnostics"]>) => void;
}

export const brainProxyTool = tool(
  async ({ query, history, callbacks }): Promise<BrainResult> => {
    return callBrain({
      query,
      history,
      onLog: callbacks?.onLog,
      onChunk: callbacks?.onChunk,
      onSource: callbacks?.onSource,
      onCitations: callbacks?.onCitations,
      onDiagnostics: callbacks?.onDiagnostics,
    });
  },
  {
    name: "brain_proxy",
    description:
      "Proxy to the upstream chat-brain SSE endpoint. Streams chunks back via callbacks.",
    schema: z.object({
      query: z.string(),
      history: z
        .array(
          z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
          }),
        )
        .default([]),
      callbacks: z.any().optional(),
    }),
  },
);

// ─── glm_reducer ──────────────────────────────────────────────

export const glmReducerTool = tool(
  async ({ question, draft }): Promise<RefinedAnswer> => {
    return refineAnswer(question, draft);
  },
  {
    name: "glm_reducer",
    description:
      "Judge + rewrite the brain's draft via GLM-5.1 in a single LLM call. Returns verdict (good|no_answer), refined text, reason, elapsedMs.",
    schema: z.object({
      question: z.string(),
      draft: z.string(),
    }),
  },
);

// ─── contacts_upsert ──────────────────────────────────────────

export const contactsUpsertTool = tool(
  async ({
    lead,
    messages,
  }: {
    lead: Lead;
    messages: Array<{ role: "user" | "assistant"; content: string; source?: string }>;
  }): Promise<ContactWriteResult> => {
    return saveContactWithConversation(lead, messages);
  },
  {
    name: "contacts_upsert",
    description:
      "Insert or merge a contact in csv-chat-vercel main_contacts. Email is the PK. Appends today's conversation block to remarks. Sets tags=['chatbot'], source=['gem-chatbot'].",
    schema: z.object({
      lead: z.any(),
      messages: z.array(z.any()),
    }),
  },
);

// ─── contacts_update_field ────────────────────────────────────

export const contactsUpdateFieldTool = tool(
  async ({
    email,
    field,
    value,
  }: {
    email: string;
    field: "company" | "name" | "phone" | "remarks" | "city" | "designation";
    value: string;
  }): Promise<ContactWriteResult> => {
    return updateContactField(email, field, value);
  },
  {
    name: "contacts_update_field",
    description:
      "Update a single field on an existing contact (PUT /api/main-contacts with email + one field — server-side MERGE preserves everything else).",
    schema: z.object({
      email: z.string(),
      field: z.string(),
      value: z.string(),
    }),
  },
);
