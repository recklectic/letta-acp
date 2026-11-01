#!/usr/bin/env node
/**
 * letta-acp v1 — ACP (Agent Client Protocol) adapter for Letta agents.
 *
 * CLI-backed: each ACP prompt runs the Letta Code CLI headless
 * (`letta -p --output-format stream-json`) one-shot against the session's
 * conversation. The CLI is the harness — tools, memory, skills, persona all
 * run exactly as they do interactively. The adapter translates the CLI's
 * final result into ACP session updates.
 *
 * Wire shape (deliberate, per the v1 design record):
 *   - No mid-turn streaming: T3 shows its spinner, then the turn lands as
 *     one agent_message_chunk. The CLI cannot stream partial output to an
 *     ACP client without --input-format stream-json, which is rejected for
 *     Cloud agents.
 *   - No permission events: headless runs auto-execute tool calls.
 *
 * Orchestration (T3 MCP servers): the ACP session's mcpServers entry is
 * injected into the CLI process env as T3_MCP_URL / T3_MCP_BEARER_TOKEN
 * (the Pi pattern — env is session-scoped, no token file on disk), and a
 * one-shot helper script (t3.mjs) is dropped into the session workspace so
 * the agent can call orchestrator tools from its shell in one command.
 *
 * Configuration (environment):
 *   LETTA_API_KEY        required  Letta API token
 *   LETTA_AGENT_ID       required  agent to attach
 *   LETTA_BASE_URL       optional  default https://api.letta.com
 *   LETTA_ACP_CLI        optional  override: path to the CLI's JS entry
 *   LETTA_ACP_CWD        optional  fallback cwd when a session has none
 *   LETTA_ACP_TIMEOUT_MS optional  session API call bound (default 30000)
 *
 * stdout is the protocol. All logging goes to stderr.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
// Full v1 (stable + unstable): mcpServers on session params is unstable
// surface, and stable request parsing may strip it.
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Letta } from "@letta-ai/letta-client";
import { HELPER_SCRIPT } from "./helper.js";
import { resolveCli } from "./cli.js";
const { LETTA_API_KEY, LETTA_AGENT_ID, LETTA_BASE_URL } = process.env;
if (!LETTA_API_KEY || !LETTA_AGENT_ID) {
    process.stderr.write("letta-acp: LETTA_API_KEY and LETTA_AGENT_ID environment variables are required.\n");
    process.exit(1);
}
const letta = new Letta({
    apiKey: LETTA_API_KEY,
    ...(LETTA_BASE_URL ? { baseURL: LETTA_BASE_URL } : {}),
});
const MODES = [{ id: "default", name: "Default" }];
const MODE_STATE = { currentModeId: "default", availableModes: MODES };
/** ACP session id == Letta conversation id. */
const sessions = new Map();
function log(msg) {
    process.stderr.write(`letta-acp: ${msg}\n`);
}
function sessionTimeoutMs() {
    const n = Number(process.env.LETTA_ACP_TIMEOUT_MS);
    return n > 0 ? n : 30_000;
}
function withTimeout(p, ms, what) {
    return Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
    ]);
}
/** The T3 orchestrator endpoint + bearer, from the session's mcpServers. */
function pickMcpServer(servers) {
    if (!Array.isArray(servers))
        return null;
    const http = servers.filter((s) => !!s && typeof s === "object" && s.type === "http");
    if (!http.length)
        return null;
    const named = http.find((s) => s.name === "t3-code");
    const chosen = named ?? (http.length === 1 ? http[0] : undefined);
    if (!chosen) {
        log(`multiple http MCP servers (${http.map((s) => s.name).join(", ")}), none named t3-code — not injecting`);
        return null;
    }
    const headers = Array.isArray(chosen.headers)
        ? chosen.headers
        : [];
    const auth = headers.find((h) => String(h.name).toLowerCase() === "authorization");
    if (typeof chosen.url !== "string" || !auth || typeof auth.value !== "string") {
        log(`MCP server ${chosen.name} lacks url or Authorization header — not injecting`);
        return null;
    }
    return { url: chosen.url, token: auth.value.replace(/^Bearer\s+/i, "") };
}
function buildEnv(mcp) {
    return {
        ...process.env,
        ...(mcp ? { T3_MCP_URL: mcp.url, T3_MCP_BEARER_TOKEN: mcp.token } : {}),
    };
}
function dropHelper(cwd, mcp) {
    if (!mcp)
        return;
    try {
        fs.writeFileSync(path.join(cwd, "t3.mjs"), HELPER_SCRIPT);
        log("helper script dropped: t3.mjs");
    }
    catch (err) {
        log(`could not drop helper script (continuing): ${err?.message ?? err}`);
    }
}
function killTree(child) {
    if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    }
    else {
        child.kill("SIGTERM");
    }
}
const app = acp.agent({ name: "letta-acp" });
app.onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: false },
    },
    authMethods: [],
    agentInfo: {
        name: "letta-acp",
        title: "Ada — Letta agent",
        version: "1.0.0",
    },
}));
function sessionCwd(cwd) {
    return cwd || process.env.LETTA_ACP_CWD || process.cwd();
}
app.onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const mcp = pickMcpServer(params.mcpServers);
    const conv = await withTimeout(letta.conversations.create({ agent_id: LETTA_AGENT_ID }), sessionTimeoutMs(), "session/new");
    const cwd = sessionCwd(params.cwd);
    sessions.set(conv.id, { cwd, env: buildEnv(mcp), child: null, cancelled: false });
    dropHelper(cwd, mcp);
    log(`session/new -> conversation ${conv.id} (cwd ${cwd})`);
    return { sessionId: conv.id, modes: MODE_STATE };
});
app.onRequest(acp.methods.agent.session.load, async ({ params }) => {
    await withTimeout(letta.conversations.retrieve(params.sessionId), sessionTimeoutMs(), "session/load");
    const mcp = pickMcpServer(params.mcpServers);
    const cwd = sessionCwd(params.cwd);
    sessions.set(params.sessionId, { cwd, env: buildEnv(mcp), child: null, cancelled: false });
    dropHelper(cwd, mcp);
    log(`session/load -> conversation ${params.sessionId} (cwd ${cwd})`);
    return { modes: MODE_STATE };
});
app.onRequest(acp.methods.agent.session.setMode, async ({ params }) => {
    if (params.modeId !== "default")
        throw new Error(`unknown mode: ${params.modeId}`);
    return {};
});
app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const state = sessions.get(sessionId);
    if (!state)
        throw new Error("unknown session — call session/new or session/load first");
    if (state.child && state.child.exitCode === null) {
        throw new Error("a prompt is already in flight on this session");
    }
    const blocks = ctx.params.prompt;
    if (!blocks.every((b) => b.type === "text")) {
        log("prompt contained non-text blocks (not advertised); they were dropped");
    }
    const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    const cli = resolveCli();
    if (!cli) {
        throw new Error("could not resolve the letta CLI on PATH — set LETTA_ACP_CLI to its JS entry");
    }
    state.cancelled = false;
    const child = spawn(cli.command, [
        ...cli.args,
        "-p",
        "--agent",
        LETTA_AGENT_ID,
        "--conversation",
        sessionId,
        "--output-format",
        "stream-json",
        text,
    ], { cwd: state.cwd, env: state.env, stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    log(`spawned CLI (pid ${child.pid}) for ${sessionId}`);
    const update = (u) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update: u });
    return await new Promise((resolve, reject) => {
        let settled = false;
        let sawResult = false;
        const finish = (stopReason) => {
            if (settled)
                return;
            settled = true;
            state.child = null;
            resolve({ stopReason });
        };
        /**
         * Visible diagnostic chunk, then a JSON-RPC error. ACP v1's StopReason
         * enum has no "error" value — rejecting the request is the protocol's
         * failure channel; the chunk keeps the failure readable in the thread.
         */
        const errorFinish = (message) => {
            if (settled)
                return;
            settled = true;
            state.child = null;
            update({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `[letta-acp error: ${message}]` },
            })
                .catch(() => { })
                .then(() => reject(new Error(message)));
        };
        const handleResult = (obj) => {
            sawResult = true;
            if (obj.subtype === "error") {
                const err = obj.error;
                const message = typeof err === "string"
                    ? err
                    : err && typeof err === "object" && typeof err.message === "string"
                        ? err.message
                        : JSON.stringify(obj).slice(0, 300);
                errorFinish(`CLI turn failed: ${message}`);
                return;
            }
            const raw = obj.stop_reason;
            const stopReason = raw === "max_tokens" || raw === "max_turn_requests"
                ? raw
                : raw === "refused"
                    ? "refusal"
                    : "end_turn";
            const resultText = typeof obj.result === "string" ? obj.result : "";
            if (resultText) {
                update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: resultText },
                })
                    .catch(() => { })
                    .then(() => finish(stopReason));
            }
            else {
                finish(stopReason);
            }
        };
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line)
                    continue;
                let obj;
                try {
                    obj = JSON.parse(line);
                }
                catch {
                    log(`unparseable CLI stdout line: ${line.slice(0, 120)}`);
                    continue;
                }
                if (typeof obj.type !== "string")
                    continue; // receipt / untyped noise
                if (obj.type === "init") {
                    const bound = obj.conversation_id;
                    if (typeof bound === "string" && bound !== sessionId) {
                        log(`CLI bound a DIFFERENT conversation (${bound}) — aborting`);
                        killTree(child);
                        errorFinish(`CLI bound conversation ${bound}, expected ${sessionId}`);
                    }
                }
                else if (obj.type === "result") {
                    handleResult(obj);
                }
                // Other typed events are mid-turn noise on this wire — not forwarded.
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            for (const line of chunk.split(/\r?\n/))
                if (line.trim())
                    log(`[cli] ${line}`);
        });
        child.on("error", (err) => {
            if (!sawResult)
                errorFinish(`CLI failed to start: ${err.message}`);
        });
        child.on("close", (code) => {
            if (sawResult || settled)
                return;
            if (state.cancelled) {
                finish("cancelled");
                return;
            }
            errorFinish(`CLI exited (code ${code}) without a result event`);
        });
        ctx.signal.addEventListener("abort", () => {
            if (settled)
                return;
            state.cancelled = true;
            killTree(child);
        });
    });
});
app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (!state) {
        log(`session/cancel for unknown session ${params.sessionId}`);
        return;
    }
    state.cancelled = true;
    if (state.child && state.child.exitCode === null) {
        log(`session/cancel ${params.sessionId} — killing CLI pid ${state.child.pid}`);
        killTree(state.child);
    }
    else {
        log(`session/cancel ${params.sessionId} — no turn in flight`);
    }
});
// stdio transport — protocol on stdout, logs on stderr.
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
log("connected on stdio (ACP v1, CLI-backed)");
