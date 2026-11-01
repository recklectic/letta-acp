#!/usr/bin/env node
/**
 * letta-acp — ACP (Agent Client Protocol) adapter for Letta agents.
 *
 * Bridges ACP clients (Zed, T3 Code, ...) over stdio JSON-RPC to a Letta
 * Cloud agent via the official Letta client.
 *
 * Configuration (environment):
 *   LETTA_API_KEY    required  Letta API token
 *   LETTA_AGENT_ID   required  agent to attach (e.g. agent-xxxx)
 *   LETTA_BASE_URL   optional  default https://api.letta.com
 *
 * Protocol mapping (ACP v1 stable):
 *   initialize      -> static agent info, no auth methods, no loadSession
 *   session/new     -> POST /v1/conversations (new conversation; the
 *                      conversation id IS the ACP session id)
 *   session/prompt  -> POST /v1/conversations/{id}/messages (streaming SSE),
 *                      events forwarded as session/update notifications:
 *                        assistant_message -> agent_message_chunk
 *                        reasoning_message -> agent_thought_chunk
 *                        tool_call_message -> tool_call
 *                        tool_return_message -> tool_call_update
 *   session/cancel  -> POST /v1/conversations/{id}/cancel + local flag
 *
 * stdout is the protocol. All logging goes to stderr.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Letta } from "@letta-ai/letta-client";
import { T3Mcp } from "./t3-mcp.js";

const { LETTA_API_KEY, LETTA_AGENT_ID, LETTA_BASE_URL } = process.env;

if (!LETTA_API_KEY || !LETTA_AGENT_ID) {
  process.stderr.write(
    "letta-acp: LETTA_API_KEY and LETTA_AGENT_ID environment variables are required.\n"
  );
  process.exit(1);
}

const letta = new Letta({
  apiKey: LETTA_API_KEY,
  ...(LETTA_BASE_URL ? { baseURL: LETTA_BASE_URL } : {}),
});

/** Per-session cancel flag, keyed by ACP session id (= conversation id). */
const cancelled = new Map<string, boolean>();
const sessionMcp = new Map<string, T3Mcp>();

function log(msg: string): void {
  process.stderr.write(`letta-acp: ${msg}\n`);
}

/** Extract text from Letta message content (string or content-block array). */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as any).type === "text"
          ? String((c as any).text ?? "")
          : ""
      )
      .join("");
  }
  return "";
}

function eventCalls(event: any): any[] {
  if (Array.isArray(event.tool_calls)) return event.tool_calls;
  if (Array.isArray(event.tool_calls?.tool_calls)) return event.tool_calls.tool_calls;
  return event.tool_call ? [event.tool_call] : [];
}

const app = acp.agent({ name: "letta-acp" });

app.onRequest(acp.methods.agent.initialize, async () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: true, sse: false },
  },
  authMethods: [],
  agentInfo: {
    name: "letta-acp",
    title: "Letta ACP adapter",
    version: "0.1.0",
  },
}));

app.onRequest(acp.methods.agent.session.new, async ({ params }) => {
  const server = params.mcpServers.find((s) => "type" in s && s.type === "http" && s.name === "t3-code");
  const mcp = server && "type" in server && server.type === "http" ? await T3Mcp.connect(server) : undefined;
  try {
  const conv = await letta.conversations.create({
    agent_id: LETTA_AGENT_ID as string,
  });
  cancelled.set(conv.id, false);
  if (mcp) sessionMcp.set(conv.id, mcp);
  log(`session/new -> conversation ${conv.id}`);
  return { sessionId: conv.id };
  } catch (error) { await mcp?.close(); throw error; }
});

