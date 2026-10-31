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
const { LETTA_API_KEY, LETTA_AGENT_ID, LETTA_BASE_URL } = process.env;
if (!LETTA_API_KEY || !LETTA_AGENT_ID) {
    process.stderr.write("letta-acp: LETTA_API_KEY and LETTA_AGENT_ID environment variables are required.\n");
    process.exit(1);
}
const letta = new Letta({
    apiKey: LETTA_API_KEY,
    ...(LETTA_BASE_URL ? { baseURL: LETTA_BASE_URL } : {}),
});
/** Per-session cancel flag, keyed by ACP session id (= conversation id). */
const cancelled = new Map();
function log(msg) {
    process.stderr.write(`letta-acp: ${msg}\n`);
}
/** Extract text from Letta message content (string or content-block array). */
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => c && typeof c === "object" && c.type === "text"
            ? String(c.text ?? "")
            : "")
            .join("");
    }
    return "";
}
const app = acp.agent({ name: "letta-acp" });
app.onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
    },
    authMethods: [],
    agentInfo: {
        name: "letta-acp",
        title: "Letta ACP adapter",
        version: "0.1.0",
    },
}));
app.onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const conv = await letta.conversations.create({
        agent_id: LETTA_AGENT_ID,
    });
    cancelled.set(conv.id, false);
    log(`session/new -> conversation ${conv.id}`);
    return { sessionId: conv.id };
});
app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const sessionId = ctx.params.sessionId;
    cancelled.set(sessionId, false);
    const text = ctx.params.prompt
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    const update = (u) => ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: u,
    });
    /** toolCallId -> name, for pairing tool_call_update to its tool_call. */
    const toolCalls = new Map();
    let stopReason = "end_turn";
    try {
        const stream = await letta.conversations.messages.create(sessionId, {
            messages: [{ role: "user", content: [{ type: "text", text }] }],
            streaming: true,
        });
        for await (const event of stream) {
            if (cancelled.get(sessionId) || ctx.signal.aborted) {
                stopReason = "cancelled";
                break;
            }
            const mt = event?.message_type;
            switch (mt) {
                case "assistant_message": {
                    const t = textFromContent(event.content);
                    if (t) {
                        await update({
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: t },
                        });
                    }
                    break;
                }
                case "reasoning_message": {
                    const t = event.reasoning ?? "";
                    if (t) {
                        await update({
                            sessionUpdate: "agent_thought_chunk",
                            content: { type: "text", text: t },
                        });
                    }
                    break;
                }
                case "tool_call_message": {
                    const e = event;
                    const calls = e.tool_call
                        ? [e.tool_call]
                        : Array.isArray(e.tool_calls)
                            ? e.tool_calls
                            : Array.isArray(e.tool_calls?.tool_calls)
                                ? e.tool_calls.tool_calls
                                : [];
                    for (const c of calls) {
                        const id = c.tool_call_id ?? c.id ?? `tc-${Date.now()}`;
                        const name = c.name ?? "tool";
                        toolCalls.set(id, name);
                        let rawInput = c.arguments;
                        if (typeof rawInput === "string") {
                            try {
                                rawInput = JSON.parse(rawInput);
                            }
                            catch {
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
                    const e = event;
                    const id = e.tool_call_id ?? [...toolCalls.keys()].pop() ?? "unknown";
                    const ok = e.status !== "error";
                    const out = typeof e.tool_return === "string"
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
                    const r = event.stop_reason ?? event.stopReason;
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
        return { stopReason };
    }
    catch (err) {
        if (cancelled.get(sessionId))
            return { stopReason: "cancelled" };
        // Surface the failure in-stream, then fail the request so the client
        // sees a JSON-RPC error rather than a silent hang.
        await update({
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `\n[letta-acp error: ${err?.message ?? String(err)}]`,
            },
        }).catch(() => { });
        throw err;
    }
});
app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    cancelled.set(params.sessionId, true);
    log(`session/cancel ${params.sessionId}`);
    try {
        await letta.conversations.cancel(params.sessionId);
    }
    catch (err) {
        log(`cancel call failed (continuing locally): ${err?.message ?? err}`);
    }
});
// stdio transport — protocol on stdout, logs on stderr.
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
log("connected on stdio (ACP v1 stable)");
