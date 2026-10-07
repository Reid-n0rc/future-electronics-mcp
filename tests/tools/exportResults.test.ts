// Tests for the future_export_results tool (issue #73), with real temp
// workspaces. No network, no keys.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toCsv, toJson } from "../../src/export.js";
import { PRICING_DISCLAIMER } from "../../src/format.js";
import { ResultStore, defaultResultStore, unknownResultMessage, type StoredResult } from "../../src/results.js";
import { createServer } from "../../src/server.js";
import {
  EXPORT_FORMATS,
  EXPORT_RESULTS_DESCRIPTION,
  EXPORT_RESULTS_TOOL_NAME,
  exportResults,
  registerExportResultsTool,
} from "../../src/tools/exportResults.js";
import type { PartResult } from "../../src/tools/lookupParts.js";

const FIXED = new Date(Date.UTC(2026, 9, 7, 3, 4, 5));
const clock = () => FIXED;

const PARTS: PartResult[] = [
  {
    part_number: "A1", quantity: 100, quantity_given: true, status: "found", mpn: "MPN-A1",
    quantity_available: 500, quantity_minimum: 10, lead_time: "12 Weeks", currency_code: "USD",
    price: { price_break: { from: 100, to: 999, unit_price: 0.8 } },
  },
  { part_number: "=EVIL()", quantity: 1, quantity_given: false, status: "not_found" },
];
const DATA: Omit<StoredResult, "created_at"> = {
  parts: PARTS,
  batches: [],
  totals: {
    requested: 2, unique: 2, found: 1, not_found: 1, errors: 0, not_attempted: 0,
    short_stock: 0, below_moq: 0,
  } as StoredResult["totals"],
};

