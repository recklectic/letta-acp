# letta-acp

ACP (Agent Client Protocol) adapter that bridges ACP clients — Zed, T3 Code,
anything speaking [ACP v1](https://agentclientprotocol.com) — to a Letta
agent over stdio.

One binary, three env vars, no auth dance. Each ACP session creates a fresh
Letta conversation; the conversation id *is* the ACP session id.

## Wire it into T3 Code (Local ACP)

Clone this repo somewhere stable, install deps, then open T3 Code →
**Settings → Local ACP** and fill the command dialog:

| Dialog field | Fill |
|---|---|
| **Executable** | `node` |
| **Arguments** (one per row) | `C:\path\to\letta-acp\dist\index.js` |
| **Variables** | `LETTA_API_KEY` → *(your Letta API key)* |
| | `LETTA_AGENT_ID` → *(the agent to attach, e.g. `agent-…`)* |

Notes:

- Arguments are literal, one per row — no shell expansion, no quoting games.
- `node` must be on PATH (or use the full path to `node.exe`).
- `dist/index.js` is committed, so no build step is needed after `npm install`.
- Optional: `LETTA_BASE_URL` → `https://api.letta.com` (the default); set it
  only if you're pointing at a different Letta server.

Save, and the agent appears as an ACP provider in T3's agent picker.

## Setup

```bash
git clone git@github.com:recklectic/letta-acp.git
cd letta-acp
npm install          # runtime deps (@agentclientprotocol/sdk, @letta-ai/letta-client)
npm run build        # only needed if you edit src/ (dist/ is committed)
```

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LETTA_API_KEY` | yes | Letta API token |
| `LETTA_AGENT_ID` | yes | Agent the adapter attaches to |
| `LETTA_BASE_URL` | no | Defaults to `https://api.letta.com` |

The adapter advertises **no auth methods** — the env credential *is* the auth.

## Protocol mapping (ACP v1 stable → Letta)

| ACP | Letta | Notes |
|---|---|---|
| `initialize` | — | static agent info; `loadSession: false` |
| `session/new` | `POST /v1/conversations` | new conversation per session |
| `session/prompt` | `POST /v1/conversations/{id}/messages` (SSE) | see event map below |
| `session/cancel` | `POST /v1/conversations/{id}/cancel` + local flag | stream loop stops on next event |

Stream events → `session/update` notifications:

| Letta SSE event | ACP `SessionUpdate` |
|---|---|
| `assistant_message` | `agent_message_chunk` |
| `reasoning_message` | `agent_thought_chunk` |
| `tool_call_message` | `tool_call` (`in_progress`) |
| `tool_return_message` | `tool_call_update` (`completed` / `failed`) |
| `stop_reason` | maps to the `PromptResponse.stopReason` (`end_turn`, `max_tokens`, …) |
| `ping`, `usage_statistics`, system/user/hidden messages | not forwarded (v0) |

The Letta agent runs its **own** tools server-side — the adapter does no
filesystem or terminal proxying, and advertises no MCP capabilities.

## Tests

```bash
npm test
```

Builds the adapter and runs an ACP SDK client against its real stdio subprocess,
with a loopback-only mock Letta HTTP/SSE server. No credentials or inference are
needed. Tests cover initialization/session creation, v1 negotiation after a v2
version offer, text/thought/tool/result/final-text ordering, empty failed tool
results, token limits, HTTP errors, and bounded failure on a stalled request.
These are synthetic fixtures, not a reproduction of T3's exact traffic.

The shared test client records wire order, reports update types immediately,
and closes the adapter on request timeout. The SDK decodes inbound notifications;
explicit assertions check responses and expected content. This is regression
coverage, not a claim of complete ACP conformance or T3 compatibility.

### Live session-only probe (opt-in)

With `LETTA_API_KEY` and `LETTA_AGENT_ID` set:

```bash
npm run test:session
```

Runs only `initialize` and `session/new`, with a 15-second deadline per request.
It creates one real empty conversation and prints its ID; it does **not** send a
prompt or request inference. It uses the invoking shell's environment, not T3's
saved provider credentials. It leaves the empty conversation in place.

### Raw live prompt client (opt-in)

`test/test-client.mjs` speaks raw JSON-RPC over the adapter's stdio without SDK
schema checks. It is a diagnostic smoke client, not a spec-compliance validator:

```bash
LETTA_API_KEY=… LETTA_AGENT_ID=agent-… node test/test-client.mjs "hello"
```

It runs `initialize → session/new → session/prompt`, prints assistant text as it
arrives, then the final `stopReason` and buffered thought/tool transcript. Unlike
the SDK test client, this original smoke client has no timeout. It invokes the
configured live agent and consumes inference quota. `npm run test:live -- "hello"`
is an equivalent entry point.

## Known gaps (v0)

- **No `session/load`** — advertised `loadSession: false`; sessions can't be
  resumed across adapter restarts yet (the conversation id would make this
  straightforward later).
- **No `session/list` / `session/delete`** — not implemented.
- **Cancel is best-effort** — the Letta cancel call fires, and the stream loop
  stops at the next event boundary; there's no mid-event abort.
- **Text-only prompts** — `image`, `audio`, `embeddedContext` advertised as
  unsupported; non-text content blocks in a prompt are dropped.
- **No usage forwarding** — Letta usage statistics arrive but aren't mapped to
  ACP `usage_update`.
- **No `stream_tokens`** — messages stream per-step (whole messages), not
  per-token. Token-level streaming is a flag away if wanted.

## Layout

```
src/index.ts          adapter (authoritative source)
dist/index.js         compiled output (committed for zero-build wiring)
test/test-client.mjs  raw JSON-RPC test client
test/sdk-client.mjs   bounded SDK subprocess client shared by tests/probe
test/protocol.test.mjs offline HTTP/SSE fixture regression tests
test/session-probe.mjs opt-in live session creation, no inference
```
