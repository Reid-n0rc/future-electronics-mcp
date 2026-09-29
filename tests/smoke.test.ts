import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
  registerTools,
} from "../src/server.js";

describe("createServer", () => {
  it("constructs an McpServer", () => {
    expect(createServer()).toBeInstanceOf(McpServer);
  });

  it("returns a new instance on each call", () => {
    const a = createServer();
    const b = createServer();
    expect(a).not.toBe(b);
  });

  it("returns a server that is not connected to any transport", () => {
    expect(createServer().isConnected()).toBe(false);
  });

  it("uses the expected server name and version", () => {
    expect(SERVER_NAME).toBe("future-electronics-mcp");
    expect(SERVER_VERSION).toBe("0.1.0");
  });
});

describe("registerTools", () => {
  const fresh = () => new McpServer({ name: "test", version: "0.0.0" });

  it("is callable on a fresh server without throwing", () => {
    expect(() => registerTools(fresh())).not.toThrow();
  });

  it("returns undefined", () => {
    expect(registerTools(fresh())).toBeUndefined();
  });

  it("can be called repeatedly on the same server while it registers no tools", () => {
    const server = fresh();
    registerTools(server);
    expect(() => registerTools(server)).not.toThrow();
  });
});
