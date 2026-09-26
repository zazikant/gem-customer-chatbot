/**
 * Operational summary — GLM-5.1 derives structured key-value pairs
 * from the conversation turn (question + answer + history).
 *
 * The summary replaces the full transcript in the csv-chat-vercel
 * `remarks` column. The business team sees at a glance what the
 * customer wanted, without reading the full answer.
 *
 * The LLM decides which keys are relevant based on the conversation.
 * Common keys: Intent, Lead stage, Service, Status, Topic, Slots
 * offered, Appointment intent, etc.
 *
 * Used by the `derive_summary` node inside ChatGraph.
 */

import { getConfig } from "./config";

const OPENCODE_GATEWAY = "https://opencode.ai/zen/go/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 15_000;

const SUMMARIZER_SYSTEM_PROMPT = `You are an operational analyst for a customer-support chatbot.

You are given a conversation turn: the user's question, the chatbot's answer, and recent conversation history.

Your job: extract a short operational summary as key-value pairs that describe WHAT HAPPENED in this turn from a business-operations perspective.

Derive the keys YOURSELF based on the conversation. Common keys include (use only the ones that apply — skip irrelevant ones):

- Outcome: always include. "answered by chatbot" if the bot answered, "handed off to team" if it fell back to human contact.
- Lead stage: where the customer is in the journey. e.g. "information_seeking", "booking_requested", "pricing_inquiry", "complaint", "follow_up", "resolved".
- Intent: what the customer wanted. e.g. "appointment_booking", "return_policy", "product_question", "pricing", "technical_support".
- Service / Product / Topic: the specific subject. e.g. "cleaning", "gym routine", "shipping", "Nike shoes size 10".
- Status: the current state. e.g. "answered", "awaiting patient confirmation", "unanswered", "needs follow-up".
- Slots offered: if appointment/booking slots were discussed, list them.
- Any other operationally useful key the conversation surfaces.

Rules:
- Output STRICT JSON: {"key1":"value1","key2":"value2",...}
- Always include "Outcome".
- Keep values short (1-10 words). No full sentences.
- Do NOT include the full answer text — the business team reads the summary, not the transcript.
- If the conversation is a meta-question ("what was my first question?"), set Outcome to "answered by chatbot", Intent to "meta_question", and Status to "answered".
- No preamble, no markdown fence, just the JSON object.`;

export interface OperationalSummary {
  /** Key-value pairs, e.g. { Outcome: "answered by chatbot", Intent: "gym_routine", ... } */
  fields: Record<string, string>;
  elapsedMs: number;
  /** Set when the LLM API was unreachable and we used a heuristic. */
  usedFallback?: boolean;
}

export async function deriveSummary(
  question: string,
  answer: string,
  isFallback: boolean,
  history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<OperationalSummary> {
  const start = Date.now();
  const { opencodeApiKey, opencodeModel } = getConfig();

  // Heuristic fallback if no key
  if (!opencodeApiKey) {
    return heuristicSummary(question, answer, isFallback, start, "no key");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const recentHistory = history.slice(-6);
    const historyBlock =
      recentHistory.length > 0
        ? recentHistory
            .map((h) => `  ${h.role}: ${h.content.slice(0, 400)}`)
            .join("\n")
        : "(no prior conversation)";

    const response = await fetch(OPENCODE_GATEWAY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opencodeApiKey}`,
        "x-opencode-session": crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: opencodeModel,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Conversation history (oldest first):\n${historyBlock}\n\n` +
              `Current question:\n${question}\n\n` +
              `Chatbot answer:\n${answer.slice(0, 1500)}\n\n` +
              `Fallback (handed off to team)?: ${isFallback}`,
          },
        ],
        max_tokens: 512,
        temperature: 0,
        stream: false,
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return heuristicSummary(question, answer, isFallback, start, `HTTP ${response.status}`);
    }

    const data: any = await response.json();
    const raw: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      "";
    const text = raw.trim();
    if (!text) {
      return heuristicSummary(question, answer, isFallback, start, "empty LLM response");
    }

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return heuristicSummary(question, answer, isFallback, start, "non-JSON response");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return heuristicSummary(question, answer, isFallback, start, "not an object");
    }

    // Normalize: stringify all values, ensure Outcome exists
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) {
        fields[k] = v.trim();
      } else if (typeof v === "number" || typeof v === "boolean") {
        fields[k] = String(v);
      }
    }
    if (!fields["Outcome"]) {
      fields["Outcome"] = isFallback ? "handed off to team" : "answered by chatbot";
    }

    return {
      fields,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timer);
    return heuristicSummary(question, answer, isFallback, start, (err as Error).message);
  }
}

function heuristicSummary(
  question: string,
  answer: string,
  isFallback: boolean,
  start: number,
  reason: string,
): OperationalSummary {
  const fields: Record<string, string> = {
    Outcome: isFallback ? "handed off to team" : "answered by chatbot",
    Status: isFallback ? "unanswered" : "answered",
  };
  // Crude intent detection from the question
  const q = question.toLowerCase();
  if (/book|appointment|schedule|slot/.test(q)) {
    fields["Intent"] = "appointment_booking";
    fields["Lead stage"] = "booking_requested";
  } else if (/price|cost|quote|rate|fee/.test(q)) {
    fields["Intent"] = "pricing_inquiry";
    fields["Lead stage"] = "pricing_inquiry";
  } else if (/return|refund|cancel/.test(q)) {
    fields["Intent"] = "return_policy";
    fields["Lead stage"] = "complaint";
  } else if (/what was my|repeat|previous/.test(q)) {
    fields["Intent"] = "meta_question";
  } else {
    fields["Intent"] = "information_seeking";
    fields["Lead stage"] = "information_seeking";
  }
  return {
    fields,
    elapsedMs: Date.now() - start,
    usedFallback: true,
  };
}
