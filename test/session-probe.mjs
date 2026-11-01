import assert from "node:assert/strict";
import { startClient } from "./sdk-client.mjs";

// Explicit opt-in: creates one real, empty conversation, but sends no prompt.
if (!process.env.LETTA_API_KEY || !process.env.LETTA_AGENT_ID) {
  console.error("Set LETTA_API_KEY and LETTA_AGENT_ID before running the live session probe.");
  process.exit(1);
}
const client = startClient({}, { timeoutMs: 15000, log: console.log });
try {
  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  console.log(`negotiated ACP v${init.protocolVersion}`);
  const session = await client.newSession();
  assert.equal(typeof session.sessionId, "string");
  assert.ok(session.sessionId.length > 0);
  console.log(`created empty conversation: ${session.sessionId}`);
  console.log("PASS: initialize + session/new; no prompt or inference requested.");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.close();
}
