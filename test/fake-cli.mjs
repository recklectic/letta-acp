// Stub letta CLI for the protocol tests. Emits the pinned headless event
// shapes; FAKE_CLI_MODE drives behavior. Dumps its argv/env/cwd for
// assertions when FAKE_CLI_DUMP is set.
import * as fs from "node:fs";

const mode = process.env.FAKE_CLI_MODE || "ok";
const convIdx = process.argv.indexOf("--conversation");
const conv = convIdx >= 0 ? process.argv[convIdx + 1] : "unknown";
const promptText = process.argv.at(-1);

if (process.env.FAKE_CLI_DUMP) {
  fs.writeFileSync(
    process.env.FAKE_CLI_DUMP,
    JSON.stringify(
      {
        argv: process.argv,
        cwd: process.cwd(),
        t3McpUrl: process.env.T3_MCP_URL,
        t3McpToken: process.env.T3_MCP_BEARER_TOKEN ? "present" : undefined,
        promptText,
      },
      null,
      2
    )
  );
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (mode === "die") {
  emit({ type: "init", conversation_id: conv });
  process.exit(7);
}

if (mode === "mismatch") {
  emit({ type: "init", conversation_id: "conv-wrong" });
  process.exit(0);
}

if (mode === "slow") {
  emit({ type: "init", conversation_id: conv });
  setTimeout(() => {
    emit({ type: "result", subtype: "success", result: "late", stop_reason: "end_turn" });
  }, 4000);
} else {
  emit({ type: "init", conversation_id: conv, agent_id: "agent-fixture" });
  emit({ client_message_id: "r1", workflow_id: "wf1", status: "queued" }); // receipt-shaped noise
  emit({ type: "assistant", message: { role: "assistant", content: "partial" } }); // typed mid-turn noise
  if (mode === "error-result") {
    emit({ type: "result", subtype: "error", error: { type: "invalid_request_error", message: "fixture boom" } });
  } else {
    emit({ type: "result", subtype: "success", result: "fixture final answer", stop_reason: "end_turn" });
  }
}
