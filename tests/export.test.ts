// Tests for src/export.ts (issue #73). Files are written only in temp
// workspaces. No network, no keys.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  CSV_COLUMNS,
  EXPORTS_DIR,
  csvCell,
  exportFileName,
  exportTimestamp,
  toCsv,
  toJson,
  writeExport,
} from "../src/export.js";
import { PRICING_DISCLAIMER } from "../src/format.js";
import type { StoredResult } from "../src/results.js";
import { PART_COLUMNS, type PartResult } from "../src/tools/lookupParts.js";
import { QUERY_COLUMNS } from "../src/tools/queryResults.js";
import { WorkspaceError } from "../src/workspace.js";

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const found = (part_number: string, extra: Partial<PartResult> = {}): PartResult => ({
  part_number,
  quantity: 100,
  quantity_given: true,
  status: "found",
  offer_count: 1,
  mpn: `MPN-${part_number}`,
  quantity_available: 500,
  quantity_minimum: 10,
  lead_time: "12 Weeks",
  currency_code: "USD",
  price: { price_break: { from: 100, to: 999, unit_price: 0.8 } },
  ...extra,
});

const stored = (parts: PartResult[]): StoredResult => ({
  parts,
  batches: [{ part_numbers: parts.map((p) => p.part_number), response: { offers: [] } } as never],
  totals: {
    requested: parts.length, unique: parts.length, found: parts.length, not_found: 0, errors: 0,
    not_attempted: 0, short_stock: 0, below_moq: 0,
  } as StoredResult["totals"],
  created_at: 1_700_000_000_000,
});

const FIXED = new Date(Date.UTC(2026, 9, 7, 3, 4, 5));
const clock = () => FIXED;

describe("csvCell", () => {
  it("leaves plain text and numbers alone", () => {
    expect(csvCell("ABC123")).toBe("ABC123");
    expect(csvCell(0.8)).toBe("0.8");
    expect(csvCell(0)).toBe("0");
  });

  it("writes null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("quotes commas, quotes, LF and CR, doubling quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell('"')).toBe('""""');
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])("neutralizes a cell starting with %j", (prefix) => {
    const out = csvCell(`${prefix}SUM(A1)`);
    // The cell, after unquoting, starts with a single quote.
    const unquoted = out.startsWith('"') ? out.slice(1, -1) : out;
    expect(unquoted).toBe(`'${prefix}SUM(A1)`);
  });

  it("quotes a neutralized cell that also needs quoting", () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvCell("\rX")).toBe(`"'\rX"`);
  });

  it("does not neutralize prefixes that are not at the start, or negative numbers", () => {
    expect(csvCell("A=B")).toBe("A=B");
    expect(csvCell("A-1")).toBe("A-1");
    expect(csvCell(-1)).toBe("-1");
  });
});

