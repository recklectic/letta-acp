import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type HttpServer = { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

/** A separate MCP connection and tool registry for each ACP session. */
export class T3Mcp {
  private constructor(private client: Client, private names: Map<string, string>, readonly tools: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>) {}

  static async connect(server: HttpServer): Promise<T3Mcp> {
    const url = new URL(server.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported MCP URL");
    const headers = Object.fromEntries(server.headers.map(h => [h.name, h.value]));
    const client = new Client({ name: "letta-acp", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    try {
      const names = new Map<string, string>();
      const tools: Array<{ name: string; description?: string; parameters: Record<string, unknown> }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          const name = `t3_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
          names.set(name, tool.name);
          tools.push({ name, description: tool.description, parameters: tool.inputSchema });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return new T3Mcp(client, names, tools);
    } catch (error) { await client.close(); throw error; }
  }

  has(name: string): boolean { return this.names.has(name); }
  async call(name: string, args: Record<string, unknown>): Promise<{ status: "success" | "error"; tool_return: string }> {
    const original = this.names.get(name);
    if (!original) throw new Error(`Unknown client tool: ${name}`);
    try {
      const result = await this.client.callTool({ name: original, arguments: args });
      return { status: result.isError ? "error" : "success", tool_return: JSON.stringify(result) };
    } catch (e) { return { status: "error", tool_return: e instanceof Error ? e.message : String(e) }; }
  }
  close(): Promise<void> { return this.client.close(); }
}
