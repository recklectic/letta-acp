import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startClient } from "./sdk-client.mjs";

const fakeCli = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

// Synthetic fixtures, not captured production traffic. Exercise the compiled
// adapter and both SDKs against a fake Letta API and a stub CLI; no
// credentials, inference, or network beyond loopback.
async function fixture(t, { cliMode = "ok", timeoutMs, withMcp = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      path: url.pathname,
      agent: url.searchParams.get("agent_id"),
      body: body && JSON.parse(body),
    });
    if (url.pathname === "/v1/conversations/" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "conv-fixture" }));
    } else if (url.pathname === "/v1/conversations/conv-fixture") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "conv-fixture" }));
    } else if (url.pathname.startsWith("/v1/conversations/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "fixture not found" }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "letta-acp-test-"));
  const dump = path.join(cwd, "fake-cli-dump.json");
  const mcpServers = withMcp
    ? [
        {
          type: "http",
          name: "t3-code",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "Authorization", value: "Bearer fixture-token" }],
        },
      ]
    : [];
  const client = startClient(
    {
      LETTA_API_KEY: "fixture-not-a-secret",
      LETTA_AGENT_ID: "agent-fixture",
      LETTA_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      LETTA_ACP_CLI: fakeCli,
      FAKE_CLI_MODE: cliMode,
      FAKE_CLI_DUMP: dump,
    },
    { timeoutMs, log: (line) => t.diagnostic(line) }
  );
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { client, requests, cwd, dump };
}

test("initialize advertises the v1 CLI-backed surface", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t);
  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(init.authMethods, []);
  assert.equal(init.agentCapabilities.loadSession, true);
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true);
  assert.equal(init.agentCapabilities.mcpCapabilities.sse, false);
});

test("session/new pre-mints the conversation and declares modes", { timeout: 10000 }, async (t) => {
  const { client, requests } = await fixture(t);
  await client.initialize();
  const created = await client.newSession({ cwd: (await fixtureCwd(t)) });
  assert.equal(created.sessionId, "conv-fixture");
  assert.equal(created.modes.currentModeId, "default");
  assert.equal(created.modes.availableModes.length, 1);
  assert.equal(requests[0].path, "/v1/conversations/");
  assert.equal(requests[0].agent, "agent-fixture");
});

async function fixtureCwd(t) {
  // a stable temp dir for cwd-sensitive assertions within one test
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "letta-acp-cwd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("prompt happy path: result blob, receipts filtered, env injected", { timeout: 10000 }, async (t) => {
  const { client, cwd, dump } = await fixture(t, { withMcp: true });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd });
  const response = await client.prompt(sessionId, "fixture prompt");
  assert.equal(response.stopReason, "end_turn");
  const updates = client.updates.map(({ update }) => update);
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ["agent_message_chunk"]);
  assert.equal(updates[0].content.text, "fixture final answer");
  assert.ok(client.updates.every((u) => u.sessionId === sessionId));
  assert.equal(client.wire.at(-1).result.stopReason, "end_turn");

  const dumped = JSON.parse(fs.readFileSync(dump, "utf8"));
  const convIdx = dumped.argv.indexOf("--conversation");
  assert.ok(convIdx >= 0, "CLI received --conversation");
  assert.equal(dumped.argv[convIdx + 1], "conv-fixture");
  assert.equal(dumped.promptText, "fixture prompt");
  assert.equal(dumped.cwd, cwd);
  assert.equal(dumped.t3McpUrl, "http://127.0.0.1:9/mcp");
  assert.equal(dumped.t3McpToken, "present");
  assert.ok(dumped.argv.includes("-p"));
  assert.ok(dumped.argv.includes("stream-json") || dumped.argv.includes("--output-format"));
});

test("prompt error result: stopReason error with visible diagnostic", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { cliMode: "error-result" });
  await client.initialize();
  const { sessionId } = await client.newSession();
  await assert.rejects(client.prompt(sessionId), /fixture boom/);
  const chunk = client.updates.map(({ update }) => update).at(-1);
  assert.equal(chunk.sessionUpdate, "agent_message_chunk");
  assert.match(chunk.content.text, /fixture boom/);
});

test("CLI death without a result: stopReason error with diagnostic", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { cliMode: "die" });
  await client.initialize();
  const { sessionId } = await client.newSession();
  await assert.rejects(client.prompt(sessionId), /exited \(code 7\) without a result event/);
  const chunk = client.updates.map(({ update }) => update).at(-1);
  assert.match(chunk.content.text, /exited \(code 7\) without a result event/);
});

test("cancel kills the in-flight turn: stopReason cancelled", { timeout: 15000 }, async (t) => {
  const { client } = await fixture(t, { cliMode: "slow", timeoutMs: 12000 });
  await client.initialize();
  const { sessionId } = await client.newSession();
  const pending = client.prompt(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.cancel(sessionId);
  const response = await pending;
  assert.equal(response.stopReason, "cancelled");
  assert.equal(client.updates.length, 0);
});

test("init conversation mismatch: stopReason error", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t, { cliMode: "mismatch" });
  await client.initialize();
  const { sessionId } = await client.newSession();
  await assert.rejects(client.prompt(sessionId), /bound conversation conv-wrong, expected conv-fixture/);
  const chunk = client.updates.map(({ update }) => update).at(-1);
  assert.match(chunk.content.text, /bound conversation conv-wrong, expected conv-fixture/);
});

test("session/load validates existence and rebinds state", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t);
  await client.initialize();
  const loaded = await client.loadSession("conv-fixture");
  assert.equal(loaded.sessionId, "conv-fixture");
  const response = await client.prompt("conv-fixture");
  assert.equal(response.stopReason, "end_turn");
  await assert.rejects(client.loadSession("conv-ghost"), /fixture not found|404/);
});

test("helper script drops into the workspace with mcpServers", { timeout: 10000 }, async (t) => {
  const { client, cwd } = await fixture(t, { withMcp: true });
  await client.initialize();
  await client.newSession({ cwd });
  const helper = path.join(cwd, "t3.mjs");
  assert.ok(fs.existsSync(helper), "t3.mjs dropped");
  const content = fs.readFileSync(helper, "utf8");
  assert.match(content, /T3_MCP_URL/);
  assert.doesNotMatch(content, /fixture-token/, "no secret embedded in the helper");
});

test("no helper script without an MCP server", { timeout: 10000 }, async (t) => {
  const { client, cwd } = await fixture(t);
  await client.initialize();
  await client.newSession({ cwd });
  assert.ok(!fs.existsSync(path.join(cwd, "t3.mjs")));
});

test("set_mode: default accepted, others rejected", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t);
  await client.initialize();
  const { sessionId } = await client.newSession();
  await client.setMode(sessionId, "default");
  await assert.rejects(client.setMode(sessionId, "plan"));
});

test("prompt on unknown session: RPC error", { timeout: 10000 }, async (t) => {
  const { client } = await fixture(t);
  await client.initialize();
  await assert.rejects(client.prompt("conv-never-bound"), /unknown session/);
});
