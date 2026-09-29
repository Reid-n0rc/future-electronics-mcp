import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SERVER_NAME = "future-electronics-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Register all MCP tools on the server. No tools are registered yet; the
 * Future Electronics lookup tools are added by later issues.
 */
export function registerTools(_server: McpServer): void {
  // Intentionally empty.
}

/** Create a new, unconnected MCP server with all tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server);
  return server;
}
