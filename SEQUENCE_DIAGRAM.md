# GEM Customer Chatbot — Sequence Diagram

Live LangGraph conversion. Two state machines, no HITL, no checkpointer, no time-travel.

## Mermaid

```mermaid
sequenceDiagram
    participant U as User
    participant NX as Next.js /api/chat
    participant LG1 as LeadCaptureGraph
    participant LG2 as ChatGraph
    participant BRAIN as Chat-Brain RAG SSE
    participant JUDGE as GLM-5.1 or heuristic reducer
    participant DB as CSV_CHAT_BASE main_contacts

    Note over NX: Dispatches on captureState.status - Every graph invocation is stateless
    Note over LG1: No tools, no reducers, deterministic edges
    Note over LG2: Tool names are trace labels - underlying functions are called directly
    Note over LG2: No HITL, checkpointer, or time-travel

    U->>NX: POST message + captureState + lead + history + device

    alt captureState.status != "complete"
        NX->>LG1: invoke(captureState, userMessage)

        LG1->>LG1: validate_input

        alt input is valid
            LG1->>LG1: update_partial
            LG1-->>NX: SSE capture(partial, next field)

            alt last field is company
                LG1->>LG1: complete_lead
                LG1-->>NX: SSE capture(status=complete, lead)

                LG1->>LG1: generate_bot_message
                LG1-->>NX: SSE chat(phase=chat)
                LG1-->>NX: SSE bot(thank-you + help prompt)

                Note over NX,DB: Initial contact save starts after LG1 returns and is not awaited by /api/chat
                NX-)DB: contacts_upsert initial lead save
                DB-->>NX: optional SSE contact-saved (may arrive after stream close)

            else more fields remain
                LG1->>LG1: generate_bot_message
                LG1-->>NX: SSE chat(phase=capture)
                LG1-->>NX: SSE bot(next field prompt)
            end

        else input is invalid
            LG1->>LG1: handle_retry
            LG1-->>NX: SSE capture(retrying, validation error)

            LG1->>LG1: generate_bot_message
            LG1-->>NX: SSE bot(retry prompt)
        end

        NX-->>U: SSE events
        NX-->>U: SSE trace(LeadCaptureGraph)
        NX-->>U: close stream

    else captureState.status == "complete"
        NX->>LG2: invoke(query, history, lead, context)

        LG2->>BRAIN: call_brain [trace: brain_proxy]

        loop Each upstream SSE event
            BRAIN-->>LG2: log / source / citations / diagnostics / chunk
            LG2-->>NX: forward corresponding SSE event
        end

        BRAIN-->>LG2: BrainResult(answer, source, citations, diagnostics)

        alt brain errored and answer is empty
            Note over LG2: Skip refine_answer and decide_verdict
            LG2->>LG2: emit_fallback
            LG2-->>NX: SSE fallback(payload)
            LG2-->>NX: SSE done(isFallback=true)

        else brain returned an answer or partial answer
            LG2->>LG2: refine_answer [trace: glm_reducer]

            alt draft is empty
                Note over LG2: Reducer is skipped - refined verdict = no_answer
                LG2->>LG2: decide_verdict
            else draft is non-empty
                LG2->>JUDGE: judge + rewrite question, draft, history
                JUDGE-->>LG2: verdict(good or no_answer) + refined text
                LG2-->>NX: SSE reducer(verdict, reason, elapsedMs)

                LG2->>LG2: decide_verdict
                Note over LG2: Any brain error forces no_answer
            end

            alt verdict == "good"
                LG2->>LG2: emit_good
                LG2-->>NX: SSE done(refined answer, isFallback=false)
            else verdict == "no_answer"
                LG2->>LG2: emit_fallback
                LG2-->>NX: SSE fallback(payload)
                LG2-->>NX: SSE done(fallback answer, isFallback=true)
            end
        end

        Note over NX,U: Final answer is delivered before contact persistence completes

        alt lead is present
            LG2->>DB: persist_turn [trace: contacts_upsert]
            Note over DB: Find by email, then insert or merge remarks, tags, and source
            DB-->>LG2: contact write result
            LG2-->>NX: SSE remarks-saved

            alt query contains a new company name
                LG2->>DB: detect_late_company [trace: contacts_update_field]
                DB-->>LG2: field update result
                LG2-->>NX: SSE contact-updated(company)
            else no company pattern
                LG2->>LG2: skip late-company update
            end
        else lead is missing
            LG2->>LG2: skip persistence and company update
        end

        NX-->>U: SSE trace(ChatGraph)
        NX-->>U: close stream
    end
```

