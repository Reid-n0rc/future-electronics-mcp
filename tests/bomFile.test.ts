// Tests for src/bomFile.ts (issue #43), using real temp dirs and symlinks.
// No network.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOM_EXTENSIONS,
  BomFileError,
  MAX_BOM_BYTES,
  PART_ALIASES,
  QUANTITY_ALIASES,
  bomFileSchema,
  detectDelimiter,
  displayName,
  findColumn,
  loadBomFile,
  parseCsv,
} from "../src/bomFile.js";
import { WorkspaceError } from "../src/workspace.js";

const isWindows = process.platform === "win32";

let base: string;
let ws: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fe-bom-")));
  ws = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const put = (name: string, content: string | Buffer) => writeFileSync(join(ws, name), content);

/** Asserts a rejection matching `pattern` whose message never contains a temp path. */
async function expectFail(promise: Promise<unknown>, pattern: RegExp, type: Function = BomFileError) {
  const error = await promise.then(
    () => expect.unreachable("expected a rejection"),
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(type);
  expect(error.message).toMatch(pattern);
  expect(error.message).not.toContain(base);
  return error;
}

describe("parseCsv", () => {
  it("parses simple records", () => {
    expect(parseCsv("a,b\n1,2\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("makes the final line end optional", () => {
    expect(parseCsv("a,b\n1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles CRLF and lone CR line ends", () => {
    expect(parseCsv("a,b\r\n1,2\r\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\rb\r", ",")).toEqual([["a"], ["b"]]);
  });

  it("handles quoted fields with delimiters, newlines, CRLF and escaped quotes", () => {
    const text = 'part,note\r\n"LM317T","a, b"\r\n"X""Y","line1\r\nline2"\r\n';
    expect(parseCsv(text, ",")).toEqual([
      ["part", "note"],
      ["LM317T", "a, b"],
      ['X"Y', "line1\r\nline2"],
    ]);
  });

  it("keeps empty fields, including quoted empty ones and a trailing one", () => {
    expect(parseCsv('a,,""\n,', ",")).toEqual([["a", "", ""], ["", ""]]);
    expect(parseCsv('""', ",")).toEqual([[""]]);
  });

  it("keeps blank lines as single empty records", () => {
    expect(parseCsv("a\n\nb\n", ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("returns nothing for empty text", () => {
    expect(parseCsv("", ",")).toEqual([]);
  });

  it("uses the given delimiter only", () => {
    expect(parseCsv("a;b,c\n", ";")).toEqual([["a", "b,c"]]);
    expect(parseCsv("a\tb;c\n", "\t")).toEqual([["a", "b;c"]]);
  });

  it("keeps stray quotes inside unquoted fields as text", () => {
    expect(parseCsv('5" cable,2\n', ",")).toEqual([['5" cable', "2"]]);
    expect(parseCsv('"ab"cd,2\n', ",")).toEqual([["abcd", "2"]]);
  });

  it("rejects an unterminated quoted field, naming its row", () => {
    expect(() => parseCsv('a\n"open,1\n', ",")).toThrow(BomFileError);
    expect(() => parseCsv('a\n"open,1\n', ",")).toThrow(/Row 2 .*never closed/);
  });
});

describe("detectDelimiter", () => {
  it("detects comma, semicolon and tab", () => {
    expect(detectDelimiter("mpn,qty\n1;2;3")).toBe(",");
    expect(detectDelimiter("mpn;qty;x\n")).toBe(";");
    expect(detectDelimiter("mpn\tqty\n")).toBe("\t");
  });

  it("ignores delimiters inside quotes and after the first line", () => {
    expect(detectDelimiter('"a,b,c";qty\nx,y,z,w')).toBe(";");
  });

  it("prefers the fallback on no delimiter or a tie", () => {
    expect(detectDelimiter("mpn\n")).toBe(",");
    expect(detectDelimiter("mpn\n", "\t")).toBe("\t");
    expect(detectDelimiter("a,b\tc\n", "\t")).toBe("\t");
    expect(detectDelimiter("a;b\tc\n", ",")).toBe(";");
  });

  it("handles CRLF and empty text", () => {
    expect(detectDelimiter("a;b\r\nc,d,e,f")).toBe(";");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("findColumn", () => {
  it("auto-detects every part alias, case- and space-insensitively", () => {
    for (const alias of PART_ALIASES) {
      expect(findColumn(["Ref", ` ${alias.toUpperCase().replace(" ", "  ")} `], undefined, PART_ALIASES, "part")).toBe(1);
    }
  });

  it("auto-detects every quantity alias", () => {
    for (const alias of QUANTITY_ALIASES) {
      expect(findColumn([alias, "x"], undefined, QUANTITY_ALIASES, "quantity")).toBe(0);
    }
  });

  it("returns undefined when nothing matches, or with no header", () => {
    expect(findColumn(["a", "b"], undefined, QUANTITY_ALIASES, "quantity")).toBeUndefined();
    expect(findColumn(undefined, undefined, QUANTITY_ALIASES, "quantity")).toBeUndefined();
  });

  it("rejects an ambiguous auto-detection, listing the headers", () => {
    expect(() => findColumn(["MPN", "Part Number", "Qty"], undefined, PART_ALIASES, "part")).toThrow(
      /Several columns could be the part column \("MPN", "Part Number"\)\. Name one with part_column\. Headers found: "MPN", "Part Number", "Qty"\./,
    );
  });

  it("finds a named column by header, case-insensitively", () => {
    expect(findColumn(["Ref", "Vendor PN"], "vendor pn", PART_ALIASES, "part")).toBe(1);
  });

  it("takes a number or digit string as a 1-based column number", () => {
    expect(findColumn(["a", "b", "c"], 3, PART_ALIASES, "part")).toBe(2);
    expect(findColumn(["a", "b"], "2", PART_ALIASES, "part")).toBe(1);
    expect(findColumn(undefined, "1", PART_ALIASES, "part")).toBe(0);
  });

  it("prefers a header literally named like a number", () => {
    expect(findColumn(["x", "1"], "1", PART_ALIASES, "part")).toBe(1);
  });

  it("rejects an unknown or duplicated named column, listing the headers", () => {
    expect(() => findColumn(["a", "b"], "mpn", PART_ALIASES, "part")).toThrow(
      /No part column named "mpn"\. Headers found: "a", "b"\./,
    );
    expect(() => findColumn(["a", "A"], "a", PART_ALIASES, "part")).toThrow(/More than one column is named "a"/);
    expect(() => findColumn(undefined, "mpn", PART_ALIASES, "part")).toThrow(/The file has no header row/);
    expect(() => findColumn(["a"], "0", PART_ALIASES, "part")).toThrow(/No part column named "0"/);
  });

  it("caps the header list", () => {
    const headers = Array.from({ length: 45 }, (_, i) => `h${i}`);
    expect(() => findColumn(headers, "nope", PART_ALIASES, "part")).toThrow(/"h39", and 5 more\./);
  });
});

describe("displayName", () => {
  it("quotes the name as given, or the last part of an absolute name", () => {
    expect(displayName("sub/bom.csv")).toBe('"sub/bom.csv"');
    expect(displayName(join(base, "x", "bom.csv"))).toBe('"bom.csv"');
    expect(displayName("a".repeat(200))).toBe(JSON.stringify(`${"a".repeat(120)}...`));
  });
});

describe("bomFileSchema", () => {
  it("applies defaults and accepts valid specs", () => {
    expect(bomFileSchema.parse({ path: "bom.csv" })).toEqual({ path: "bom.csv", has_header: true });
    expect(bomFileSchema.parse({ path: "b.tsv", part_column: 2, quantity_column: "Qty", delimiter: "\t" })).toMatchObject({
      part_column: 2,
    });
  });

  it("rejects bad specs", () => {
    for (const spec of [{}, { path: "" }, { path: "b.csv", delimiter: "|" }, { path: "b.csv", part_column: 0 },
      { path: "b.csv", part_column: " " }, { path: "b.csv", has_header: "yes" }]) {
      expect(bomFileSchema.safeParse(spec).success).toBe(false);
    }
  });

  it("lists the allowed extensions", () => {
    expect(BOM_EXTENSIONS).toEqual([".csv", ".tsv"]);
  });
});

describe("loadBomFile", () => {
  it("reads parts and quantities with auto-detected columns", async () => {
    put("bom.csv", "Ref,MPN,Qty\nR1,LM317T,10\nR2,NE555P,\n");
    const { rows, source } = await loadBomFile({ path: "bom.csv" }, ws);
    expect(rows).toEqual([
      { row: 2, part_number: "LM317T", quantity: "10" },
      { row: 3, part_number: "NE555P" },
    ]);
    expect(source).toEqual({ file: "bom.csv", rows_read: 2, rows_skipped: 0, part_column: "MPN", quantity_column: "Qty" });
  });

  it("strips a UTF-8 BOM and handles CRLF, quotes and embedded newlines", async () => {
    put("bom.csv", '﻿mpn,quantity\r\n"LM317T","1"\r\n"A,B ""x""","2"\r\n"multi\r\nline",3\r\n');
    const { rows, source } = await loadBomFile({ path: "bom.csv" }, ws);
    expect(source.part_column).toBe("mpn");
    expect(rows.map((r) => r.part_number)).toEqual(["LM317T", 'A,B "x"', "multi\r\nline"]);
    expect(rows.map((r) => r.row)).toEqual([2, 3, 4]);
  });

  it("auto-detects semicolon and tab delimiters", async () => {
    put("semi.csv", "pn;count\nLM317T;5\n");
    put("tabs.tsv", "part number\tqty\nLM317T\t7\n");
    expect((await loadBomFile({ path: "semi.csv" }, ws)).rows).toEqual([{ row: 2, part_number: "LM317T", quantity: "5" }]);
    expect((await loadBomFile({ path: "tabs.tsv" }, ws)).rows).toEqual([{ row: 2, part_number: "LM317T", quantity: "7" }]);
  });

  it("uses an explicit delimiter over detection", async () => {
    put("bom.csv", "mpn;note,x\nLM317T;a,b\n");
    const { rows } = await loadBomFile({ path: "bom.csv", delimiter: ";" }, ws);
    expect(rows).toEqual([{ row: 2, part_number: "LM317T" }]);
  });

  it("reads a file without a header: column 1 by default, named columns by number", async () => {
    put("nohead.csv", "LM317T,10\nNE555P,20\n");
    const plain = await loadBomFile({ path: "nohead.csv", has_header: false }, ws);
    expect(plain.rows).toEqual([{ row: 1, part_number: "LM317T" }, { row: 2, part_number: "NE555P" }]);
    expect(plain.source).toMatchObject({ part_column: "column 1", quantity_column: null, rows_read: 2 });
    const named = await loadBomFile({ path: "nohead.csv", has_header: false, quantity_column: 2 }, ws);
    expect(named.rows[0]).toEqual({ row: 1, part_number: "LM317T", quantity: "10" });
    expect(named.source.quantity_column).toBe("column 2");
  });

  it("skips and counts rows with an empty part number; ignores blank rows", async () => {
    put("bom.csv", "mpn,qty\nLM317T,1\n,5\n  ,2\n\n,,\nNE555P\n");
    const { rows, source } = await loadBomFile({ path: "bom.csv" }, ws);
    expect(rows.map((r) => r.part_number)).toEqual(["LM317T", "NE555P"]);
    expect(source).toMatchObject({ rows_read: 4, rows_skipped: 2 });
  });

  it("trims part numbers and quantities", async () => {
    put("bom.csv", "mpn,qty\n  LM317T  , 3 \n");
    expect((await loadBomFile({ path: "bom.csv" }, ws)).rows).toEqual([{ row: 2, part_number: "LM317T", quantity: "3" }]);
  });

  it("has no quantity column when none is detected", async () => {
    put("bom.csv", "mpn,notes\nLM317T,x\n");
    const { rows, source } = await loadBomFile({ path: "bom.csv" }, ws);
    expect(rows).toEqual([{ row: 2, part_number: "LM317T" }]);
    expect(source.quantity_column).toBeNull();
  });

  it("uses a named header column, and labels an empty header by number", async () => {
    put("bom.csv", "Vendor,,Amount\nLM317T,x,4\n");
    const { source } = await loadBomFile({ path: "bom.csv", part_column: "vendor", quantity_column: 2 }, ws);
    expect(source).toMatchObject({ part_column: "Vendor", quantity_column: "column 2" });
  });

  it("accepts upper-case extensions", async () => {
    put("BOM.CSV", "mpn\nLM317T\n");
    put("b.TsV", "mpn\nLM317T\n");
    expect((await loadBomFile({ path: "BOM.CSV" }, ws)).rows).toHaveLength(1);
    expect((await loadBomFile({ path: "b.TsV" }, ws)).rows).toHaveLength(1);
  });

  it("reads files in subfolders and by an absolute path inside the workspace", async () => {
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "bom.csv"), "mpn\nLM317T\n");
    expect((await loadBomFile({ path: "sub/bom.csv" }, ws)).source.file).toBe("sub/bom.csv");
    expect((await loadBomFile({ path: join(ws, "sub", "bom.csv") }, ws)).source.file).toBe("bom.csv");
  });

  it("uses FUTURE_WORKSPACE_DIR by default", async () => {
    vi.stubEnv("FUTURE_WORKSPACE_DIR", ws);
    put("bom.csv", "mpn\nLM317T\n");
    expect((await loadBomFile({ path: "bom.csv" })).rows).toHaveLength(1);
  });

  it("detects a missing part column, listing the headers", async () => {
    put("bom.csv", "Ref,Value\nR1,10k\n");
    await expectFail(loadBomFile({ path: "bom.csv" }, ws), /No part number column found\. Name one with part_column\. Headers found: "Ref", "Value"\./);
  });

  it("rejects an ambiguous part or quantity column", async () => {
    put("bom.csv", "mpn,pn\nA,B\n");
    put("q.csv", "mpn,qty,count\nA,1,2\n");
    await expectFail(loadBomFile({ path: "bom.csv" }, ws), /Several columns could be the part column/);
    await expectFail(loadBomFile({ path: "q.csv" }, ws), /Several columns could be the quantity column/);
  });

  it("rejects an empty file and an unterminated quote", async () => {
    put("empty.csv", "");
    put("open.csv", 'mpn\n"LM317T\n');
    await expectFail(loadBomFile({ path: "empty.csv" }, ws), /^"empty\.csv" is empty\.$/);
    await expectFail(loadBomFile({ path: "open.csv" }, ws), /Row 2 has a quoted field that is never closed/);
  });

  it("returns no rows for an empty file without a header", async () => {
    put("empty.csv", "");
    const { rows, source } = await loadBomFile({ path: "empty.csv", has_header: false }, ws);
    expect(rows).toEqual([]);
    expect(source.rows_read).toBe(0);
  });

  it("rejects other extensions before touching the file", async () => {
    put("bom.txt", "mpn\nLM317T\n");
    for (const path of ["bom.txt", "bom", "bom.csv.bak", "../outside/secret.txt"]) {
      await expectFail(loadBomFile({ path }, ws), /is not a \.csv or \.tsv file\./);
    }
  });

  it("rejects a missing file with a hint", async () => {
    await expectFail(loadBomFile({ path: "nope.csv" }, ws), /^"nope\.csv" was not found in the workspace folder\. Use future_list_bom_files/);
  });

  it("rejects a folder named like a CSV", async () => {
    mkdirSync(join(ws, "dir.csv"));
    await expectFail(loadBomFile({ path: "dir.csv" }, ws), /^"dir\.csv" is not a file\.$/);
  });

  it("rejects a file over the size cap without reading it", async () => {
    put("big.csv", "");
    truncateSync(join(ws, "big.csv"), MAX_BOM_BYTES + 1);
    await expectFail(loadBomFile({ path: "big.csv" }, ws), /^"big\.csv" is larger than the 5 MB limit\.$/);
  });

  it("accepts a file of exactly the size cap", async () => {
    const head = "mpn\nLM317T\n";
    put("max.csv", head + " ".repeat(MAX_BOM_BYTES - head.length));
    expect((await loadBomFile({ path: "max.csv" }, ws)).rows).toHaveLength(1);
  });

  it("rejects text that is not UTF-8", async () => {
    put("latin1.csv", Buffer.from([0x6d, 0x70, 0x6e, 0x0a, 0xe9, 0x0a]));
    await expectFail(loadBomFile({ path: "latin1.csv" }, ws), /is not valid UTF-8 text/);
  });

  it("rejects paths outside the workspace without leaking paths", async () => {
    writeFileSync(join(outside, "bom.csv"), "mpn\nLM317T\n");
    await expectFail(loadBomFile({ path: "../outside/bom.csv" }, ws), /^"\.\.\/outside\/bom\.csv" is outside the workspace folder/, WorkspaceError);
    await expectFail(loadBomFile({ path: join(outside, "bom.csv") }, ws), /^"bom\.csv" is outside the workspace folder/, WorkspaceError);
  });

  it.skipIf(isWindows)("rejects a symlink that escapes the workspace", async () => {
    writeFileSync(join(outside, "secret.csv"), "mpn\nSECRET\n");
    symlinkSync(join(outside, "secret.csv"), join(ws, "link.csv"));
    symlinkSync(outside, join(ws, "linkdir"));
    await expectFail(loadBomFile({ path: "link.csv" }, ws), /^"link\.csv" is outside the workspace folder/, WorkspaceError);
    await expectFail(loadBomFile({ path: "linkdir/secret.csv" }, ws), /is outside the workspace folder/, WorkspaceError);
  });

  it.skipIf(isWindows)("follows a symlink that stays inside the workspace", async () => {
    put("real.csv", "mpn\nLM317T\n");
    symlinkSync(join(ws, "real.csv"), join(ws, "alias.csv"));
    expect((await loadBomFile({ path: "alias.csv" }, ws)).rows).toHaveLength(1);
  });
});
