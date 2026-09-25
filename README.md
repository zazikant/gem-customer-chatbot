# GEM Customer Chatbot — LangGraph Live

A conversational customer-support chatbot rebuilt on **LangGraph.js**, faithfully implementing the sequence diagram:

```
participant U as User
participant NX as Next.js /api/chat (App Router)
participant LG1 as LeadCaptureGraph
participant LG2 as ChatGraph
participant BRAIN as Chat-Brain (RAG SSE)
participant JUDGE as GLM-5.1 (Judge/Rewriter)
participant DB as CSV_CHAT_BASE (email PK merge)
```

The original repo (in `source-repo/` for reference) was a flat
`/api/chat` route with function calls. This remake splits the flow
into **two LangGraph state machines**:

| Graph | Tools | Reducers | HITL | Checkpointer | Edges |
|-------|-------|----------|------|--------------|-------|
| `LeadCaptureGraph` (LG1) | none | none | no | no | hardcoded only |
| `ChatGraph` (LG2) | `brain_proxy`, `glm_reducer`, `contacts_upsert`, `contacts_update_field` | none | no | no | conditional (deterministic) |

> **No HITL / checkpointer / time-travel** — both graphs are
> stateless per request. State lives in the client (`captureState` +
> `lead`) and is replayed on every POST.

---

## Flow

### Phase 1 — LeadCaptureGraph (LG1)

Triggered when `captureState.status != "complete"`.

```
START → validate_input →─→ update_partial →─→ complete_lead → generate_bot_message → END
                        │                  └──(not last)──────────────────────────┘
                        └─(invalid)─→ handle_retry ─────────────────────────────────┘
```

Nodes (all hardcoded edges, no LLM):

1. **`validate_input`** — runs `validateField(current, userMessage)`. Sets `validationOk`, `validatedValue`, `validationError`, `isLastField`.
2. **`update_partial`** — merges `validatedValue` into `partial`, advances `current` to next field. Emits `capture` SSE event.
3. **`complete_lead`** — finalizes the `Lead` object, sets `status: "complete"`. Emits `capture { status: "complete", lead }` SSE event.
4. **`handle_retry`** — sets `retrying: field`, `prompt: validationError`. Emits `capture` SSE event with retry flag.
5. **`generate_bot_message`** — picks the right bot message (next field prompt, retry error, or completion thank-you). Emits `bot` + `chat { phase }` SSE events.

### Phase 2 — ChatGraph (LG2)

Triggered when `captureState.status == "complete"`.

```
START → call_brain → refine_answer → decide_verdict →─→ emit_good   ──→ persist_turn → detect_late_company → END
                       (or jump to emit_fallback       └─(no_answer)─→ emit_fallback ──┘
                        if brain errored with no answer)
```

Nodes (4 tools invoked explicitly — no agent loop, no ToolNode):

1. **`call_brain`** [`brain_proxy` tool] — POSTs to `CHAT_BRAIN_URL`, streams SSE chunks back to the client via `emit("chunk", ...)`. Arms a 2-min inactivity timer (resets on every event). Returns `BrainResult { answer, source, citations, diagnostics }`.
2. **`refine_answer`** [`glm_reducer` tool] — calls GLM-5.1 via OpenCode Zen gateway. Single LLM call does both jobs: **judge** (`good` / `no_answer`) and **rewrite** (strips filler intros like "Based on your notes…"). Returns `RefinedAnswer { verdict, text, reason, elapsedMs }`.
3. **`decide_verdict`** — sets `verdict = refined.verdict`. Forces `no_answer` if the brain itself errored.
4. **`emit_good`** — emits `done { answer, source, elapsedMs, isFallback: false }`. Sets final state.
5. **`emit_fallback`** — builds the "please contact our team" message with `BUSINESS_PHONE` + `BUSINESS_EMAIL`. Emits `fallback` + `done { isFallback: true }`.
6. **`persist_turn`** [`contacts_upsert` tool] — appends today's Q+A to the contact's `remarks` column in `csv-chat-vercel`. First-time → INSERT with `tags:["chatbot"]`, `source:["gem-chatbot"]`. Returning → server-side MERGE preserves existing fields.
7. **`detect_late_company`** [`contacts_update_field` tool] — regex-detects "I work at X" / "my company is X" in the user message and PATCHes the contact's `company` field if found.

Every node + tool invocation is recorded in a `GraphTrace` object
that's sent to the client via the `trace` SSE event. The UI renders
this trace in a side panel so you can watch the graph execute in
real time.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Chat UI + live LangGraph trace panel |
| GET | `/api/config` | Public non-secret config (business phone/email) |
| POST | `/api/chat` | SSE stream: dispatches to LG1 or LG2 based on `captureState.status` |

### Request shape (`POST /api/chat`)

```json
{
  "message":      "user's text",
  "history":      [...],
  "captureState": { "status": "capturing", "current": "name", "partial": {} },
  "lead":         { "name": "...", "email": "...", "phone": "...", "company": "..." }
}
```

### Response events (SSE)