## Verification

This diagram was verified against the actual source code on 2026-09-26:

- **LG1 edges** (`src/lib/graphs/lead-capture-graph.ts`): `validate_input → (update_partial | handle_retry)`, `update_partial → (complete_lead | generate_bot_message)`, `complete_lead → generate_bot_message`, `handle_retry → generate_bot_message`, `generate_bot_message → END` ✓
- **LG2 `call_brain` routing** (`routeAfterCallBrain`): `if brain.error && !answer.trim() → emit_fallback, else → refine_answer` ✓
- **`refine_answer` empty-draft skip**: `if !raw → verdict=no_answer (skips LLM call)` ✓
- **`decide_verdict` override** (`decideVerdictNode`): `if brain.error → force no_answer` ✓
- **Initial contact save is fire-and-forget** (`/api/chat` route): `.then()` not awaited — `contact-saved` SSE may arrive after stream close ✓
- **SSE events match**: capture, chat, bot, source, citations, diagnostics, chunk, reducer, fallback, done, remarks-saved, contact-updated, contact-saved, trace ✓

## Graph structure

### LG1 — LeadCaptureGraph

```
START → validate_input →─→ update_partial →─→ complete_lead → generate_bot_message → END
                        │                  └──(not last)──────────────────────────┘
                        └─(invalid)─→ handle_retry ─────────────────────────────────┘
```

- **No tools, no reducers** (last-write-wins on every channel)
- **Hardcoded edges only** — branching is deterministic via `addConditionalEdges`
- 5 nodes: `validate_input`, `update_partial`, `complete_lead`, `handle_retry`, `generate_bot_message`

### LG2 — ChatGraph

```
START → call_brain → refine_answer → decide_verdict →─→ emit_good   ──→ persist_turn → detect_late_company → END
                       (or jump to emit_fallback       └─(no_answer)─→ emit_fallback ──┘
                        if brain errored with no answer)
```

- **4 tools**: `brain_proxy`, `glm_reducer`, `contacts_upsert`, `contacts_update_field` (trace labels — functions called directly from nodes)
- **No HITL / checkpointer / time-travel** — every request runs the graph to completion in one shot
- 7 nodes: `call_brain`, `refine_answer`, `decide_verdict`, `emit_good`, `emit_fallback`, `persist_turn`, `detect_late_company`

## Live SSE streaming

Brain chunks are forwarded to the client in real time via an `emit` callback held in graph state (non-serializable, but fine since there's no checkpointer). The user sees a "Thinking…" indicator while the brain + reducer work, then the final refined answer appears all at once — streaming chunks are accumulated internally and never rendered until the `done` event.

## Environment

| Variable | Default | When to set |
|-----------|---------|-------------|
| `CHAT_BRAIN_URL` | `https://tradingview-notes-app.vercel.app/api/brain/chat` | Only if you self-host the brain |
| `CSV_CHAT_BASE` | `https://csv-chat-vercel.vercel.app` | (Supabase creds below) |
| `OPENCODE_MODEL` | `glm-5.1` | Only if you want a different model |
| `CHAT_INACTIVITY_MS` | `120000` | Only if you want shorter/longer timeout |

Business contact (phone, email) is hardcoded in `src/lib/config.ts` — not an env var.
