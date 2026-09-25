/**
 * LLM reducer — the LLM does TWO jobs in one pass:
 *   1. JUDGE: is the brain's draft answer useful?
 *   2. REFINE: rewrite it to remove filler and answer directly.
 *
 * Used by the `glm_reducer` tool inside ChatGraph's `refine_answer` node.
 */

import { getConfig } from "./config";

const OPENCODE_GATEWAY = "https://opencode.ai/zen/go/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 25_000;

const REDUCER_SYSTEM_PROMPT = `You are a strict editor + judge for a customer-support chatbot.

You are given: (a) the user's current question, (b) the chatbot's draft answer from the knowledge base, and (c) the recent conversation history (user + assistant turns, oldest first).

Your job:

1. JUDGE whether the draft is a real, useful response to the CURRENT question.

   - GOOD:    draft directly answers the current question with concrete info (facts, steps, citations, links), OR the question is answerable from the conversation history (e.g. "what was my first question?", "what did you just say?", "can you repeat that?") and the draft either answers it or can be replaced with the history-derived answer.
   - NO_ANSWER: draft is empty, evasive, says "I don't know", says "no information", asks the user to contact support, or is otherwise not useful AND the conversation history does not contain the answer either.

   IMPORTANT: When the user asks a meta-question about the conversation itself ("what was my first question", "what did I ask earlier", "what was the last thing you said", "repeat your previous answer"), the answer comes from the CONVERSATION HISTORY, not from the knowledge-base draft. If the draft talks about something unrelated to the conversation (e.g. it's a retrieved note that doesn't match the meta-question), treat the draft as wrong and REPLACE the text with the correct answer derived from the history.

2. If GOOD, REWRITE the answer for the end user. STRICTLY REMOVE ALL of these — the rules are broad by design; when in doubt, cut it:

   ANY reference to the knowledge base, notes, documents, or source (ban all of these and any close paraphrase):
   - "Based on your notes…", "Based on your saved notes…", "Based on the provided context…"
   - "According to the provided context…", "According to your notes…"
   - "Looking at your documents…", "Looking at your notes…"
   - "Your notes show…", "Your notes contain…", "Your notes don't include…", "Your notes have…", "Your notes mention…", "Your notes lack…", "Your notes are…"
   - "Your saved …", "Your documents …", "Your library …", "Your exercise library …"
   - "Here's the routine structure your document suggests…"
   - "Here is what I found…", "Here's what I found…"
   - ANY sentence containing the word "notes", "documents", "library", "saved reels", "saved videos" when used to reference the source.
   - Any sentence whose only purpose is to acknowledge the source.

   Internal citations (ban these — end users don't need them):
   - "[Document: …]" / "[1]" / "[2]" / etc.
   - "Source: …", "Reference: …", "From: …"

   Speculation and editorializing (ban these):
   - "Suggested split: …", "You could rotate these by day…"
   - "I would suggest…", "It is recommended that…"
   - "A common approach is…" (unless the source explicitly states it)
   - Any sentence that adds advice the source didn't explicitly give.

   Caveat / disclaimer outros (ban these):
   - "Note: …" / "Note that…"
   - "you'd need to decide…"
   - "I hope this helps!" / "Let me know if you have more questions!"
   - "Feel free to ask…"
   - "Let me know if you need anything else!"

   Decorative emoji in section headers (ban these):
   - "## 💪 Arms" → "## Arms"

   KEEP:
   - Concrete exercise names, steps, lists, citations to external videos/links.
   - Markdown formatting (##, **, lists).
   - Original section structure.
   - For meta-questions about the conversation, the actual content from history (e.g. quote the user's first question verbatim).

   Do NOT add new information. Do NOT invent. Do NOT speculate.
   Do NOT mention "notes", "documents", "library", or "saved" anywhere in the output.

3. If NO_ANSWER (draft is not useful AND history doesn't help), set text to: "NO_ANSWER" (literally that string).

Output STRICT JSON, no preamble, no markdown fence:
{"verdict":"good|no_answer","text":"<refined answer or NO_ANSWER>","reason":"<one short sentence>"}`;

export interface RefinedAnswer {
  verdict: "good" | "no_answer";
  text: string;
  reason: string;
  elapsedMs: number;
  /** Set when the LLM API was unreachable and we used a heuristic. */
  usedFallback?: boolean;
}