| Event | When |
|-------|------|
| `log` | Debug line (hidden in UI, visible in devtools) |
| `bot` | Bot's reply text during capture |
| `capture` | After every capture-phase turn (status, current, partial, retrying, lead) |
| `chat` | Phase transition (`capture` → `chat`) |
| `contact-saved` | After initial contact write (LG1 completion) |
| `source` | `rag` / `llm` / `fallback` from the brain |
| `citations` | Documents cited by the brain |
| `diagnostics` | RAG diagnostics (bestScore, elapsedMs, ragHits) |
| `chunk` | Streamed answer token from the brain |
| `reducer` | GLM-5.1 verdict + reason + elapsedMs |
| `fallback` | Business-contact fallback payload |
| `done` | Final answer for this turn |
| `remarks-saved` | After persist_turn appends to remarks |
| `contact-updated` | Late company-name detection (detect_late_company) |
| `trace` | Full LangGraph execution trace (nodes + tools + timings) |
| `error` | Error message |

---

## Environment variables

All required vars are in `.env.local` (gitignored). Set them in
Vercel → Project → Settings → Environment Variables for production.

| Variable | Purpose |
|----------|---------|
| `OPENCODE_API_KEY` | GLM-5.1 reducer (judge + rewrite) via OpenCode Zen gateway |
| `OPENCODE_MODEL` | Model alias (default: `glm-5.1`) |
| `CHAT_BRAIN_URL` | Upstream chat-brain SSE endpoint |
| `CSV_CHAT_BASE` | csv-chat-vercel base URL (leads + remarks persistence) |
| `BUSINESS_PHONE` | Display phone in fallback bubble |
| `BUSINESS_PHONE_RAW` | `tel:` link target |
| `BUSINESS_EMAIL` | Display + `mailto:` link email |
| `CHAT_INACTIVITY_MS` | Server-side brain inactivity timeout (default: 120000) |

---

## File layout

```
src/
├── app/
│   ├── api/
│   │   ├── chat/route.ts        # SSE dispatcher → LG1 or LG2
│   │   └── config/route.ts      # Public non-secret config
│   ├── layout.tsx
│   ├── page.tsx                 # Chat UI + trace panel (client)
│   └── globals.css
├── components/
│   └── chat/
│       └── trace-panel.tsx      # Live LangGraph execution trace
└── lib/
    ├── graphs/
    │   ├── types.ts                 # GraphTrace + traceNode/traceTool helpers
    │   ├── tools.ts                 # 4 LangGraph tools (brain_proxy, glm_reducer, contacts_upsert, contacts_update_field)
    │   ├── lead-capture-graph.ts    # LG1 — no tools, no reducers, hardcoded edges
    │   └── chat-graph.ts            # LG2 — 4 tools, no HITL, no checkpointer
    ├── brain-client.ts          # callBrain() — SSE consumer for upstream brain
    ├── reducer.ts               # refineAnswer() — GLM-5.1 judge + rewrite
    ├── contacts.ts              # csv-chat-vercel POST/PUT/GET
    ├── lead-capture.ts          # Pure validators + state types
    └── config.ts                # Env-var loader (fails fast)
```

---

## Local development

```bash
bun install
cp .env.local.example .env.local   # fill in the 7 required vars
bun run dev                         # http://localhost:3000
```

Open the app, complete the 4-step capture conversation
(name → email → phone → company), then ask real questions. The
right-hand trace panel shows every LangGraph node + tool call.

---

## Architecture notes

### Why two graphs?

Lead capture is a strict deterministic flow — no LLM, no tools, no
branching beyond "valid/invalid". Keeping it in its own graph
makes the contract explicit and lets the chat route dispatch in
O(1) based on `captureState.status`.

### Why tools (not just function calls)?

The 4 ChatGraph tools are registered via `tool()` from
`@langchain/core/tools` so they have stable names + schemas. They're
invoked explicitly from inside nodes (no agent loop, no ToolNode) —
this honors the diagram's "no HITL / checkpointer / time-travel"
constraint while still getting traceability per tool call.

### Why no checkpointer?

A checkpointer (MemorySaver) would let the graph resume mid-execution
across requests — useful for HITL flows. We don't need that: every
request runs the graph to completion in one shot. State lives in the
client (`captureState` + `lead` + `history`) and is replayed on every
POST. This keeps the server stateless and the architecture simple.

### Live SSE streaming inside a graph node

LangGraph nodes are async functions that return a partial state
update — they don't naturally emit intermediate events. The
`call_brain` node solves this by holding an `emit` callback in graph
state (non-serializable, but fine because there's no checkpointer).
The brain's SSE chunks are forwarded to the client immediately via
`emit("chunk", ...)`, while the node also accumulates them into
`brainResult.answer` for downstream nodes to consume. This is the
"Live LangGraph conversion" pattern referenced in the diagram.

---

## Security

- No secrets are committed — `.env.local` and `.env*.local` are gitignored.
- `OPENCODE_API_KEY` is read server-side only; never sent to the browser.
- The browser only receives the non-secret business contact via `/api/config`.
- All upstream calls (brain, GLM-5.1, csv-chat-vercel) happen server-side.

---

## License

Private. © Shashikant Zarekar.