describe("toCsv", () => {
  it("uses the future_query_results columns", () => {
    expect(CSV_COLUMNS).toEqual(PART_COLUMNS);
    expect(CSV_COLUMNS).toEqual(QUERY_COLUMNS);
  });

  it("gives the header only for an empty result", () => {
    expect(toCsv(stored([]))).toBe(`${PART_COLUMNS.join(",")}\r\n`);
  });

  it("writes one CRLF-terminated row per part, in input order", () => {
    const csv = toCsv(
      stored([
        found("A1"),
        { part_number: "MISS", quantity: 1, quantity_given: false, status: "not_found" },
      ]),
    );
    expect(csv).toBe(
      [
        PART_COLUMNS.join(","),
        "A1,MPN-A1,found,,100,500,10,12 Weeks,USD,0.8",
        "MISS,,not_found,not_found,1,,,,,",
        "",
      ].join("\r\n"),
    );
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("joins multiple problem reasons with ; and quotes awkward part numbers", () => {
    const csv = toCsv(
      stored([found('X,"Y"', { quantity: 5, quantity_available: 1, quantity_minimum: 10, lead_time: "CALL" })]),
    );
    const row = csv.split("\r\n")[1]!;
    expect(row.startsWith('"X,""Y""",')).toBe(true);
    expect(row).toContain("short_stock;below_moq;call_for_leadtime");
  });

  it("neutralizes formula injection in data cells", () => {
    const csv = toCsv(stored([found("=cmd|'/C calc'!A0", { mpn: "@SUM(1)", lead_time: "-2+3" })]));
    const row = csv.split("\r\n")[1]!;
    expect(row).toMatch(/^'=cmd\|'\/C calc'!A0,'@SUM\(1\),found,/);
    expect(row).toContain(",'-2+3,");
  });

  it("keeps a newline inside a quoted cell", () => {
    const csv = toCsv(stored([found("A\nB")]));
    expect(csv.split("\r\n")[1]!.startsWith('"A\nB",')).toBe(true);
  });
});

describe("toJson", () => {
  it("round-trips the full stored result with id and note", () => {
    const s = stored([found("A1"), found("B2")]);
    const json = toJson("rid-1", s);
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({ result_id: "rid-1", note: PRICING_DISCLAIMER, ...s });
  });

  it("keeps raw batches", () => {
    const s = stored([found("A1")]);
    expect(JSON.parse(toJson("x", s)).batches).toEqual(s.batches);
  });

  it("handles an empty result", () => {
    expect(JSON.parse(toJson("x", stored([]))).parts).toEqual([]);
  });
});

describe("exportTimestamp / exportFileName", () => {
  it("formats UTC as YYYYMMDD-HHMMSS", () => {
    expect(exportTimestamp(FIXED)).toBe("20261007-030405");
    expect(exportTimestamp(new Date(Date.UTC(1999, 11, 31, 23, 59, 59, 999)))).toBe("19991231-235959");
  });

  it("builds names with the id, format and an optional suffix", () => {
    expect(exportFileName("abc-123", "csv", FIXED)).toBe("20261007-030405-abc-123.csv");
    expect(exportFileName("abc", "json", FIXED, 3)).toBe("20261007-030405-abc-3.json");
  });

  it("replaces unsafe id characters and caps the length", () => {
    expect(exportFileName("../a/b c", "csv", FIXED)).toBe("20261007-030405-___a_b_c.csv");
    expect(exportFileName("", "csv", FIXED)).toBe("20261007-030405-result.csv");
    expect(exportFileName("x".repeat(200), "csv", FIXED)).toBe(`20261007-030405-${"x".repeat(64)}.csv`);
  });
});

describe("writeExport", () => {
  let base: string;
  let ws: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "fe-export-")));
    ws = join(base, "ws");
    vi.stubEnv("FUTURE_WORKSPACE_DIR", ws);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (!isWindows) {
      try {
        chmodSync(join(ws, EXPORTS_DIR), 0o700);
      } catch {
        // not created
      }
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("creates the workspace and exports/ and writes CSV there (FUTURE_WORKSPACE_DIR)", async () => {
    const s = stored([found("A1"), found("B2")]);
    const file = await writeExport("rid", s, "csv", { now: clock });
    expect(file).toEqual({
      format: "csv",
      path: "exports/20261007-030405-rid.csv",
      rows: 2,
      bytes: Buffer.byteLength(toCsv(s)),
    });
    expect(readFileSync(join(ws, file.path), "utf8")).toBe(toCsv(s));
    expect(readdirSync(base)).toEqual(["ws"]);
    expect(readdirSync(ws)).toEqual([EXPORTS_DIR]);
    if (!isWindows) expect(statSync(join(ws, EXPORTS_DIR)).mode & 0o777).toBe(0o700);
  });

  it("writes JSON", async () => {
    const s = stored([found("A1")]);
    const file = await writeExport("rid", s, "json", { now: clock, root: ws });
    expect(file.path).toBe("exports/20261007-030405-rid.json");
    expect(file.rows).toBe(1);
    expect(JSON.parse(readFileSync(join(ws, file.path), "utf8")).parts).toEqual(s.parts);
  });

  it("counts bytes, not characters", async () => {
    const s = stored([found("µ-Ω")]);
    const file = await writeExport("rid", s, "csv", { now: clock, root: ws });
    expect(file.bytes).toBe(statSync(join(ws, file.path)).size);
    expect(file.bytes).toBeGreaterThan(toCsv(s).length);
  });

  it("writes the header only for an empty result", async () => {
    const file = await writeExport("rid", stored([]), "csv", { now: clock, root: ws });
    expect(file.rows).toBe(0);
    expect(readFileSync(join(ws, file.path), "utf8")).toBe(`${PART_COLUMNS.join(",")}\r\n`);
  });

  it("reuses an existing exports/ folder and never overwrites", async () => {
    mkdirSync(join(ws, EXPORTS_DIR), { recursive: true });
    writeFileSync(join(ws, EXPORTS_DIR, "keep.txt"), "x");
    const a = await writeExport("rid", stored([found("A")]), "csv", { now: clock, root: ws });
    const b = await writeExport("rid", stored([found("B")]), "csv", { now: clock, root: ws });
    expect(a.path).toBe("exports/20261007-030405-rid.csv");
    expect(b.path).toBe("exports/20261007-030405-rid-2.csv");
    expect(readFileSync(join(ws, a.path), "utf8")).toContain("\r\nA,");
    expect(readFileSync(join(ws, b.path), "utf8")).toContain("\r\nB,");
    expect(readFileSync(join(ws, EXPORTS_DIR, "keep.txt"), "utf8")).toBe("x");
  });

  it("gives up after too many name collisions", async () => {
    mkdirSync(join(ws, EXPORTS_DIR), { recursive: true });
    for (let n = 1; n <= 100; n++) {
      writeFileSync(join(ws, EXPORTS_DIR, exportFileName("rid", "csv", FIXED, n)), "");
    }
    await expect(writeExport("rid", stored([]), "csv", { now: clock, root: ws })).rejects.toThrow(
      /Too many exports/,
    );
  });

  it("keeps an unsafe result_id inside exports/", async () => {
    const file = await writeExport("../../evil", stored([]), "csv", { now: clock, root: ws });
    expect(file.path).toBe("exports/20261007-030405-______evil.csv");
    expect(existsSync(join(ws, file.path))).toBe(true);
  });

  it("uses the real clock by default", async () => {
    const file = await writeExport("rid", stored([]), "json", { root: ws });
    expect(file.path).toMatch(/^exports\/\d{8}-\d{6}-rid\.json$/);
  });

  it.skipIf(isWindows)("rejects an exports/ symlink that leads outside, writing nothing", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(ws);
    symlinkSync(outside, join(ws, EXPORTS_DIR));
    const err = await writeExport("rid", stored([]), "csv", { now: clock, root: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).not.toContain(base);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("fails with a WorkspaceError when exports/ is a file", async () => {
    mkdirSync(ws);
    writeFileSync(join(ws, EXPORTS_DIR), "not a folder");
    const err = await writeExport("rid", stored([]), "csv", { now: clock, root: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toMatch(/Cannot (create|write|check)/);
    expect(err.message).not.toContain(base);
  });

  it.skipIf(isWindows || isRoot)("fails with a WorkspaceError when exports/ is not writable", async () => {
    mkdirSync(join(ws, EXPORTS_DIR), { recursive: true });
    chmodSync(join(ws, EXPORTS_DIR), 0o500);
    const err = await writeExport("rid", stored([]), "csv", { now: clock, root: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toMatch(/^Cannot write "exports\/20261007-030405-rid\.csv" \(EACCES\)\.$/);
  });

  it("fails with a WorkspaceError when the workspace cannot be created", async () => {
    writeFileSync(join(base, "file"), "x");
    const err = await writeExport("rid", stored([]), "csv", { root: join(base, "file", "ws") }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).not.toContain(base);
  });

  it("throws ConfigError for a relative FUTURE_WORKSPACE_DIR", async () => {
    vi.stubEnv("FUTURE_WORKSPACE_DIR", "relative/dir");
    await expect(writeExport("rid", stored([]), "csv")).rejects.toBeInstanceOf(ConfigError);
  });
});