app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
  const sessionId = ctx.params.sessionId;
  cancelled.set(sessionId, false);

  const text = ctx.params.prompt
    .filter((b) => b.type === "text")
    .map((b) => (b as acp.TextContent).text)
    .join("\n");

  const update = (u: acp.SessionUpdate) =>
    ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: u,
    });

  /** toolCallId -> name, for pairing tool_call_update to its tool_call. */
  const toolCalls = new Map<string, string>();

  let stopReason: acp.StopReason = "end_turn";

  try {
    const mcp = sessionMcp.get(sessionId);
    let messages: any[] = [{ role: "user", content: [{ type: "text", text }] }];
    while (true) {
    const approvals: any[] = [];
    let letTaStop: string | undefined;
    const stream = await letta.conversations.messages.create(sessionId, {
      messages, streaming: true, ...(mcp ? { client_tools: mcp.tools } : {}),
    });

    for await (const event of stream) {
      if (cancelled.get(sessionId) || ctx.signal.aborted) {
        stopReason = "cancelled";
        break;
      }
      const mt = (event as any)?.message_type;
      switch (mt) {
        case "approval_request_message": {
          approvals.push(...eventCalls(event));
          break;
        }
        case "assistant_message": {
          const t = textFromContent((event as any).content);
          if (t) {
            await update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: t },
            });
          }
          break;
        }
        case "reasoning_message": {
          const t = (event as any).reasoning ?? "";
          if (t) {
            await update({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: t },
            });
          }
          break;
        }
        case "tool_call_message": {
          const e = event as any;
          const calls: any[] = e.tool_call
            ? [e.tool_call]
            : Array.isArray(e.tool_calls)
              ? e.tool_calls
              : Array.isArray(e.tool_calls?.tool_calls)
                ? e.tool_calls.tool_calls
                : [];
          for (const c of calls) {
            const id: string = c.tool_call_id ?? c.id ?? `tc-${Date.now()}`;
            const name: string = c.name ?? "tool";
            toolCalls.set(id, name);
            let rawInput: unknown = c.arguments;
            if (typeof rawInput === "string") {
              try {
                rawInput = JSON.parse(rawInput);
              } catch {
                /* keep raw string */
              }
            }
            await update({
              sessionUpdate: "tool_call",
              toolCallId: id,
              title: name,
              name,
              kind: "other",
              status: "in_progress",
              rawInput,
            });
          }
          break;
        }
        case "tool_return_message": {
          const e = event as any;
          const id: string =
            e.tool_call_id ?? [...toolCalls.keys()].pop() ?? "unknown";
          const ok = e.status !== "error";
          const out =
            typeof e.tool_return === "string"
              ? e.tool_return
              : e.tool_return != null
                ? JSON.stringify(e.tool_return)
                : "";
          await update({
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: ok ? "completed" : "failed",
            content: out
              ? [
                  {
                    type: "content",
                    content: { type: "text", text: out.slice(0, 4000) },
                  },
                ]
              : null,
            rawOutput: e.tool_return,
          });
          break;
        }
        case "stop_reason": {
          const r = (event as any).stop_reason ?? (event as any).stopReason;
          letTaStop = r;
          if (r === "max_tokens" || r === "max_turn_requests") {
            stopReason = r;
          }
          break;
        }
        default:
          // ping / usage_statistics / system / user / hidden_* — not mapped
          break;
      }
    }
    if (cancelled.get(sessionId) || ctx.signal.aborted) { stopReason = "cancelled"; break; }
    if (letTaStop !== "requires_approval") break;
    if (!mcp || !approvals.length || approvals.some(c => !mcp.has(c.name))) {
      throw new Error("Letta requested approval for an unsupported tool; no tool was executed.");
    }
    const returns = [];
    for (const c of approvals) {
      let args: unknown = c.arguments ?? {};
      if (typeof args === "string") args = JSON.parse(args);
      if (!args || typeof args !== "object" || Array.isArray(args) || !c.tool_call_id) throw new Error("Invalid client tool call");
      const result = await mcp.call(c.name, args as Record<string, unknown>);
      returns.push({ type: "tool", tool_call_id: c.tool_call_id, ...result });
    }
    messages = [{ type: "tool_return", tool_returns: returns }];
    }
    return { stopReason };
  } catch (err: any) {
    if (cancelled.get(sessionId)) return { stopReason: "cancelled" };
    // Surface the failure in-stream, then fail the request so the client
    // sees a JSON-RPC error rather than a silent hang.
    await update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `\n[letta-acp error: ${err?.message ?? String(err)}]`,
      },
    }).catch(() => {});
    throw err;
  }
});

app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
  cancelled.set(params.sessionId, true);
  log(`session/cancel ${params.sessionId}`);
  try {
    await letta.conversations.cancel(params.sessionId);
  } catch (err: any) {
    log(`cancel call failed (continuing locally): ${err?.message ?? err}`);
  }
});

// stdio transport — protocol on stdout, logs on stderr.
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
);
app.connect(stream);
log("connected on stdio (ACP v1 stable)");
