#!/usr/bin/env node
/**
 * Raw JSON-RPC test client for letta-acp — no SDK, bytes on the wire.
 * Spawns dist/index.js, runs initialize -> session/new -> session/prompt,
 * prints every session/update notification, prints the final PromptResponse.
 *
 * Usage: node test/test-client.mjs [prompt]
 * Env:   LETTA_API_KEY, LETTA_AGENT_ID, LETTA_BASE_URL (optional)
 */
import { spawn } from "node:child_process";

const PROMPT = process.argv[2] ?? "Reply with exactly: adapter-ok";

const child = spawn(process.execPath, ["dist/index.js"], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const transcript = [];

function send(method, params) {
  const id = nextId++;
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
  );
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return console.log("!! response with unknown id", JSON.stringify(msg));
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params.update;
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk") {
      transcript.push(`ASSISTANT: ${u.content.text}`);
      process.stdout.write(u.content.text);
    } else if (kind === "agent_thought_chunk") {
      transcript.push(`THOUGHT: ${u.content.text.slice(0, 200)}`);
    } else if (kind === "tool_call") {
      transcript.push(`TOOL_CALL: ${u.name ?? u.title} (${u.status})`);
    } else if (kind === "tool_call_update") {
      transcript.push(`TOOL_${u.status}: ${u.toolCallId}`);
    } else {
      transcript.push(`UPDATE: ${kind}`);
    }
    return;
  }
  console.log("!! unexpected message:", JSON.stringify(msg).slice(0, 300));
}

child.on("exit", (code) => {
  if (pending.size > 0) {
    console.error(`\n!! adapter exited (code ${code}) with ${pending.size} pending request(s)`);
    process.exit(1);
  }
});

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "letta-acp-test-client", version: "0.1.0" },
  });
  console.log(
    `initialized: agent=${init.agentInfo?.name} v${init.agentInfo?.version} protocol=${init.protocolVersion} authMethods=${JSON.stringify(init.authMethods ?? [])}`
  );

  const session = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`session: ${session.sessionId}`);

  console.log(`prompt: "${PROMPT}"\n--- stream ---`);
  const t0 = Date.now();
  const done = await send("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n--- end stream (${dt}s) ---`);
  console.log(`stopReason: ${done.stopReason}`);

  console.log("\n=== transcript ===");
  for (const line of transcript) console.log(line);

  child.stdin.end();
  child.kill();
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err.message);
  child.kill();
  process.exit(1);
}
