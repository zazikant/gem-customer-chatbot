/**
 * csv-chat-vercel contact client.
 *
 * Writes captured leads to the shared `main_contacts` table via the
 * csv-chat-vercel Next.js API.
 *
 * Used by the `contacts_upsert` and `contacts_update_field` tools
 * inside ChatGraph (persist_turn, detect_late_company nodes).
 *
 * Endpoint: POST /api/main-contacts  (first time → INSERT, return → server-side MERGE)
 * Endpoint: PUT  /api/main-contacts  (single-field update — MERGE preserves the rest)
 *
 * Every contact created by this bot gets the `chatbot` tag so the
 * team can filter leads from this source in the CSV app.
 */

import type { Lead } from "./lead-capture";
import { getConfig } from "./config";

function csvChatBase(): string {
  return getConfig().csvChatBase;
}

export const CHATBOT_TAG = "chatbot";
export const CHATBOT_SOURCE = "gem-chatbot";

export interface ContactWriteResult {
  ok: boolean;
  action: "created" | "updated" | "noop" | "skipped";
  row?: Record<string, unknown>;
  reason?: string;
  error?: string;
}

export function formatIstDate(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function formatIstTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function renderRemarks(
  messages: Array<{ role: "user" | "assistant"; content: string; source?: string }>,
  date: Date = new Date(),
): string {
  const day = formatIstDate(date);
  const lines: string[] = [`[${day}] Conversation captured via GEM chatbot`];
  for (const m of messages) {
    const time = formatIstTime(date);
    const tag = m.source === "fallback" ? "bot (handoff)" : m.role;
    // Preserve the full content verbatim — do NOT trim or collapse whitespace.
    // Previous versions sliced to 500 chars and replaced \s+ with a single
    // space, which mangled multi-line answers and lost the tail of long
    // responses. The remarks column is a TEXT field in Supabase and can
    // hold arbitrarily long strings.
    const content = m.content.trim();
    // Indent continuation lines so multi-line content stays readable
    // inside the per-message remark block.
    const indented = content
      .split("\n")
      .map((l, i) => (i === 0 ? l : `      ${l}`))
      .join("\n");
    lines.push(`  ${time} IST — ${tag}: ${indented}`);
  }
  return lines.join("\n");
}

// ─── Low-level HTTP wrappers ──────────────────────────────────

async function apiPost(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${csvChatBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function apiPut(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${csvChatBase()}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function apiGet(path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${csvChatBase()}${path}`, {
    method: "GET",
    cache: "no-store",
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

// ─── Public API ───────────────────────────────────────────────

export async function findContactByEmail(
  email: string,
): Promise<Record<string, unknown> | null> {
  const safe = encodeURIComponent(email.trim().toLowerCase());
  const { status, data } = await apiGet(`/api/main-contacts?page=1&pageSize=1&q=${safe}`);
  if (status !== 200) return null;
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  return rows[0] ?? null;
}

export async function saveContactWithConversation(
  lead: Lead,
  messages: Array<{ role: "user" | "assistant"; content: string; source?: string }>,
): Promise<ContactWriteResult> {
  const newBlock = renderRemarks(messages);

  let existing: Record<string, unknown> | null = null;
  try {
    existing = await findContactByEmail(lead.email);
  } catch (err) {
    return {
      ok: false,
      action: "skipped",
      reason: "lookup-failed",
      error: (err as Error).message,
    };
  }

  if (!existing) {
    const payload = {
      email: lead.email,
      name: lead.name,
      phone: lead.phone,
      company: lead.company ?? null,
      remarks: newBlock,
      tags: [CHATBOT_TAG],
      source: [CHATBOT_SOURCE],
    };
    try {
      const { status, data } = await apiPost("/api/main-contacts", payload);
      if (status === 201 || status === 200) {
        return { ok: true, action: "created", row: data };
      }
      return {
        ok: false,
        action: "skipped",
        reason: `insert status ${status}`,
        error: data?.error ?? JSON.stringify(data).slice(0, 200),
      };
    } catch (err) {
      return {
        ok: false,
        action: "skipped",
        reason: "insert-failed",
        error: (err as Error).message,
      };
    }
  }

  const prevRemarks =
    typeof existing.remarks === "string" && existing.remarks.trim().length > 0
      ? existing.remarks
      : "";
  const mergedRemarks = prevRemarks ? `${prevRemarks}\n\n${newBlock}` : newBlock;

  const prevTags = Array.isArray(existing.tags) ? (existing.tags as string[]) : [];
  const mergedTags = prevTags.includes(CHATBOT_TAG) ? prevTags : [...prevTags, CHATBOT_TAG];

  const prevSource = Array.isArray(existing.source) ? (existing.source as string[]) : [];
  const mergedSource = prevSource.includes(CHATBOT_SOURCE)
    ? prevSource
    : [...prevSource, CHATBOT_SOURCE];

  const payload: Record<string, unknown> = {
    email: lead.email,
    remarks: mergedRemarks,
    tags: mergedTags,
    source: mergedSource,
  };
  if (lead.name && lead.name.trim().length > 0) payload.name = lead.name.trim();
  if (lead.phone && lead.phone.trim().length > 0) payload.phone = lead.phone.trim();
  if (lead.company && lead.company.trim().length > 0) payload.company = lead.company.trim();
  try {
    const { status, data } = await apiPut("/api/main-contacts", payload);
    if (status === 200) {
      return { ok: true, action: "updated", row: data };
    }
    return {
      ok: false,
      action: "skipped",
      reason: `update status ${status}`,
      error: data?.error ?? JSON.stringify(data).slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      action: "skipped",
      reason: "update-failed",
      error: (err as Error).message,
    };
  }
}

export async function updateContactField(
  email: string,
  field: "company" | "name" | "phone" | "remarks" | "city" | "designation",
  value: string,
): Promise<ContactWriteResult> {
  try {
    const { status, data } = await apiPut("/api/main-contacts", {
      email,
      [field]: value,
    });
    if (status === 200) return { ok: true, action: "updated", row: data };
    if (status === 404) return { ok: false, action: "skipped", reason: "not-found" };
    return {
      ok: false,
      action: "skipped",
      reason: `update-field status ${status}`,
      error: data?.error ?? JSON.stringify(data).slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      action: "skipped",
      reason: "update-field-failed",
      error: (err as Error).message,
    };
  }
}
