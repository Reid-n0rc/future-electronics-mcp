import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FutureClient } from "../../src/client.js";
import { PRICING_DISCLAIMER } from "../../src/format.js";
import { BUDGET_EXCEEDED, estimateTokens } from "../../src/output.js";
import { ResultStore, defaultResultStore, unknownResultMessage } from "../../src/results.js";
import { createServer } from "../../src/server.js";
import type { ClientProvider } from "../../src/tools/common.js";
import {
  LOOKUP_PARTS_DESCRIPTION,
  LOOKUP_PARTS_TOOL_NAME,
  PART_COLUMNS,
  TRUNCATION_HINT,
  lookupParts,
  type LookupTotals,
  type PartResult,
} from "../../src/tools/lookupParts.js";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  PART_STATUSES,
  QUERY_COLUMNS,
  QUERY_RESULTS_DESCRIPTION,
  QUERY_RESULTS_TOOL_NAME,
  QUERY_TRUNCATION_HINT,
  filterParts,
  queryResults,
  registerQueryResultsTool,
  type QueryResultsInput,
} from "../../src/tools/queryResults.js";
import type { BatchLookupResponse } from "../../src/types.js";

// ---------- fixtures ----------

const found = (
  part_number: string,
  extra: Partial<PartResult> = {},
): PartResult => ({
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

/** One part per status and problem kind. */
const PARTS: PartResult[] = [
  found("CLEAN-1"),
  found("SHORT-1", { quantity: 1000, quantity_available: 200, lead_time: "20 Weeks" }),
  found("MOQ-1", { quantity: 5, quantity_minimum: 10, lead_time: "CALL" }),
  { part_number: "MISS-1", quantity: 1, quantity_given: false, status: "not_found" },
  { part_number: "ERR-1", quantity: 1, quantity_given: false, status: "error", error: "boom" },
  {
    part_number: "SKIP-1",
    quantity: 1,
    quantity_given: false,
    status: "not_attempted",
    error: "Not attempted",
  },
  found("NOQTY-1", {
    quantity: 1,
    quantity_given: false,
    quantity_available: undefined,
    lead_time: "6 Weeks",
    price: { price_break: null, reason: "below_minimum", quantity_minimum: 100 },
  }),
];

const totals: LookupTotals = {
  requested: 7,
  unique: 7,
  found: 4,
  not_found: 1,
  errors: 1,
  not_attempted: 1,
  short_stock: 1,
  below_moq: 1,
  call_for_leadtime: 1,
  batches: 1,
  rate_limited: false,
};

const BIG = 100_000;

function storeWith(parts: PartResult[] = PARTS) {
  const store = new ResultStore();
  const id = store.put({ parts, batches: [], totals });
  return { store, id };
}

function run(input: Partial<QueryResultsInput>, parts = PARTS, budget = BIG) {
  const { store, id } = storeWith(parts);
  const res = queryResults({ result_id: id, ...input }, store, budget);
  const text = (res.content[0] as { text: string }).text;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json, id };
}

const names = (json: any): string[] =>
  json.rows.map((r: unknown[]) => r[json.columns.indexOf("part_number")]);

beforeEach(() => {
  vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", String(BIG));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------- constants ----------

describe("constants", () => {
  it("lists exactly the statuses lookupParts emits and the detail-all columns", () => {
    expect([...PART_STATUSES].sort()).toEqual(["error", "found", "not_attempted", "not_found"]);
    expect(QUERY_COLUMNS).toEqual(PART_COLUMNS);
    expect(DEFAULT_QUERY_LIMIT).toBe(50);
    expect(MAX_QUERY_LIMIT).toBe(500);
  });

  it("describes the query tool and points the lookup tool at it", () => {
    expect(QUERY_RESULTS_DESCRIPTION).toContain("without calling the Future API");
    for (const s of PART_STATUSES) expect(QUERY_RESULTS_DESCRIPTION).toContain(s);
    for (const c of QUERY_COLUMNS) expect(QUERY_RESULTS_DESCRIPTION).toContain(c);
    expect(LOOKUP_PARTS_DESCRIPTION).toContain("result_id");
    expect(LOOKUP_PARTS_DESCRIPTION).toContain(QUERY_RESULTS_TOOL_NAME);
    expect(TRUNCATION_HINT).toContain(QUERY_RESULTS_TOOL_NAME);
  });
});

// ---------- filterParts ----------

describe("filterParts", () => {
  const pick = (input: Partial<QueryResultsInput>) =>
    filterParts(PARTS, { result_id: "x", ...input }).map((p) => p.part_number);

  it("returns every part, in order, with no filters", () => {
    expect(pick({})).toEqual(PARTS.map((p) => p.part_number));
  });

  it("filters by one or several statuses", () => {
    expect(pick({ status: ["found"] })).toEqual(["CLEAN-1", "SHORT-1", "MOQ-1", "NOQTY-1"]);
    expect(pick({ status: ["not_found", "error"] })).toEqual(["MISS-1", "ERR-1"]);
    expect(pick({ status: ["not_attempted"] })).toEqual(["SKIP-1"]);
  });

  it("filters by minimum lead time in weeks, excluding CALL and unknown", () => {
    expect(pick({ min_lead_time_weeks: 12 })).toEqual(["CLEAN-1", "SHORT-1"]);
    expect(pick({ min_lead_time_weeks: 12.5 })).toEqual(["SHORT-1"]);
    expect(pick({ min_lead_time_weeks: 0 })).toEqual(["CLEAN-1", "SHORT-1", "NOQTY-1"]);
    expect(pick({ min_lead_time_weeks: 21 })).toEqual([]);
  });

  it("compares lead times across units", () => {
    const parts = [found("D", { lead_time: "30 Days" }), found("M", { lead_time: "2 Months" })];
    const got = filterParts(parts, { result_id: "x", min_lead_time_weeks: 5 });
    expect(got.map((p) => p.part_number)).toEqual(["M"]);
  });

  it("filters short_stock true and false", () => {
    expect(pick({ short_stock: true })).toEqual(["SHORT-1"]);
    expect(pick({ short_stock: false })).not.toContain("SHORT-1");
    expect(pick({ short_stock: false })).toHaveLength(PARTS.length - 1);
  });

  it("filters below_moq true and false (only for given quantities)", () => {
    expect(pick({ below_moq: true })).toEqual(["MOQ-1"]);
    expect(pick({ below_moq: false })).toHaveLength(PARTS.length - 1);
  });

  it("filters part_numbers case-insensitively and trimmed, ignoring unknown names", () => {
    expect(pick({ part_numbers: [" clean-1 ", "err-1", "NOPE"] })).toEqual(["CLEAN-1", "ERR-1"]);
  });

  it("combines filters with AND", () => {
    expect(pick({ status: ["found"], min_lead_time_weeks: 10, short_stock: false })).toEqual([
      "CLEAN-1",
    ]);
    expect(pick({ part_numbers: ["MISS-1"], status: ["found"] })).toEqual([]);
  });
});

// ---------- queryResults ----------

describe("queryResults", () => {
  it("returns every column by default, with totals and paging fields", () => {
    const { res, text, json, id } = run({});
    expect(res.isError).toBeUndefined();
    expect(text).not.toContain("\n");
    expect(json).toEqual({
      result_id: id,
      note: PRICING_DISCLAIMER,
      total_matching: PARTS.length,
      offset: 0,
      next_offset: null,
      columns: PART_COLUMNS,
      rows: expect.any(Array),
    });
    expect(json.rows).toHaveLength(PARTS.length);
    expect(json.rows[1]).toEqual([
      "SHORT-1", "MPN-SHORT-1", "found", "short_stock", 1000, 200, 10, "20 Weeks", "USD", 0.8,
    ]);
    expect(json.rows[4]).toEqual(["ERR-1", null, "error", "error: boom", 1, null, null, null, null, null]);
    // No applicable price break: unit_price is null.
    expect(json.rows[6]![9]).toBeNull();
  });

  it("returns only the requested fields, in the requested order", () => {
    const { json } = run({ fields: ["lead_time", "part_number"], status: ["found"] });
    expect(json.columns).toEqual(["lead_time", "part_number"]);
    expect(json.rows).toEqual([
      ["12 Weeks", "CLEAN-1"],
      ["20 Weeks", "SHORT-1"],
      ["CALL", "MOQ-1"],
      ["6 Weeks", "NOQTY-1"],
    ]);
  });

  it("rejects unknown fields with a list of the valid ones", () => {
    const { res, text } = run({ fields: ["part_number", "colour", "size"] });
    expect(res.isError).toBe(true);
    expect(text).toContain("colour, size");
    expect(text).toContain(`Valid fields: ${PART_COLUMNS.join(", ")}`);
  });

  it("pages with offset and limit and reports next_offset", () => {
    const first = run({ limit: 3, fields: ["part_number"] }).json;
    expect(names(first)).toEqual(["CLEAN-1", "SHORT-1", "MOQ-1"]);
    expect(first).toMatchObject({ total_matching: 7, offset: 0, next_offset: 3 });
    const last = run({ offset: 6, limit: 3, fields: ["part_number"] }).json;
    expect(names(last)).toEqual(["NOQTY-1"]);
    expect(last.next_offset).toBeNull();
    const exact = run({ offset: 4, limit: 3 }).json;
    expect(exact.rows).toHaveLength(3);
    expect(exact.next_offset).toBeNull();
  });

  it("returns no rows for an offset past the end", () => {
    const { res, json } = run({ offset: 100 });
    expect(res.isError).toBeUndefined();
    expect(json).toMatchObject({ total_matching: 7, offset: 100, next_offset: null, rows: [] });
  });

  it("uses the default limit of 50", () => {
    const parts = Array.from({ length: 120 }, (_, i) => found(`P-${i}`));
    const { json } = run({}, parts);
    expect(json.rows).toHaveLength(DEFAULT_QUERY_LIMIT);
    expect(json.next_offset).toBe(50);
    expect(json.total_matching).toBe(120);
  });

  it("counts total_matching after filters, before paging", () => {
    const { json } = run({ status: ["found"], limit: 1 });
    expect(json.total_matching).toBe(4);
    expect(json.rows).toHaveLength(1);
    expect(json.next_offset).toBe(1);
  });

  it("returns a clear error for an unknown result_id", () => {
    const store = new ResultStore();
    const res = queryResults({ result_id: "nope" }, store, BIG);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe(unknownResultMessage("nope"));
  });

  it("returns the same error once a result has expired (fake clock)", () => {
    let t = 0;
    const store = new ResultStore({ now: () => t, ttlMs: 1000 });
    const id = store.put({ parts: PARTS, batches: [], totals });
    expect(queryResults({ result_id: id }, store, BIG).isError).toBeUndefined();
    t += 999; // the query above refreshed the TTL at t=0
    expect(queryResults({ result_id: id }, store, BIG).isError).toBeUndefined();
    t += 1000;
    const res = queryResults({ result_id: id }, store, BIG);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("Unknown or expired");
  });

  it("reads the budget from FUTURE_MAX_OUTPUT_TOKENS and reports a bad value as an error", () => {
    const { store, id } = storeWith();
    vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "abc");
    const res = queryResults({ result_id: id }, store);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("FUTURE_MAX_OUTPUT_TOKENS");
  });

  it("defaults to the shared store", () => {
    const id = defaultResultStore.put({ parts: PARTS, batches: [], totals });
    const res = queryResults({ result_id: id }, undefined, BIG);
    expect(res.isError).toBeUndefined();
  });
});

describe("queryResults output budget", () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    found(`LONG-PART-NUMBER-${String(i).padStart(4, "0")}`),
  );

  it("stays within the budget for the maximum limit, dropping rows and pointing at next_offset", () => {
    const budget = 1000;
    const { res, text, json } = run({ limit: MAX_QUERY_LIMIT }, many, budget);
    expect(res.isError).toBeUndefined();
    expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    expect(json.rows.length).toBeGreaterThan(0);
    expect(json.rows.length).toBeLessThan(500);
    expect(json.truncated).toEqual({ omitted: 500 - json.rows.length, hint: QUERY_TRUNCATION_HINT });
    expect(json.next_offset).toBe(json.rows.length);
    expect(json.total_matching).toBe(500);
  });

  it("fits more rows when fewer fields are requested", () => {
    const all = run({ limit: MAX_QUERY_LIMIT }, many, 1000).json;
    const one = run({ limit: MAX_QUERY_LIMIT, fields: ["status"] }, many, 1000).json;
    expect(one.rows.length).toBeGreaterThan(all.rows.length);
  });

  it("stays within budget for every page size near the edge", () => {
    for (const budget of [1000, 1003, 1500, 2000]) {
      for (const limit of [1, 37, 499, 500]) {
        const { text, json } = run({ limit, offset: 3 }, many, budget);
        expect(budgetTokens(text)).toBeLessThanOrEqual(budget);
        const end = 3 + json.rows.length;
        expect(json.next_offset).toBe(end < 500 ? end : null);
      }
    }
  });

  it("reports a budget error when not even the header fits", () => {
    const { res, json } = run({}, PARTS, 10);
    expect(res.isError).toBe(true);
    expect(json.error).toBe(BUDGET_EXCEEDED);
  });
});

