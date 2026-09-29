import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lazyClientProvider, type ClientProvider } from "./tools/common.js";
import { registerLookupPartTool } from "./tools/lookupPart.js";
import { registerLookupPartsTool } from "./tools/lookupParts.js";

export const SERVER_NAME = "future-electronics-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Register all MCP tools on the server. The client is created lazily, so the
 * server starts without a key and a missing key surfaces only on a tool call.
 */
export function registerTools(server: McpServer, getClient: ClientProvider = lazyClientProvider()): void {
  registerLookupPartTool(server, getClient);
  registerLookupPartsTool(server, getClient);
}

/** Create a new, unconnected MCP server with all tools registered. */
export function createServer(getClient: ClientProvider = lazyClientProvider()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, getClient);
  return server;
}
