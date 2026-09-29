// Tests for the committed, self-contained server bundle (issue #32).
//
// The bundle is copied alone into an empty temp directory, so there is no
// node_modules on the resolve path, and spawned with FUTURE_API_KEY removed
// from its environment. The test speaks newline-delimited JSON-RPC over stdio.
// No network and no key are used.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../server/future-electronics-mcp.mjs", import.meta.url));
const TIMEOUT_MS = 30_000;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

class StdioPeer {
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, (msg: JsonRpcMessage) => void>();
  stderr = "";

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline: number;
      while ((newline = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined) this.#pending.get(msg.id)?.(msg);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${this.stderr}`));
      }, TIMEOUT_MS);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(msg);
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string): void {
    this.#write({ jsonrpc: "2.0", method });
  }

  #write(msg: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
}

describe("bundle file", () => {
  const text = readFileSync(BUNDLE, "utf8");

  it("starts with a node hashbang followed by the AGPL header", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(text.slice(0, 1000)).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
    expect(text.slice(0, 1000)).toContain("https://github.com/Reid-n0rc/future-electronics-mcp");
  });

  it("retains the license notices of the bundled runtime dependencies", () => {
    for (const pkg of ["@modelcontextprotocol/sdk", "zod", "ajv"]) {
      expect(text).toMatch(new RegExp(`^// ---- ${pkg.replace("/", "\\/")}@\\S+ \\(`, "m"));
    }
    expect(text).toContain("Permission is hereby granted, free of charge");
  });

  it("has no sourcemap reference and no absolute paths from the build machine", () => {
    expect(text).not.toContain("sourceMappingURL");
    expect(text).not.toMatch(/\/(Users|home)\/[^/\s]+\//);
    expect(text).not.toMatch(/[A-Z]:\\\\/);
  });
});

describe("bundle runs standalone", () => {
  let dir: string;
  let peer: StdioPeer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fe-mcp-bundle-"));
    const copy = join(dir, "future-electronics-mcp.mjs");
    copyFileSync(BUNDLE, copy);
    const env = { ...process.env };
    delete env.FUTURE_API_KEY;
    delete env.NODE_PATH;
    const child = spawn(process.execPath, [copy], { cwd: dir, env, stdio: "pipe" });
    peer = new StdioPeer(child);
  });

  afterAll(async () => {
    const child = peer?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }, TIMEOUT_MS);

  it(
    "answers initialize",
    async () => {
      const res = await peer.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bundle-test", version: "0.0.0" },
      });
      expect(res.error).toBeUndefined();
      expect(res.result?.serverInfo).toMatchObject({ name: "future-electronics-mcp" });
      expect(res.result?.capabilities).toHaveProperty("tools");
      peer.notify("notifications/initialized");
    },
    TIMEOUT_MS,
  );

  it(
    "lists both tools without FUTURE_API_KEY",
    async () => {
      const res = await peer.request("tools/list");
      expect(res.error).toBeUndefined();
      const tools = res.result?.tools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("future_lookup_part");
      expect(names).toContain("future_lookup_parts");
    },
    TIMEOUT_MS,
  );

  it(
    "reports a missing key as a tool error instead of crashing",
    async () => {
      const res = await peer.request("tools/call", {
        name: "future_lookup_part",
        arguments: { part_number: "LM358" },
      });
      expect(res.error).toBeUndefined();
      expect(res.result?.isError).toBe(true);
      expect(JSON.stringify(res.result?.content)).toContain("FUTURE_API_KEY");
      expect(peer.child.exitCode).toBeNull();
    },
    TIMEOUT_MS,
  );
});
