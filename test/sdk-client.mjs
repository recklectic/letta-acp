import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

export const root = fileURLToPath(new URL("../", import.meta.url));

/** Real SDK peer over subprocess stdio. Never prints credentials or prompt bodies. */
export function startClient(env, { timeoutMs = 5000, log = () => {} } = {}) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const updates = [];
  const wire = [];
  let stderr = "";
  let connection;
  let stopped = false;
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.on("error", (error) => connection?.close(error));
  child.on("exit", (code, signal) => {
    if (!stopped) connection?.close(new Error(`adapter exited: ${code ?? signal}`));
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  // Capture order before SDK dispatch, including responses and rejected updates.
  stream.readable = stream.readable.pipeThrough(new TransformStream({
    transform(message, controller) {
      wire.push(message);
      log(message.method ?? (message.error ? "rpc-error" : "rpc-response"));
      controller.enqueue(message);
    },
  }));
  connection = acp.client({ name: "letta-acp-sdk-test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
      log(`update: ${params.update.sessionUpdate}`);
    })
    .connect(stream);

  function close() {
    if (stopped) return;
    stopped = true;
    connection.close();
    child.stdin.end();
    child.kill();
  }

  async function request(method, params) {
    let timer;
    log(`request: ${method}`);
    try {
      return await Promise.race([
        connection.agent.request(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            close();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request, updates, wire, close, child,
    get stderr() { return stderr; },
    initialize: (protocolVersion = 1) => request("initialize", {
      protocolVersion,
      clientCapabilities: {},
      clientInfo: { name: "letta-acp-sdk-test", version: "0.1.0" },
    }),
    newSession: () => request("session/new", { cwd: root, mcpServers: [] }),
    prompt: (sessionId, text = "fixture prompt") => request("session/prompt", {
      sessionId, prompt: [{ type: "text", text }],
    }),
  };
}
