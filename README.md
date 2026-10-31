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

## Test client

`test/test-client.mjs` speaks raw JSON-RPC over the adapter's stdio — no SDK,
bytes on the wire — so it doubles as a spec-compliance check:

```bash
LETTA_API_KEY=… LETTA_AGENT_ID=agent-… node test/test-client.mjs "hello"
```

It runs `initialize → session/new → session/prompt`, prints every
`session/update` as it arrives, then the final `stopReason` and transcript.

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
```