export async function refineAnswer(
  question: string,
  draft: string,
  history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<RefinedAnswer> {
  const start = Date.now();
  const { opencodeApiKey, opencodeModel } = getConfig();
  const apiKey = opencodeApiKey;

  if (!apiKey) {
    return heuristicRefine(question, draft, start, "no key");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // Render the conversation history as a readable block for the LLM.
  // Only the last ~10 turns to keep the prompt small.
  const recentHistory = history.slice(-10);
  const historyBlock =
    recentHistory.length > 0
      ? recentHistory
          .map((h) => `  ${h.role}: ${h.content.slice(0, 800)}`)
          .join("\n")
      : "(no prior conversation)";

  try {
    const response = await fetch(OPENCODE_GATEWAY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-opencode-session": crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: opencodeModel,
        messages: [
          { role: "system", content: REDUCER_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Conversation history (oldest first):\n${historyBlock}\n\n` +
              `Current question:\n${question}\n\n` +
              `Draft answer from knowledge base:\n${draft}`,
          },
        ],
        max_tokens: 2048,
        temperature: 0,
        stream: false,
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return heuristicRefine(question, draft, start, `HTTP ${response.status}`);
    }

    const data: any = await response.json();
    const raw: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      "";
    const text = raw.trim();
    if (!text) {
      return heuristicRefine(question, draft, start, "empty LLM response");
    }

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return heuristicRefine(question, draft, start, "non-JSON response");
    }

    const verdict: "good" | "no_answer" =
      parsed?.verdict === "no_answer" ? "no_answer" : "good";
    let finalText: string = String(parsed?.text ?? "").trim();

    if (verdict === "no_answer" || finalText.toUpperCase() === "NO_ANSWER") {
      return {
        verdict: "no_answer",
        text: "NO_ANSWER",
        reason: String(parsed?.reason ?? "no answer"),
        elapsedMs: Date.now() - start,
      };
    }

    if (!finalText) {
      return heuristicRefine(question, draft, start, "empty text field");
    }

    // SAFETY NET: even when the LLM says "good", run the deterministic
    // stripSourceReferences on its output. This catches any "Your notes
    // contain…" or "[Document: …]" that slipped through the LLM's filter.
    finalText = stripSourceReferences(finalText);
    if (!finalText) {
      // If stripping removed everything, fall back to no_answer.
      return {
        verdict: "no_answer",
        text: "NO_ANSWER",
        reason: "stripped to empty",
        elapsedMs: Date.now() - start,
      };
    }

    return {
      verdict: "good",
      text: finalText,
      reason: String(parsed?.reason ?? "ok"),
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timer);
    return heuristicRefine(question, draft, start, (err as Error).message);
  }
}

function heuristicRefine(
  question: string,
  draft: string,
  start: number,
  reason: string,
): RefinedAnswer {
  const elapsedMs = Date.now() - start;
  const trimmed = draft.trim();

  if (trimmed.length < 20) {
    return {
      verdict: "no_answer",
      text: "NO_ANSWER",
      reason: `too short (${reason})`,
      elapsedMs,
      usedFallback: true,
    };
  }
  const lower = trimmed.toLowerCase();
  const NO_ANSWER_MARKERS = [
    "i don't have that",
    "i do not have that",
    "no information",
    "not in my knowledge",
    "i'm not sure",
    "please contact",
    "contact support",
    "i cannot help",
    "i can't help",
    "i don't know",
    "i do not know",
  ];
  if (NO_ANSWER_MARKERS.some((m) => lower.includes(m))) {
    return {
      verdict: "no_answer",
      text: "NO_ANSWER",
      reason: `marker (${reason})`,
      elapsedMs,
      usedFallback: true,
    };
  }
  return {
    verdict: "good",
    text: regexStripFiller(trimmed),
    reason: `heuristic pass (${reason})`,
    elapsedMs,
    usedFallback: true,
  };
}

function regexStripFiller(text: string): string {
  const FILLER_PATTERNS = [
    /^Based on (?:your|the provided) [^,.]+,\s*/i,
    /^According to (?:the )?(?:provided |your )?[^,.]+,\s*/i,
    /^Looking at (?:your|the) [^,.]+,\s*/i,
    /^Here's (?:the |a )?(?:routine|answer|summary|breakdown) [^:]*:\s*/i,
    /\n*I hope this helps!?\s*$/i,
    /\n*Let me know if you have (?:any |more )questions!?\s*$/i,
    /\n*Feel free to (?:ask|reach out)[^.]*[.!]?\s*$/i,
  ];
  let cleaned = text.trim();
  for (const p of FILLER_PATTERNS) {
    cleaned = cleaned.replace(p, "");
  }
  // Final safety net: strip any line that references the source
  // (notes, documents, library, saved reels, etc.) even if the LLM
  // missed it. This catches "Your notes contain no leg exercises…"
  // and similar leaks.
  cleaned = stripSourceReferences(cleaned);
  return cleaned.trim();
}

/**
 * Deterministic post-processing: remove any line or trailing clause
 * that references the knowledge base / notes / documents / library.
 * This is a SAFETY NET — runs even on the LLM's "good" output so
 * nothing leaks through to the end user.
 *
 * Removes:
 *   - Whole lines starting with "Your notes", "Your documents",
 *     "Your library", "Your saved", "Based on your", "According to",
 *     "Looking at your", "Note:", "Note that".
 *   - Trailing sentences (after a period) containing those phrases.
 *   - "[Document: …]" / "[1]" / "[2]" style citations.
 */
function stripSourceReferences(text: string): string {
  // 1. Remove [Document: ...], [1], [2] etc.
  let out = text.replace(/\[(?:Document:\s*)?[^\]]+\]/g, "");

  // 2. Remove whole lines that are clearly source-referencing.
  const lineBanRe = /^\s*(?:your\s+(?:notes?|documents?|library|saved|exercise library)|based on your|according to (?:the |your )|looking at your|note\s*:|note that)\b.*$/im;
  out = out
    .split("\n")
    .filter((line) => !lineBanRe.test(line))
    .join("\n");

  // 3. Remove trailing sentences (separated by . or ; or —) that
  //    reference notes/documents/library. Catches inline leaks like
  //    "...A common approach is Push/Pull alternated 3–4x/week, adding a leg day. Your notes contain no leg exercises, no sets/reps schemes, and no training frequency, so exact numbers can't be given."
  const sentenceBanRe = /(?:[.;—]\s*|^\s*)(?:your\s+(?:notes?|documents?|library|saved|exercise library)|the\s+(?:notes?|documents?|library)\s+(?:contain|show|include|lack|have|mention))\b[^.]*\.?/gi;
  out = out.replace(sentenceBanRe, "");

  // 4. Clean up: collapse 3+ newlines to 2, trim trailing whitespace per line.
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");

  return out.trim();
}
