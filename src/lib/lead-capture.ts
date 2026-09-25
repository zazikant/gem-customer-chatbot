/**
 * Conversational lead-capture state machine.
 *
 * Pure logic — no I/O. Tested in isolation.
 *
 * The chatbot greets the user and asks for:
 *   1. Name
 *   2. Email
 *   3. Phone
 *   4. Company (optional — "skip" / "none" / "-" all accepted)
 *
 * Once all required fields are collected, the lead is finalised and
 * the user can ask real questions. Each user message is checked for
 * a valid value for the current field; on success the state machine
 * advances to the next field. On failure, the bot re-prompts with
 * the specific reason.
 *
 * Used by the LeadCaptureGraph nodes (validate_input, update_partial,
 * complete_lead, handle_retry, generate_bot_message).
 */

export type LeadField = "name" | "email" | "phone" | "company";
export type CaptureStatus = "idle" | "capturing" | "complete";

export interface Lead {
  name: string;
  email: string;
  phone: string;
  company?: string;
  capturedAt: number;
}

export interface CaptureState {
  status: CaptureStatus;
  current?: LeadField;
  partial: Partial<Lead>;
  prompt?: string;
  retrying?: LeadField;
}

export const INITIAL_STATE: CaptureState = {
  status: "capturing",
  current: "name",
  partial: {},
  prompt:
    "👋 Hi! I'm the GEM Customer Chatbot. I'll be happy to help. " +
    "First, may I have your **name**?",
};

export const FIELD_PROMPTS: Record<LeadField, string> = {
  name: "What is your **name**?",
  email: "Thanks! What is your **email** address?",
  phone:
    "Got it. What is your **phone** number? (with country code, e.g. +91 …)",
  company:
    'Last question — what is your **company** name? *(Type "skip" if not applicable.)*',
};

export const FIELD_ORDER: LeadField[] = ["name", "email", "phone", "company"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[\d\s\-()]{6,20}$/;
const DIGIT_COUNT_RE = /\d/g;
const SKIP_RE = /^(skip|none|n\/a|na|-|\.|—)$/i;

/** Per-field validator. Returns the cleaned value or an error message. */
export function validateField(
  field: LeadField,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "I didn't catch that — please try again." };

  switch (field) {
    case "name": {
      if (trimmed.length < 2) return { ok: false, error: "That name looks too short." };
      if (trimmed.length > 80)
        return { ok: false, error: "That name is quite long — could you shorten it?" };
      if (/[?!]/.test(trimmed))
        return {
          ok: false,
          error: "That looks like a question — could you share your name?",
        };
      return { ok: true, value: trimmed };
    }
    case "email": {
      if (!EMAIL_RE.test(trimmed))
        return { ok: false, error: "That doesn't look like a valid email address." };
      return { ok: true, value: trimmed };
    }
    case "phone": {
      if (!PHONE_RE.test(trimmed)) {
        return {
          ok: false,
          error: "Please include the country code starting with +, e.g. +91 98765 43210.",
        };
      }
      const digits = trimmed.match(DIGIT_COUNT_RE);
      if (!digits || digits.length < 7) {
        return {
          ok: false,
          error: "That phone number looks too short — please include the full number.",
        };
      }
      if (trimmed.split(/\s+/).length > 6)
        return { ok: false, error: "That looks like more than a phone number." };
      return { ok: true, value: trimmed };
    }
    case "company": {
      if (SKIP_RE.test(trimmed)) return { ok: true, value: "" };
      if (trimmed.length < 2)
        return { ok: false, error: 'Company name is too short, or type "skip".' };
      if (trimmed.length > 100)
        return { ok: false, error: "Company name is too long." };
      return { ok: true, value: trimmed };
    }
  }
}