let base: string;
let ws: string;
let store: ResultStore;
let id: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fe-exporttool-")));
  ws = join(base, "ws");
  vi.stubEnv("FUTURE_WORKSPACE_DIR", ws);
  store = new ResultStore({ newId: () => "rid-1" });
  id = store.put(DATA);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const parse = (res: { content: unknown }) => {
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return { text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};

describe("exportResults", () => {
  it("writes CSV by default and returns path, rows and bytes", async () => {
    const res = await exportResults({ result_id: id }, store, { now: clock });
    expect(res.isError).toBeUndefined();
    const { json, text } = parse(res);
    const csv = toCsv(store.get(id)!);
    expect(json).toEqual({
      result_id: "rid-1",
      note: PRICING_DISCLAIMER,
      files: [{ format: "csv", path: "exports/20261007-030405-rid-1.csv", rows: 2, bytes: Buffer.byteLength(csv) }],
    });
    expect(text).not.toContain(base);
    const written = readFileSync(join(ws, "exports/20261007-030405-rid-1.csv"), "utf8");
    expect(written).toBe(csv);
    expect(written).toContain("\r\n'=EVIL(),");
  });

  it("writes JSON", async () => {
    const { json } = parse(await exportResults({ result_id: id, format: "json" }, store, { now: clock }));
    expect(json.files).toHaveLength(1);
    expect(json.files[0]).toMatchObject({ format: "json", path: "exports/20261007-030405-rid-1.json", rows: 2 });
    const written = readFileSync(join(ws, json.files[0].path), "utf8");
    expect(written).toBe(toJson(id, store.get(id)!));
  });

  it("writes both files for format both", async () => {
    const { json } = parse(await exportResults({ result_id: id, format: "both" }, store, { now: clock }));
    expect(json.files.map((f: { path: string }) => f.path)).toEqual([
      "exports/20261007-030405-rid-1.csv",
      "exports/20261007-030405-rid-1.json",
    ]);
    expect(readdirSync(join(ws, "exports")).sort()).toEqual([
      "20261007-030405-rid-1.csv",
      "20261007-030405-rid-1.json",
    ]);
  });

  it("returns the unknown-id message for an unknown id and writes nothing", async () => {
    const res = await exportResults({ result_id: "nope" }, store, { now: clock });
    expect(res.isError).toBe(true);
    expect(parse(res).text).toBe(unknownResultMessage("nope"));
    expect(() => readdirSync(ws)).toThrow();
  });

  it("returns the unknown-id message for an expired id", async () => {
    let t = 0;
    const s = new ResultStore({ now: () => t, ttlMs: 1000, newId: () => "old" });
    s.put(DATA);
    t = 1000;
    const res = await exportResults({ result_id: "old" }, s, { now: clock });
    expect(res.isError).toBe(true);
    expect(parse(res).text).toBe(unknownResultMessage("old"));
  });

  it("maps a workspace error without revealing the workspace path", async () => {
    mkdirSync(ws);
    writeFileSync(join(ws, "exports"), "a file, not a folder");
    const res = await exportResults({ result_id: id }, store, { now: clock });
    expect(res.isError).toBe(true);
    expect(parse(res).text).toMatch(/^Cannot /);
    expect(parse(res).text).not.toContain(base);
  });

  it("maps a ConfigError for a bad FUTURE_WORKSPACE_DIR", async () => {
    vi.stubEnv("FUTURE_WORKSPACE_DIR", "relative");
    const res = await exportResults({ result_id: id }, store);
    expect(res.isError).toBe(true);
    expect(parse(res).text).toBe("FUTURE_WORKSPACE_DIR must be an absolute path.");
  });

  it("returns a generic message for an unexpected error", async () => {
    const bad = { get: () => ({ ...DATA, parts: null, created_at: 0 }) } as unknown as ResultStore;
    const res = await exportResults({ result_id: id }, bad, { now: clock, root: ws });
    expect(res.isError).toBe(true);
    expect(parse(res).text).toBe("Unexpected error while writing the export.");
  });
});

describe("future_export_results over MCP", () => {
  async function call(args: Record<string, unknown>, server: McpServer) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const res = await client.callTool({ name: EXPORT_RESULTS_TOOL_NAME, arguments: args });
      return { tools, res };
    } finally {
      await client.close();
      await server.close();
    }
  }

  const ownServer = () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerExportResultsTool(server, store);
    return server;
  };

  it("is registered by createServer with its schema and annotations", async () => {
    const server = createServer(() => {
      throw new Error("no client needed");
    });
    const { tools, res } = await call({ result_id: "missing" }, server);
    const tool = tools.find((t) => t.name === EXPORT_RESULTS_TOOL_NAME)!;
    expect(tool.description).toBe(EXPORT_RESULTS_DESCRIPTION);
    expect(tool.inputSchema.required).toEqual(["result_id"]);
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).format!.enum).toEqual([
      ...EXPORT_FORMATS,
    ]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(res.isError).toBe(true);
    expect(parse(res).text).toBe(unknownResultMessage("missing"));
  });

  it("uses the default store and writes into the workspace", async () => {
    const realId = defaultResultStore.put(DATA);
    try {
      const server = createServer(() => {
        throw new Error("no client needed");
      });
      const { res } = await call({ result_id: realId, format: "csv" }, server);
      expect(res.isError).toBeFalsy();
      const { json } = parse(res);
      expect(json.files[0].path).toMatch(/^exports\/\d{8}-\d{6}-[0-9a-f-]+\.csv$/);
      expect(readFileSync(join(ws, json.files[0].path), "utf8")).toContain("\r\nA1,MPN-A1,");
    } finally {
      defaultResultStore.clear();
    }
  });

  it.each([
    [{ result_id: id, format: "xml" }, /Unknown format/],
    [{ result_id: "" }, /result_id|at least 1/i],
    [{}, /result_id|Required/i],
    [{ result_id: 5 }, /string/i],
  ])("rejects invalid input %j", async (args, message) => {
    const { res } = await call(args as Record<string, unknown>, ownServer());
    expect(res.isError).toBe(true);
    expect(parse(res).text).toMatch(message);
    expect(() => readdirSync(ws)).toThrow();
  });
});