/** Tokens as the budget counts them (characters / 4, rounded up). */
const budgetTokens = (text: string) => Math.ceil(text.length / 4);

// ---------- over MCP, with a real lookup first ----------

const echoResponse = (parts: string[]): BatchLookupResponse => ({
  lookup_parts: parts.map((p) => ({
    part_number: p,
    lookup_results: "",
    offers: p.startsWith("MISS")
      ? []
      : [
          {
            part_id: { mpn: `MPN-${p}` },
            quantities: {
              quantity_available: p.startsWith("SHORT") ? 5 : 500,
              factory_leadtime: p.startsWith("SLOW") ? "30" : "12",
              factory_leadtime_units: "Weeks",
            },
            currency: { currency_code: "USD" },
            pricing: [{ quantity_from: 1, quantity_to: null, unit_price: 2 }],
          },
        ],
  })),
});

const open: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connect(getClient: ClientProvider) {
  const server = createServer(getClient);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push({ client, server });
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

describe("future_query_results over MCP", () => {
  it("is listed as read-only with its input schema", async () => {
    const client = await connect(() => {
      throw new Error("client must not be created");
    });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === QUERY_RESULTS_TOOL_NAME)!;
    expect(tool.description).toBe(QUERY_RESULTS_DESCRIPTION);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
      [
        "below_moq", "fields", "limit", "min_lead_time_weeks", "offset", "part_numbers",
        "result_id", "short_stock", "status",
      ].sort(),
    );
    expect(tool.inputSchema.required).toEqual(["result_id"]);
  });

  it("queries a stored lookup without ever calling the API", async () => {
    const stub = {
      lookup: vi.fn(),
      batchLookup: vi.fn(async (parts: string[]) => echoResponse(parts)),
    };
    let apiAllowed = true;
    const getClient = vi.fn(() => {
      if (!apiAllowed) throw new Error("the query tool must not create a client");
      return stub as unknown as FutureClient;
    });
    const client = await connect(getClient);

    const bom = ["CLEAN-1", "SHORT-1", "SLOW-1", "MISS-1"].map((part_number) => ({
      part_number,
      quantity: 10,
    }));
    const lookup = await callTool(client, LOOKUP_PARTS_TOOL_NAME, { parts: bom });
    expect(lookup.json.result_id).toMatch(/^[0-9a-f-]{36}$/);
    // The summary lists problem parts only; CLEAN-1 and SLOW-1 are not in it.
    expect(lookup.json.issues.rows.map((r: unknown[]) => r[0])).toEqual(["SHORT-1", "MISS-1"]);
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);

    // From here on, any API use throws.
    apiAllowed = false;
    stub.batchLookup.mockImplementation(async () => {
      throw new Error("API called");
    });
    stub.lookup.mockImplementation(async () => {
      throw new Error("API called");
    });
    const callsBefore = getClient.mock.calls.length;

    const all = await callTool(client, QUERY_RESULTS_TOOL_NAME, {
      result_id: lookup.json.result_id,
      fields: ["part_number", "status", "available", "lead_time"],
    });
    expect(all.res.isError).toBeFalsy();
    expect(all.json.rows).toEqual([
      ["CLEAN-1", "found", 500, "12 Weeks"],
      ["SHORT-1", "found", 5, "12 Weeks"],
      ["SLOW-1", "found", 500, "30 Weeks"],
      ["MISS-1", "not_found", null, null],
    ]);
    const slow = await callTool(client, QUERY_RESULTS_TOOL_NAME, {
      result_id: lookup.json.result_id,
      min_lead_time_weeks: 20,
      fields: ["part_number"],
    });
    expect(slow.json.rows).toEqual([["SLOW-1"]]);
    const short = await callTool(client, QUERY_RESULTS_TOOL_NAME, {
      result_id: lookup.json.result_id,
      short_stock: true,
      part_numbers: ["short-1", "clean-1"],
    });
    expect(short.json.total_matching).toBe(1);

    expect(getClient.mock.calls.length).toBe(callsBefore);
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);
    expect(stub.lookup).not.toHaveBeenCalled();
  });

  it("stores every part and the raw batch responses, not just the problems", async () => {
    const store = new ResultStore();
    const stub = { lookup: vi.fn(), batchLookup: vi.fn(async (p: string[]) => echoResponse(p)) };
    const res = await lookupParts(
      { parts: ["CLEAN-1", "SHORT-1", "x"] },
      () => stub as unknown as FutureClient,
      BIG,
      store,
    );
    const id = JSON.parse((res.content[0] as { text: string }).text).result_id;
    const stored = store.get(id)!;
    expect(stored.parts.map((p) => [p.part_number, p.status])).toEqual([
      ["CLEAN-1", "found"],
      ["SHORT-1", "found"],
      ["x", "error"],
    ]);
    expect(stored.batches).toEqual([
      { part_numbers: ["CLEAN-1", "SHORT-1"], response: echoResponse(["CLEAN-1", "SHORT-1"]) },
    ]);
    expect(stored.totals).toMatchObject({ unique: 3, found: 2, errors: 1 });
  });

  it("includes result_id in raw and detail-all output too", async () => {
    const provider = () =>
      ({ lookup: vi.fn(), batchLookup: async (p: string[]) => echoResponse(p) }) as unknown as FutureClient;
    for (const extra of [{ raw: true }, { detail: "all" as const }]) {
      const store = new ResultStore({ newId: () => "rid" });
      const res = await lookupParts({ parts: ["CLEAN-1"], ...extra }, provider, BIG, store);
      expect(JSON.parse((res.content[0] as { text: string }).text).result_id).toBe("rid");
    }
  });

  it("returns an isError result for an unknown result_id", async () => {
    const client = await connect(() => {
      throw new Error("no client");
    });
    const { res, text } = await callTool(client, QUERY_RESULTS_TOOL_NAME, { result_id: "missing" });
    expect(res.isError).toBe(true);
    expect(text).toBe(unknownResultMessage("missing"));
  });

  it("rejects an unknown field and status in the schema with the valid values", async () => {
    const client = await connect(() => {
      throw new Error("no client");
    });
    const bad = await callTool(client, QUERY_RESULTS_TOOL_NAME, { result_id: "r", fields: ["bogus"] });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain(`Valid fields: ${QUERY_COLUMNS.join(", ")}`);
    const st = await callTool(client, QUERY_RESULTS_TOOL_NAME, { result_id: "r", status: ["ok"] });
    expect(st.res.isError).toBe(true);
    expect(st.text).toContain(`Valid statuses: ${PART_STATUSES.join(", ")}`);
  });

  it("rejects out-of-range paging and other invalid input", async () => {
    const client = await connect(() => {
      throw new Error("no client");
    });
    for (const args of [
      { result_id: "r", limit: 0 },
      { result_id: "r", limit: MAX_QUERY_LIMIT + 1 },
      { result_id: "r", limit: 1.5 },
      { result_id: "r", offset: -1 },
      { result_id: "r", min_lead_time_weeks: -1 },
      { result_id: "" },
      { result_id: "r", status: [] },
      { result_id: "r", fields: [] },
      {},
    ]) {
      const { res } = await callTool(client, QUERY_RESULTS_TOOL_NAME, args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
  });
});

describe("registerQueryResultsTool", () => {
  it("registers once on a bare server with its own store", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const store = new ResultStore({ newId: () => "own" });
    store.put({ parts: PARTS, batches: [], totals });
    registerQueryResultsTool(server, store);
    expect(() => registerQueryResultsTool(server, store)).toThrow();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    open.push({ client, server });
    const { json } = await callTool(client, QUERY_RESULTS_TOOL_NAME, { result_id: "own", limit: 2 });
    expect(json.rows).toHaveLength(2);
    expect(json.next_offset).toBe(2);
  });
});
