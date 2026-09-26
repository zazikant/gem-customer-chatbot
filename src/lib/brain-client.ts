/**
 * Brain client — talks to the upstream chat-brain endpoint and yields
 * structured events to the caller.
 *
 * It does NOT decide whether the answer is useful. That's the
 * `glm_reducer` tool's job — it inspects the final answer and
 * chooses between relaying it or handing off to the business
 * contact fallback.
 */

import { getConfig } from "./config";

export type BrainEvent =
  | { type: "log"; line: string }
  | { type: "source"; source: string }
  | { type: "citations"; citations: Array<{ id: string; title?: string; score: number }> }
  | { type: "diagnostics"; bestScore: number; elapsedMs: number; ragHits: number }
  | { type: "chunk"; text: string }
  | { type: "done"; answer: string; elapsedMs: number; source: string }
  | { type: "error"; message: string };

export interface BrainCallOptions {
  query: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  onLog?: (line: string) => void;
  onChunk?: (text: string) => void;
  onSource?: (source: string) => void;
  onCitations?: (citations: BrainEvent extends { type: "citations"; citations: infer C } ? C : never) => void;
  onDiagnostics?: (d: { bestScore: number; elapsedMs: number; ragHits: number }) => void;
  signal?: AbortSignal;
}

export interface BrainResult {
  answer: string;
  source: string;
  elapsedMs: number;
  citations: Array<{ id: string; title?: string; score: number }>;
  diagnostics?: { bestScore: number; elapsedMs: number; ragHits: number };
  error?: string;
}

/** Stream events from the upstream brain; resolve to a BrainResult. */
export async function callBrain(opts: BrainCallOptions): Promise<BrainResult> {
  const url = getConfig().chatBrainUrl;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: opts.query,
        history: opts.history ?? [],
        top_k: 8,
        min_score: 0.55,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      answer: "",
      source: "",
      elapsedMs: 0,
      citations: [],
      error: `upstream fetch failed: ${(err as Error).message}`,
    };
  }

  if (!response.ok || !response.body) {
    const text = response.body ? await response.text().catch(() => "") : "";
    return {
      answer: "",
      source: "",
      elapsedMs: 0,
      citations: [],
      error: `brain HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result: BrainResult = {
    answer: "",
    source: "rag",
    elapsedMs: 0,
    citations: [],
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const evtBlock = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const line = evtBlock.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const ev = normaliseEvent(parsed);
        if (!ev) continue;

        switch (ev.type) {
          case "log":
            opts.onLog?.(ev.line);
            break;
          case "source":
            result.source = ev.source;
            opts.onSource?.(ev.source);
            break;
          case "citations":
            result.citations = ev.citations;
            opts.onCitations?.(ev.citations);
            break;
          case "diagnostics":
            result.diagnostics = {
              bestScore: ev.bestScore,
              elapsedMs: ev.elapsedMs,
              ragHits: ev.ragHits,
            };
            opts.onDiagnostics?.(result.diagnostics);
            break;
          case "chunk":
            result.answer += ev.text;
            opts.onChunk?.(ev.text);
            break;
          case "done":
            result.elapsedMs = ev.elapsedMs;
            break;
          case "error":
            result.error = ev.message;
            break;
        }
      }
    }
  } catch (err) {
    result.error = `stream error: ${(err as Error).message}`;
  }

  return result;
}

function normaliseEvent(raw: any): BrainEvent | null {
  switch (raw?.type) {
    case "log":
      return { type: "log", line: String(raw.line ?? "") };
    case "source":
      return { type: "source", source: String(raw.source ?? "") };
    case "citations":
      return {
        type: "citations",
        citations: Array.isArray(raw.citations)
          ? raw.citations.map((c: any) => ({
              id: String(c.id ?? ""),
              title: c.title ? String(c.title) : undefined,
              score: Number(c.score ?? 0),
            }))
          : [],
      };
    case "diagnostics":
      return {
        type: "diagnostics",
        bestScore: Number(raw.bestScore ?? 0),
        elapsedMs: Number(raw.elapsedMs ?? 0),
        ragHits: Number(raw.ragHits ?? 0),
      };
    case "chunk":
      return { type: "chunk", text: String(raw.text ?? "") };
    case "done":
      return {
        type: "done",
        answer: String(raw.answer ?? ""),
        elapsedMs: Number(raw.elapsedMs ?? 0),
        source: String(raw.source ?? ""),
      };
    case "error":
      return { type: "error", message: String(raw.message ?? "unknown error") };
    default:
      return null;
  }
}
