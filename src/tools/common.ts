import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FutureApiError, FutureClient } from "../client.js";
import { ConfigError, loadConfig } from "../config.js";

/** Returns the shared FutureClient, created on first use. */
export type ClientProvider = () => FutureClient;

/**
 * Lazily create one FutureClient from the environment. The server can start
 * without FUTURE_API_KEY; a missing key surfaces only when a tool is called.
 */
export function lazyClientProvider(env: NodeJS.ProcessEnv = process.env): ClientProvider {
  let client: FutureClient | undefined;
  return () => {
    client ??= new FutureClient(loadConfig(env));
    return client;
  };
}

/** Wrap a JSON-serializable value as a successful tool result. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Convert an error into an `isError` tool result. FutureApiError and
 * ConfigError messages are already key-free; anything else gets a generic
 * message so unexpected internals never leak.
 */
export function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof FutureApiError || error instanceof ConfigError
      ? error.message
      : "Unexpected error while calling the Future Electronics API.";
  return { content: [{ type: "text", text: message }], isError: true };
}
