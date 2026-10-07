// Tests for the future_list_bom_files tool (issue #43), with real temp dirs.
// No network.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../src/server.js";
import {
  BOM_FILE_COLUMNS,
  LIST_BOM_FILES_DESCRIPTION,
  LIST_BOM_FILES_TOOL_NAME,
  listBomFiles,
  registerListBomFilesTool,
} from "../../src/tools/listBomFiles.js";

const isWindows = process.platform === "win32";
let base: string;
let ws: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fe-list-")));
  ws = join(base, "ws");
  mkdirSync(ws);
  vi.stubEnv("FUTURE_WORKSPACE_DIR", ws);
  vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "100000");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const put = (name: string, content: string, mtime?: Date) => {
  writeFileSync(join(ws, name), content);
  if (mtime) utimesSync(join(ws, name), mtime, mtime);
};

const parse = (res: { content: unknown }) => {
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return { text, json: JSON.parse(text) };
};

async function callOverMcp() {
  const server = createServer(() => {
    throw new Error("no client needed");
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    const res = await client.callTool({ name: LIST_BOM_FILES_TOOL_NAME, arguments: {} });
    return { tools, res };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("listBomFiles", () => {
  it("lists .csv and .tsv files (any case) with size and modified time", async () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    put("bom.csv", "mpn\nLM317T\n", when);
    put("B.TSV", "x", when);
    put("notes.txt", "x");
    put(".hidden.csv", "x");
    mkdirSync(join(ws, "folder.csv"));
    const { json } = parse(await listBomFiles());
    expect(json.files.columns).toEqual(BOM_FILE_COLUMNS);
    expect(json.files.rows).toEqual([
      ["B.TSV", 1, when.toISOString()],
      ["bom.csv", 11, when.toISOString()],
    ]);
    expect(json).not.toHaveProperty("note");
  });

  it("returns an empty table with a note when there are no files", async () => {
    const { json } = parse(await listBomFiles());
    expect(json.files.rows).toEqual([]);
    expect(json.note).toMatch(/No \.csv or \.tsv files/);
  });

  it("treats a missing workspace as empty", async () => {
    const res = await listBomFiles(join(base, "missing"));
    expect(res.isError).toBeFalsy();
    expect(parse(res).json.files.rows).toEqual([]);
  });

  it.skipIf(isWindows)("skips symlinks that escape the workspace, keeps ones inside", async () => {
    mkdirSync(join(base, "out"));
    writeFileSync(join(base, "out", "secret.csv"), "x");
    symlinkSync(join(base, "out", "secret.csv"), join(ws, "escape.csv"));
    put("real.csv", "abc");
    symlinkSync(join(ws, "real.csv"), join(ws, "alias.csv"));
    const { json, text } = parse(await listBomFiles());
    expect(json.files.rows.map((r: unknown[]) => r[0])).toEqual(["alias.csv", "real.csv"]);
    expect(text).not.toContain(base);
  });

  it("applies the output budget", async () => {
    for (let i = 0; i < 400; i++) put(`bom-${String(i).padStart(3, "0")}-with-a-longer-name.csv`, "x");
    const { json, text } = parse(await listBomFiles(ws, 1000));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(json.truncated.omitted).toBeGreaterThan(0);
  });

  it("reports configuration and workspace errors without the path", async () => {
    vi.stubEnv("FUTURE_WORKSPACE_DIR", "relative");
    const res = await listBomFiles();
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe("FUTURE_WORKSPACE_DIR must be an absolute path.");

    put("file", "x");
    const notDir = await listBomFiles(join(ws, "file"));
    expect(notDir.isError).toBe(true);
    const text = (notDir.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Cannot list the workspace folder/);
    expect(text).not.toContain(base);
  });

  it("reports a bad output budget setting", async () => {
    vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "5");
    const res = await listBomFiles();
    expect(res.isError).toBe(true);
  });
});

describe("future_list_bom_files over MCP", () => {
  it("is listed, read-only, and returns the files", async () => {
    put("bom.csv", "mpn\n");
    const { tools, res } = await callOverMcp();
    const tool = tools.find((t) => t.name === LIST_BOM_FILES_TOOL_NAME)!;
    expect(tool.description).toBe(LIST_BOM_FILES_DESCRIPTION);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(parse(res).json.files.rows[0][0]).toBe("bom.csv");
  });

  it("registers on a bare server", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerListBomFilesTool(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([LIST_BOM_FILES_TOOL_NAME]);
    await client.close();
    await server.close();
  });
});
