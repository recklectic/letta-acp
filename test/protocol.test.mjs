import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startClient } from "./sdk-client.mjs";

// Synthetic fixtures, not captured production traffic. Exercise the actual
// compiled adapter and both SDKs; no credentials, inference, or network beyond loopback.
async function fixture(t, { events = [], createStatus = 200, stallCreate = false, timeoutMs } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, agent: url.searchParams.get("agent_id"), body: body && JSON.parse(body) });
    if (url.pathname === "/v1/conversations/") {
      if (stallCreate) return;
      res.writeHead(createStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(createStatus === 200 ? { id: "conv-fixture" } : { detail: "fixture credential rejected" }));
    } else if (url.pathname === "/v1/conversations/conv-fixture/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = startClient({
    LETTA_API_KEY: "fixture-not-a-secret",
    LETTA_AGENT_ID: "agent-fixture",
    LETTA_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  }, { timeoutMs, log: (line) => t.diagnostic(line) });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, requests };
}

test("SDK handshake and session creation require no inference", { timeout: 10000 }, async (t) => {
  const { client, requests } = await fixture(t);
  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(init.authMethods, []);
  assert.equal(init.agentCapabilities.loadSession, false);
  assert.deepEqual(await client.newSession(), { sessionId: "conv-fixture" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/conversations/");
  assert.equal(requests[0].agent, "agent-fixture");
});

test("v2 version offer negotiates down to v1 (not v2 support)", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t);
  assert.equal((await client.initialize(2)).protocolVersion, 1);
  assert.equal((await client.newSession()).sessionId, "conv-fixture");
});

test("text, thought, tool, result, and final text arrive before prompt completion", { timeout: 10000 }, async (t) => {
  const { client, requests } = await fixture(t, { events: [
    { message_type: "reasoning_message", reasoning: "fixture thought" },
    { message_type: "assistant_message", content: "before tool" },
    { message_type: "tool_call_message", tool_call: { tool_call_id: "call-1", name: "read", arguments: '{"path":"fixture"}' } },
    { message_type: "tool_return_message", tool_call_id: "call-1", status: "success", tool_return: "fixture result" },
    { message_type: "assistant_message", content: [{ type: "text", text: "final answer" }] },
    { message_type: "stop_reason", stop_reason: "end_turn" },
  ] });
  await client.initialize();
  const { sessionId } = await client.newSession();
  assert.equal((await client.prompt(sessionId)).stopReason, "end_turn");
  const updates = client.updates.map(({ update }) => update);
  assert.deepEqual(updates.map((u) => u.sessionUpdate), [
    "agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk",
  ]);
  assert.ok(client.updates.every((u) => u.sessionId === sessionId));
  assert.equal(updates[0].content.text, "fixture thought");
  assert.deepEqual(updates[2].rawInput, { path: "fixture" });
  assert.equal(updates[3].toolCallId, updates[2].toolCallId);
  assert.equal(updates[3].status, "completed");
  assert.equal(updates[3].content[0].content.text, "fixture result");
  assert.equal(updates[4].content.text, "final answer");
  assert.equal(client.wire.at(-1).result.stopReason, "end_turn");
  assert.equal(requests.at(-1).body.streaming, true);
});

test("failed tool with empty output and token limit survive SDK decoding", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { events: [
    { message_type: "tool_call_message", tool_call: { tool_call_id: "call-2", name: "read", arguments: "{}" } },
    { message_type: "tool_return_message", tool_call_id: "call-2", status: "error", tool_return: "" },
    { message_type: "stop_reason", stop_reason: "max_tokens" },
  ] });
  await client.initialize();
  const { sessionId } = await client.newSession();
  assert.equal((await client.prompt(sessionId)).stopReason, "max_tokens");
  assert.equal(client.updates.at(-1).update.status, "failed");
  assert.equal(client.updates.at(-1).update.content, null);
});

test("session creation HTTP failure becomes an RPC error", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { createStatus: 401 });
  await client.initialize();
  await assert.rejects(client.newSession());
  assert.ok(client.wire.at(-1).error);
  assert.equal(client.updates.length, 0);
});

test("stalled session creation has a bounded diagnostic failure", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { stallCreate: true, timeoutMs: 1500 });
  await client.initialize();
  await assert.rejects(client.newSession(), /session\/new timed out after 1500ms/);
});
