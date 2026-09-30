import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FutureApiError, FutureClient, MAX_BATCH_PARTS } from "../../src/client.js";
import { ConfigError } from "../../src/config.js";
import { PRICING_DISCLAIMER } from "../../src/format.js";
import { estimateTokens } from "../../src/output.js";
import { createServer } from "../../src/server.js";
import type { ClientProvider } from "../../src/tools/common.js";
import {
  DEFAULT_QUANTITY,
  ISSUE_COLUMNS,
  LOOKUP_PARTS_DESCRIPTION,
  LOOKUP_PARTS_TOOL_NAME,
  MAX_LOOKUP_PARTS,
  NOT_ATTEMPTED_MESSAGE,
  PART_COLUMNS,
  TRUNCATION_HINT,
  bestOffer,
  chunk,
  dedupeParts,
  extendedCost,
  leadTimeDays,
  lookupParts,
  maxLeadTime,
  partsTable,
  poolSize,
  problemReasons,
  registerLookupPartsTool,
  type PartResult,
} from "../../src/tools/lookupParts.js";
import type { BatchLookupResponse, Offer, PartLookupResponse } from "../../src/types.js";

// ---------- fixtures ----------

const offer = (available: number | undefined, extra: Partial<Offer> = {}): Offer => ({
  part_id: { mpn: `MPN-${available}` },
  quantities: {
    quantity_available: available,
    factory_leadtime: "12",
    factory_leadtime_units: "Weeks",
  },
  currency: { currency_code: "USD" },
  pricing: [
    { quantity_from: 1, quantity_to: 99, unit_price: 1.0 },
    { quantity_from: 100, quantity_to: 999, unit_price: 0.8 },
    { quantity_from: 1000, quantity_to: null, unit_price: 0.5 },
  ],
  ...extra,
});

/** Every part found with one offer, except parts whose name starts with "MISS". */
const echoResponse = (parts: string[]): BatchLookupResponse => ({
  lookup_parts: parts.map((p) => ({
    part_number: p,
    lookup_results: p.startsWith("MISS") ? "0 Offers found" : "1 Offer found",
    offers: p.startsWith("MISS") ? [] : [offer(500)],
  })),
});

type Stub = { lookup: ReturnType<typeof vi.fn>; batchLookup: ReturnType<typeof vi.fn> };

function stubClient(impl?: (parts: string[]) => Promise<BatchLookupResponse>): Stub {
  return {
    lookup: vi.fn(),
    batchLookup: vi.fn(impl ?? (async (parts: string[]) => echoResponse(parts))),
  };
}

const providerFor = (stub: Stub): ClientProvider => () => stub as unknown as FutureClient;

const partNames = (n: number, prefix = "PART") =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

// A roomy budget so these tests see every row; budget tests set their own.
beforeEach(() => {
  vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "100000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Rows of a `{columns, rows}` table as objects keyed by column name. */
const asObjects = (table: { columns: string[]; rows: unknown[][] }): any[] =>
  table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
/** Every part from a `detail: "all"` result. */
const allParts = (json: any): any[] => asObjects(json.parts);

// ---------- MCP harness ----------

async function connect(getClient: ClientProvider) {
  const server = createServer(getClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const open: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function call(getClient: ClientProvider, args: Record<string, unknown>) {
  const conn = await connect(getClient);
  open.push(conn);
  const res = await conn.client.callTool({ name: LOOKUP_PARTS_TOOL_NAME, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]!.text;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

// ---------- pure helpers ----------

describe("dedupeParts", () => {
  it("trims and dedupes case-insensitively, keeping first spelling and order", () => {
    expect(dedupeParts([" lm317t ", "LM317T", "NE555", "ne555 "])).toEqual([
      { part_number: "lm317t" },
      { part_number: "NE555" },
    ]);
  });

  it("sums quantities of duplicates", () => {
    expect(
      dedupeParts([
        { part_number: "ABC123", quantity: 10 },
        { part_number: "abc123", quantity: 15 },
        "ABC123",
      ]),
    ).toEqual([{ part_number: "ABC123", quantity: 25 }]);
  });

  it("takes a later quantity when the first occurrence had none", () => {
    expect(dedupeParts(["ABC123", { part_number: "abc123", quantity: 7 }])).toEqual([
      { part_number: "ABC123", quantity: 7 },
    ]);
  });

  it("keeps distinct parts separate and returns empty for empty input", () => {
    expect(dedupeParts(["AAA1", "AAA2"])).toHaveLength(2);
    expect(dedupeParts([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [{ part_number: " X12 ", quantity: 1 }, { part_number: "x12", quantity: 2 }];
    dedupeParts(input);
    expect(input[0]).toEqual({ part_number: " X12 ", quantity: 1 });
  });
});

describe("chunk", () => {
  it("splits into chunks of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("handles exact multiples and empty input", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("rejects a non-positive or non-integer size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});

describe("bestOffer", () => {
  it("picks the offer with the most stock", () => {
    const a = offer(10);
    const b = offer(900);
    const c = offer(50);
    expect(bestOffer([a, b, c])).toBe(b);
  });

  it("keeps the first offer on ties", () => {
    const a = offer(5);
    const b = offer(5);
    expect(bestOffer([a, b])).toBe(a);
  });

  it("treats missing stock as less than zero stock", () => {
    const noStock = offer(undefined);
    const zero = offer(0);
    expect(bestOffer([noStock, zero])).toBe(zero);
    expect(bestOffer([noStock])).toBe(noStock);
  });

  it("returns undefined for no offers", () => {
    expect(bestOffer([])).toBeUndefined();
  });
});

// ---------- lookupParts (direct) ----------

describe("lookupParts", () => {
  it("does not create a client when every part is invalid, and flags isError", async () => {
    const getClient = vi.fn(() => {
      throw new Error("should not be called");
    });
    const res = await lookupParts({ parts: ["ab", "-"] }, getClient);
    expect(getClient).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.totals).toEqual({
      requested: 2,
      unique: 2,
      found: 0,
      not_found: 0,
      errors: 2,
      not_attempted: 0,
      short_stock: 0,
      below_moq: 0,
      call_for_leadtime: 0,
      batches: 0,
      rate_limited: false,
    });
    expect(json.issues.rows[0][2]).toMatch(/^error: .*at least 3 alphanumeric/);
  });

  it("returns a key-free error result when the client cannot be created", async () => {
    const res = await lookupParts({ parts: ["LM317T"] }, () => {
      throw new ConfigError("FUTURE_API_KEY is not set.");
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("FUTURE_API_KEY is not set.");
  });
});

// ---------- through the MCP protocol ----------

describe("future_lookup_parts over MCP", () => {
  it("is listed with a description and input schema", async () => {
    const conn = await connect(providerFor(stubClient()));
    open.push(conn);
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === LOOKUP_PARTS_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/bill of materials/);
    expect(tool!.inputSchema.properties).toHaveProperty("parts");
    expect(tool!.inputSchema.properties).toHaveProperty("raw");
    expect(tool!.annotations?.readOnlyHint).toBe(true);
  });

  it("splits 650 parts into 3 sequential calls when maxConcurrency is absent", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const stub = stubClient(async (parts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return echoResponse(parts);
    });
    const names = partNames(650);
    const { res, json } = await call(providerFor(stub), { parts: names, detail: "all" });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup).toHaveBeenCalledTimes(3);
    const sizes = stub.batchLookup.mock.calls.map((c) => (c[0] as string[]).length);
    expect(sizes).toEqual([300, 300, 50]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BATCH_PARTS);
    expect(maxInFlight).toBe(1);
    expect(stub.batchLookup.mock.calls.flatMap((c) => c[0])).toEqual(names);
    expect(json.totals).toEqual({
      requested: 650,
      unique: 650,
      found: 650,
      not_found: 0,
      errors: 0,
      not_attempted: 0,
      short_stock: 0,
      below_moq: 0,
      call_for_leadtime: 0,
      batches: 3,
      rate_limited: false,
    });
    expect(json.parts.rows).toHaveLength(650);
    expect(json.note).toBe(PRICING_DISCLAIMER);
  });

  it("sends exactly 300 parts in one batch", async () => {
    const stub = stubClient();
    await call(providerFor(stub), { parts: partNames(300) });
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);
  });

  it("accepts the maximum of 2000 items (duplicates count toward requested)", async () => {
    const stub = stubClient();
    const names = [...partNames(1000), ...partNames(1000).map((p) => p.toLowerCase())];
    const { json } = await call(providerFor(stub), { parts: names });
    expect(json.totals.requested).toBe(MAX_LOOKUP_PARTS);
    expect(json.totals.unique).toBe(1000);
    expect(stub.batchLookup).toHaveBeenCalledTimes(4);
  });

  it("removes duplicates before sending and sums their quantities", async () => {
    const stub = stubClient();
    const { json } = await call(providerFor(stub), {
      parts: [
        " LM317T ",
        { part_number: "lm317t", quantity: 60 },
        { part_number: "LM317T", quantity: 50 },
        "NE555",
      ],
      detail: "all",
    });
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);
    expect(stub.batchLookup.mock.calls[0]![0]).toEqual(["LM317T", "NE555"]);
    expect(json.totals).toMatchObject({ requested: 4, unique: 2 });
    const lm = allParts(json)[0];
    expect(lm.part_number).toBe("LM317T");
    expect(lm.quantity).toBe(110);
    expect(lm.unit_price).toBe(0.8);
  });

  it("applies quantity pricing to the best (most stock) offer", async () => {
    const small = offer(10, {
      part_id: { mpn: "SMALL" },
      pricing: [{ quantity_from: 1, quantity_to: null, unit_price: 9 }],
    });
    const big = offer(5000, { part_id: { mpn: "BIG" } });
    const stub = stubClient(async (parts) => ({
      lookup_parts: parts.map((p) => ({ part_number: p, offers: [small, big] })),
    }));
    const { json } = await call(providerFor(stub), {
      parts: [
        { part_number: "QTY1", quantity: 5 },
        { part_number: "QTY2", quantity: 2500 },
        "QTY3",
      ],
      detail: "all",
    });
    expect(json.parts.columns).toEqual(PART_COLUMNS);
    const [p1, p2, p3] = allParts(json);
    expect(p1).toEqual({
      part_number: "QTY1",
      mpn: "BIG",
      status: "found",
      reason: "",
      quantity: 5,
      available: 5000,
      moq: null,
      lead_time: "12 Weeks",
      currency: "USD",
      unit_price: 1,
    });
    expect(p2.unit_price).toBe(0.5);
    expect(p3.quantity).toBe(DEFAULT_QUANTITY);
    expect(p3.unit_price).toBe(1);
    expect(json.extended_cost).toEqual({ USD: 5 * 1 + 2500 * 0.5 + 1 * 1 });
  });

  it("reports below_minimum and no_pricing reasons from priceAt", async () => {
    const moq = offer(100, { pricing: [{ quantity_from: 50, quantity_to: null, unit_price: 2 }] });
    const unpriced = offer(100, { pricing: [] });
    const stub = stubClient(async () => ({
      lookup_parts: [
        { part_number: "MOQ100", offers: [moq] },
        { part_number: "NOPRICE", offers: [unpriced] },
      ],
    }));
    const { json } = await call(providerFor(stub), {
      parts: [{ part_number: "MOQ100", quantity: 10 }, "NOPRICE"],
      detail: "all",
    });
    // No applicable break (below_minimum, no_pricing): no unit price, counted as unpriced.
    expect(allParts(json).map((p) => p.unit_price)).toEqual([null, null]);
    expect(json.unpriced).toBe(2);
    expect(json.extended_cost).toEqual({});
  });

  it("marks parts with no offers or no response entry as not_found", async () => {
    const stub = stubClient(async () => ({
      lookup_parts: [{ part_number: "MISS-1", offers: [] }],
    }));
    const { res, json } = await call(providerFor(stub), { parts: ["MISS-1", "GONE-2"] });
    expect(res.isError).toBeFalsy();
    expect(json.issues).toEqual({
      columns: ISSUE_COLUMNS,
      rows: [
        ["MISS-1", "not_found", "not_found", 1, null, null],
        ["GONE-2", "not_found", "not_found", 1, null, null],
      ],
    });
    expect(json.totals).toMatchObject({ found: 0, not_found: 2, errors: 0 });
  });

  it("matches response entries case-insensitively, and by position when unnamed", async () => {
    const stub = stubClient(async () => ({
      lookup_parts: [
        { part_number: "abc123", offers: [offer(1)] },
        { offers: [offer(2)] },
      ],
    }));
    const { json } = await call(providerFor(stub), { parts: ["ABC123", "DEF456"], detail: "all" });
    expect(allParts(json)[0]).toMatchObject({ status: "found", available: 1 });
    expect(allParts(json)[1]).toMatchObject({ status: "found", available: 2 });
  });

  it("still returns the other chunks when the middle chunk fails with a non-429 error", async () => {
    let n = 0;
    const stub = stubClient(async (parts) => {
      n++;
      if (n === 2) {
        throw new FutureApiError("Future API request failed with HTTP 503.", {
          code: "http",
          status: 503,
        });
      }
      return echoResponse(parts);
    });
    const names = partNames(650);
    const { res, json } = await call(providerFor(stub), { parts: names, detail: "all" });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup).toHaveBeenCalledTimes(3);
    expect(json.totals).toEqual({
      requested: 650,
      unique: 650,
      found: 350,
      not_found: 0,
      errors: 300,
      not_attempted: 0,
      short_stock: 0,
      below_moq: 0,
      call_for_leadtime: 0,
      batches: 3,
      rate_limited: false,
    });
    const parts = allParts(json);
    expect(parts.slice(0, 300).every((p: any) => p.status === "found")).toBe(true);
    expect(parts.slice(600).every((p: any) => p.status === "found")).toBe(true);
    for (const p of parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.reason).toBe("error: Future API request failed with HTTP 503.");
    }
  });

  it("stops after an unrecovered 429 when sequential: later batches are not_attempted", async () => {
    let n = 0;
    const stub = stubClient(async (parts) => {
      n++;
      if (n === 2) throw rateLimitError();
      return echoResponse(parts);
    });
    const names = partNames(650);
    const { res, json } = await call(providerFor(stub), { parts: names, detail: "all" });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    expect(json.totals).toEqual({
      requested: 650,
      unique: 650,
      found: 300,
      not_found: 0,
      errors: 300,
      not_attempted: 50,
      short_stock: 0,
      below_moq: 0,
      call_for_leadtime: 0,
      batches: 3,
      rate_limited: true,
    });
    const parts = allParts(json);
    for (const p of parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.reason).toMatch(/^error: Rate limited/);
    }
    for (const p of parts.slice(600)) {
      expect(p).toMatchObject({ quantity: 1, status: "not_attempted", reason: "not_attempted" });
    }
    expect(json.not_attempted_note).toBe(NOT_ATTEMPTED_MESSAGE);
  });

  it("uses a generic message for unexpected (non-API) errors so internals never leak", async () => {
    const stub = stubClient(async () => {
      throw new Error("secret internal detail test-key");
    });
    const { res, text, json } = await call(providerFor(stub), { parts: ["LM317T"] });
    expect(res.isError).toBe(true);
    expect(text).not.toContain("test-key");
    expect(text).not.toContain("secret internal");
    expect(json.issues.rows[0][2]).toBe(
      "error: Unexpected error while calling the Future Electronics API.",
    );
  });

  it("returns isError when every chunk fails", async () => {
    const stub = stubClient(async () => {
      throw new FutureApiError("Invalid API key: check the FUTURE_API_KEY environment variable.", {
        code: "http",
        status: 401,
      });
    });
    const { res, json } = await call(providerFor(stub), { parts: partNames(301) });
    expect(res.isError).toBe(true);
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    expect(json.totals).toMatchObject({ errors: 301, found: 0, batches: 2 });
  });

  it("reports invalid part numbers per part without failing the batch", async () => {
    const stub = stubClient();
    const { res, json } = await call(providerFor(stub), { parts: ["LM317T", "a-b", "NE555"] });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup.mock.calls[0]![0]).toEqual(["LM317T", "NE555"]);
    const [bad] = asObjects(json.issues);
    expect(json.issues.rows).toHaveLength(1);
    expect(bad).toMatchObject({ part_number: "a-b", status: "error" });
    expect(bad.reason).toMatch(/at least 3 alphanumeric/);
    expect(json.totals).toMatchObject({ found: 2, errors: 1, batches: 1 });
  });

  it("returns upstream responses per batch in raw mode", async () => {
    let n = 0;
    const stub = stubClient(async (parts) => {
      n++;
      if (n === 2) throw new FutureApiError("Bad request.", { code: "http", status: 400 });
      return echoResponse(parts);
    });
    const names = [...partNames(301), "x"];
    const { res, json } = await call(providerFor(stub), { parts: names, raw: true });
    expect(res.isError).toBeFalsy();
    expect(json.note).toBe(PRICING_DISCLAIMER);
    expect(json.parts).toBeUndefined();
    expect(json.issues).toBeUndefined();
    expect(json.batches).toHaveLength(2);
    expect(json.batches[0].part_numbers).toHaveLength(300);
    expect(json.batches[0].response).toEqual(echoResponse(names.slice(0, 300)));
    expect(json.batches[1]).toEqual({ part_numbers: ["PART-0300"], error: "Bad request." });
    expect(json.invalid_parts).toEqual([
      { part_number: "x", error: "Part number must contain at least 3 alphanumeric characters." },
    ]);
    expect(json.totals).toMatchObject({ found: 300, errors: 2, batches: 2 });
  });

  it("omits invalid_parts in raw mode when every part was sent", async () => {
    const { json } = await call(providerFor(stubClient()), { parts: ["LM317T"], raw: true });
    expect(json.invalid_parts).toBeUndefined();
    expect(json.batches).toHaveLength(1);
  });

  it("defaults raw to false and detail to summary", async () => {
    const { json } = await call(providerFor(stubClient()), { parts: ["LM317T"] });
    expect(json.issues).toEqual({ columns: ISSUE_COLUMNS, rows: [] });
    expect(json.parts).toBeUndefined();
    expect(json.batches).toBeUndefined();
  });

  it.each([
    ["whitespace-only string", { parts: ["   "] }],
    ["whitespace-only object part", { parts: [{ part_number: " \t " }] }],
    ["empty string", { parts: [""] }],
    ["empty array", { parts: [] }],
    ["too many parts", { parts: partNames(MAX_LOOKUP_PARTS + 1) }],
    ["zero quantity", { parts: [{ part_number: "LM317T", quantity: 0 }] }],
    ["negative quantity", { parts: [{ part_number: "LM317T", quantity: -5 }] }],
    ["fractional quantity", { parts: [{ part_number: "LM317T", quantity: 1.5 }] }],
    ["huge quantity", { parts: [{ part_number: "LM317T", quantity: 2e9 }] }],
    ["non-string part", { parts: [42] }],
    ["missing parts", {}],
    ["non-boolean raw", { parts: ["LM317T"], raw: "yes" }],
    ["unknown detail", { parts: ["LM317T"], detail: "full" }],
  ])("rejects invalid input: %s", async (_label, args) => {
    const stub = stubClient();
    const { res } = await call(providerFor(stub), args as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(stub.batchLookup).not.toHaveBeenCalled();
  });

  it("surfaces a missing FUTURE_API_KEY as a tool error at call time", async () => {
    const { res, text } = await call(
      () => {
        throw new ConfigError("FUTURE_API_KEY is not set.");
      },
      { parts: ["LM317T"] },
    );
    expect(res.isError).toBe(true);
    expect(text).toBe("FUTURE_API_KEY is not set.");
  });
});

// ---------- parallel batches (deterministic: gated batchLookup, no timers) ----------

function rateLimitError() {
  return new FutureApiError("Rate limited: too many requests to the Future API. Try again later.", {
    code: "http",
    status: 429,
  });
}

type Gate = {
  parts: string[];
  resolve: (r: BatchLookupResponse) => void;
  reject: (e: unknown) => void;
};

/** A client whose batchLookup calls stay pending until the test settles them. */
function gatedClient(maxConcurrency?: unknown) {
  const gates: Gate[] = [];
  const state = { inFlight: 0, peak: 0 };
  const batchLookup = vi.fn(
    (parts: string[]) =>
      new Promise<BatchLookupResponse>((resolve, reject) => {
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        gates.push({
          parts,
          resolve: (r) => {
            state.inFlight--;
            resolve(r);
          },
          reject: (e) => {
            state.inFlight--;
            reject(e);
          },
        });
      }),
  );
  const stub =
    maxConcurrency === undefined
      ? { lookup: vi.fn(), batchLookup }
      : { lookup: vi.fn(), batchLookup, maxConcurrency };
  const getClient: ClientProvider = () => stub as unknown as FutureClient;
  return { stub, gates, state, getClient };
}

/** Drain pending microtasks (one macrotask turn; not a time-based timer). */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Found response whose stock encodes the part's input index, to check placement. */
const indexedResponse =
  (names: string[]) =>
  (parts: string[]): BatchLookupResponse => ({
    lookup_parts: parts.map((p) => ({ part_number: p, offers: [offer(names.indexOf(p))] })),
  });

const parse = (res: { content: unknown }) =>
  JSON.parse((res.content as Array<{ text: string }>)[0]!.text);

describe("poolSize", () => {
  it("uses a positive integer maxConcurrency", () => {
    expect(poolSize({ maxConcurrency: 1 })).toBe(1);
    expect(poolSize({ maxConcurrency: 4 })).toBe(4);
  });

  it.each([undefined, 0, -2, 1.5, Number.NaN, Infinity, "4", null])(
    "defaults to 1 for maxConcurrency %s",
    (value) => {
      expect(poolSize({ maxConcurrency: value })).toBe(1);
    },
  );

  it("defaults to 1 for a missing client or a stub without the getter", () => {
    expect(poolSize(undefined)).toBe(1);
    expect(poolSize({})).toBe(1);
  });

  it("reads the real FutureClient getter", () => {
    expect(poolSize(new FutureClient({ apiKey: "test-key", maxConcurrency: 3 }))).toBe(3);
    expect(poolSize(new FutureClient({ apiKey: "test-key" }))).toBe(4);
  });
});

describe("lookupParts parallel batches", () => {
  it("runs 2000 parts (7 batches) at most 4 at a time and keeps input order", async () => {
    const names = partNames(2000);
    const respond = indexedResponse(names);
    const { stub, gates, state, getClient } = gatedClient(4);
    const done = lookupParts({ parts: names, detail: "all" }, getClient);
    await flush();
    expect(stub.batchLookup).toHaveBeenCalledTimes(4);
    expect(state.inFlight).toBe(4);

    // Finish out of order; each completion frees one slot for the next batch in order.
    for (const i of [3, 1, 0, 2, 6, 4, 5]) {
      await flush();
      expect(state.inFlight).toBeLessThanOrEqual(4);
      gates[i]!.resolve(respond(gates[i]!.parts));
    }
    const res = await done;
    expect(state.peak).toBe(4);
    expect(stub.batchLookup).toHaveBeenCalledTimes(7);
    // Batches were dispatched in input order.
    expect(gates.map((g) => g.parts[0])).toEqual([0, 1, 2, 3, 4, 5, 6].map((b) => names[b * 300]));
    expect(gates.map((g) => g.parts.length)).toEqual([300, 300, 300, 300, 300, 300, 200]);

    const json = parse(res);
    expect(res.isError).toBeFalsy();
    const parts = allParts(json);
    expect(parts.map((p: any) => p.part_number)).toEqual(names);
    parts.forEach((p: any, i: number) => expect(p.available).toBe(i));
    expect(json.totals).toMatchObject({ found: 2000, not_attempted: 0, rate_limited: false });
  });

  it("with maxConcurrency 1 matches the sequential (no maxConcurrency) output exactly", async () => {
    const names = [...partNames(650), "MISS-1", "x"];
    const one = gatedClient(1);
    const doneOne = lookupParts({ parts: names }, one.getClient);
    for (let i = 0; i < 3; i++) {
      await flush();
      expect(one.stub.batchLookup).toHaveBeenCalledTimes(i + 1);
      one.gates[i]!.resolve(echoResponse(one.gates[i]!.parts));
    }
    const resOne = await doneOne;
    expect(one.state.peak).toBe(1);

    const seq = await lookupParts({ parts: names }, providerFor(stubClient()));
    expect(resOne).toEqual(seq);
  });

  it("uses no more workers than batches when maxConcurrency is large", async () => {
    const { stub, gates, state, getClient } = gatedClient(10);
    const done = lookupParts({ parts: partNames(301) }, getClient);
    await flush();
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    gates.forEach((g) => g.resolve(echoResponse(g.parts)));
    const json = parse(await done);
    expect(state.peak).toBe(2);
    expect(json.totals).toMatchObject({ found: 301, batches: 2 });
  });

  it("after a 429: in-flight batches finish, no new batch starts, the rest are not_attempted", async () => {
    const names = partNames(2000);
    const { stub, gates, getClient } = gatedClient(3);
    const done = lookupParts({ parts: names, detail: "all" }, getClient);
    await flush();
    expect(stub.batchLookup).toHaveBeenCalledTimes(3);

    gates[1]!.reject(rateLimitError());
    await flush();
    // The freed worker must not start batch 3.
    expect(stub.batchLookup).toHaveBeenCalledTimes(3);
    gates[0]!.resolve(echoResponse(gates[0]!.parts));
    await flush();
    gates[2]!.resolve(echoResponse(gates[2]!.parts));
    const res = await done;

    expect(stub.batchLookup).toHaveBeenCalledTimes(3);
    const called = new Set(stub.batchLookup.mock.calls.flatMap((c) => c[0] as string[]));
    for (const n of names.slice(900)) expect(called.has(n)).toBe(false);

    const json = parse(res);
    expect(res.isError).toBeFalsy();
    expect(json.totals).toEqual({
      requested: 2000,
      unique: 2000,
      found: 600,
      not_found: 0,
      errors: 300,
      not_attempted: 1100,
      short_stock: 0,
      below_moq: 0,
      call_for_leadtime: 0,
      batches: 7,
      rate_limited: true,
    });
    const parts = allParts(json);
    expect(parts.map((p: any) => p.part_number)).toEqual(names);
    expect(parts.slice(0, 300).every((p: any) => p.status === "found")).toBe(true);
    expect(parts.slice(600, 900).every((p: any) => p.status === "found")).toBe(true);
    for (const p of parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.reason).toMatch(/^error: Rate limited/);
    }
    for (const p of parts.slice(900)) {
      expect(p).toMatchObject({ status: "not_attempted", reason: "not_attempted" });
    }
  });

  it("reports an in-flight batch that fails after the 429 with its own error", async () => {
    const { stub, gates, getClient } = gatedClient(2);
    const done = lookupParts({ parts: partNames(900) }, getClient);
    await flush();
    gates[0]!.reject(rateLimitError());
    await flush();
    gates[1]!.reject(new FutureApiError("Bad request.", { code: "http", status: 400 }));
    const res = await done;
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    const json = parse(res);
    expect(res.isError).toBe(true);
    expect(asObjects(json.issues)[300].reason).toBe("error: Bad request.");
    expect(json.totals).toMatchObject({ errors: 600, not_attempted: 300, rate_limited: true });
  });

  it("keeps going after non-429 errors when parallel", async () => {
    const { stub, gates, getClient } = gatedClient(4);
    const done = lookupParts({ parts: partNames(2000) }, getClient);
    await flush();
    gates[0]!.reject(
      new FutureApiError("Future API request failed with HTTP 500.", { code: "http", status: 500 }),
    );
    // A plain error that merely carries status 429 is not an unrecovered rate limit.
    gates[1]!.reject(Object.assign(new Error("boom"), { status: 429 }));
    for (let i = 2; i < 7; i++) {
      await flush();
      gates[i]!.resolve(echoResponse(gates[i]!.parts));
    }
    const res = await done;
    expect(stub.batchLookup).toHaveBeenCalledTimes(7);
    const json = parse(res);
    expect(res.isError).toBeFalsy();
    expect(json.totals).toMatchObject({
      found: 1400,
      errors: 600,
      not_attempted: 0,
      rate_limited: false,
    });
  });

  it("flags isError when a 429 hits the only batch", async () => {
    const { gates, getClient } = gatedClient(4);
    const done = lookupParts({ parts: ["LM317T", "NE555"] }, getClient);
    await flush();
    gates[0]!.reject(rateLimitError());
    const res = await done;
    const json = parse(res);
    expect(res.isError).toBe(true);
    expect(json.totals).toMatchObject({ errors: 2, not_attempted: 0, rate_limited: true });
    expect(json.issues.rows[0][2]).toMatch(/^error: Rate limited/);
  });

  it("flags isError when the first batch hits a 429 and every other batch is skipped", async () => {
    const { stub, gates, getClient } = gatedClient(1);
    const done = lookupParts({ parts: partNames(700) }, getClient);
    await flush();
    gates[0]!.reject(rateLimitError());
    const res = await done;
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
    expect(parse(res).totals).toMatchObject({ errors: 300, not_attempted: 400, batches: 3 });
  });

  it("lists not-attempted batches in raw mode, in input order", async () => {
    const names = [...partNames(1200), "x"];
    const { gates, getClient } = gatedClient(2);
    const done = lookupParts({ parts: names, raw: true }, getClient);
    await flush();
    gates[1]!.resolve(echoResponse(gates[1]!.parts));
    await flush();
    // Batch 2 started when batch 1 finished; now batch 0 hits the rate limit.
    gates[0]!.reject(rateLimitError());
    await flush();
    gates[2]!.resolve(echoResponse(gates[2]!.parts));
    const json = parse(await done);
    expect(gates).toHaveLength(3);
    expect(json.parts).toBeUndefined();
    expect(json.batches).toHaveLength(4);
    expect(json.batches[0]).toEqual({
      part_numbers: names.slice(0, 300),
      error: "Rate limited: too many requests to the Future API. Try again later.",
    });
    expect(json.batches[1].response).toEqual(echoResponse(names.slice(300, 600)));
    expect(json.batches[2].response).toEqual(echoResponse(names.slice(600, 900)));
    expect(json.batches[3]).toEqual({
      part_numbers: names.slice(900, 1200),
      not_attempted: true,
      error: NOT_ATTEMPTED_MESSAGE,
    });
    expect(json.invalid_parts).toEqual([
      { part_number: "x", error: "Part number must contain at least 3 alphanumeric characters." },
    ]);
    expect(json.totals).toMatchObject({
      found: 600,
      errors: 301,
      not_attempted: 300,
      batches: 4,
      rate_limited: true,
    });
  });

  it("runs batches in parallel over MCP too", async () => {
    const { stub, gates, state, getClient } = gatedClient(2);
    const pending = call(getClient, { parts: partNames(900) });
    while (gates.length < 2) await flush();
    await flush();
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    gates[0]!.resolve(echoResponse(gates[0]!.parts));
    gates[1]!.resolve(echoResponse(gates[1]!.parts));
    while (gates.length < 3) await flush();
    gates[2]!.resolve(echoResponse(gates[2]!.parts));
    const { res, json } = await pending;
    expect(res.isError).toBeFalsy();
    expect(state.peak).toBe(2);
    expect(json.totals).toMatchObject({ found: 900, batches: 3, rate_limited: false });
  });
});

describe("registerLookupPartsTool", () => {
  it("registers once and rejects a duplicate registration", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const getClient = providerFor(stubClient());
    registerLookupPartsTool(server, getClient);
    expect(() => registerLookupPartsTool(server, getClient)).toThrow();
  });
});

// ---------- problems-first summary (issue #41) ----------

/** The fixture's first offer: 12000 in stock, MOQ 1000, 12 Weeks, USD 0.42 at 1000-4999. */
const fixtureOffer = (
  JSON.parse(
    readFileSync(new URL("../fixtures/part-lookup.json", import.meta.url), "utf8"),
  ) as PartLookupResponse
).offers![0]!;

/** Every part gets `offerFor(part)` as its only offer; undefined means not found. */
const fixtureClient = (offerFor: (p: string) => Offer | undefined = () => fixtureOffer) =>
  stubClient(async (parts) => ({
    lookup_parts: parts.map((p) => {
      const o = offerFor(p);
      return { part_number: p, offers: o ? [o] : [] };
    }),
  }));

/** The fixture offer with stock, lead time or currency changed. */
function variant(q: Record<string, unknown> = {}, currency?: string): Offer {
  const o = structuredClone(fixtureOffer);
  o.quantities = { ...o.quantities, ...q };
  if (currency) o.currency = { currency_code: currency };
  return o;
}

const withQty = (names: string[], quantity: number) =>
  names.map((part_number) => ({ part_number, quantity }));

/** A PartResult for unit tests. */
const found = (extra: Partial<PartResult> = {}): PartResult => ({
  part_number: "P1",
  quantity: 100,
  quantity_given: true,
  status: "found",
  quantity_available: 500,
  quantity_minimum: 10,
  lead_time: "12 Weeks",
  currency_code: "USD",
  price: { price_break: { from: 1, unit_price: 0.5 } },
  ...extra,
});

/** Use the default budget (8000 tokens) rather than this file's roomy one. */
const defaultBudget = () => vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "");

describe("problemReasons", () => {
  it("returns no reasons for a clean part", () => {
    expect(problemReasons(found())).toEqual([]);
  });

  it("flags short_stock only when available < quantity", () => {
    expect(problemReasons(found({ quantity_available: 99 }))).toEqual(["short_stock"]);
    expect(problemReasons(found({ quantity_available: 100 }))).toEqual([]);
    expect(problemReasons(found({ quantity_available: 0 }))).toEqual(["short_stock"]);
    expect(problemReasons(found({ quantity_available: undefined }))).toEqual([]);
  });

  it("checks stock against the default quantity when none was given", () => {
    const p = found({ quantity: 1, quantity_given: false, quantity_available: 0 });
    expect(problemReasons(p)).toEqual(["short_stock"]);
  });

  it("flags below_moq only when a given quantity < quantity_minimum", () => {
    expect(problemReasons(found({ quantity_minimum: 101 }))).toEqual(["below_moq"]);
    expect(problemReasons(found({ quantity_minimum: 100 }))).toEqual([]);
    expect(problemReasons(found({ quantity_minimum: undefined }))).toEqual([]);
    expect(problemReasons(found({ quantity_minimum: 1000, quantity_given: false }))).toEqual([]);
  });

  it('flags call_for_leadtime for a "CALL" lead time', () => {
    expect(problemReasons(found({ lead_time: "CALL" }))).toEqual(["call_for_leadtime"]);
    expect(problemReasons(found({ lead_time: undefined }))).toEqual([]);
  });

  it("lists every reason that applies, in a fixed order", () => {
    const p = found({ quantity_available: 5, quantity_minimum: 1000, lead_time: "CALL" });
    expect(problemReasons(p)).toEqual(["short_stock", "below_moq", "call_for_leadtime"]);
  });

  it("reports not_found, not_attempted and error with its message", () => {
    const base = { part_number: "X", quantity: 1, quantity_given: false } as const;
    expect(problemReasons({ ...base, status: "not_found" })).toEqual(["not_found"]);
    expect(problemReasons({ ...base, status: "not_attempted", error: "m" })).toEqual([
      "not_attempted",
    ]);
    expect(problemReasons({ ...base, status: "error", error: "Bad request." })).toEqual([
      "error: Bad request.",
    ]);
    expect(problemReasons({ ...base, status: "error" })).toEqual(["error: unknown"]);
  });
});

describe("leadTimeDays / maxLeadTime", () => {
  it.each([
    ["12 Weeks", 84],
    ["1 Week", 7],
    ["5 days", 5],
    ["2 Months", 60],
    ["3", 21],
    [" 4 weeks ", 28],
    ["2.5 Weeks", 17.5],
  ])("parses %j as %d days", (text, days) => {
    expect(leadTimeDays(text)).toBe(days);
  });

  it.each([undefined, "", "CALL", "soon", "12 fortnights", "Weeks 12", "-3 Weeks"])(
    "gives undefined for %j",
    (text) => {
      expect(leadTimeDays(text)).toBeUndefined();
    },
  );

  it("picks the longest lead time across units, keeping its text", () => {
    const parts = [
      found({ lead_time: "12 Weeks" }),
      found({ lead_time: "4 Months" }),
      found({ lead_time: "100 Days" }),
      found({ lead_time: "CALL" }),
    ];
    expect(maxLeadTime(parts)).toBe("4 Months");
  });

  it("keeps the first of equal lead times and ignores parts that were not found", () => {
    expect(maxLeadTime([found({ lead_time: "2 Weeks" }), found({ lead_time: "14 Days" })])).toBe(
      "2 Weeks",
    );
    const missing = { part_number: "X", quantity: 1, quantity_given: false, status: "not_found" };
    expect(maxLeadTime([missing as PartResult])).toBeNull();
    expect(maxLeadTime([found({ lead_time: "CALL" }), found({ lead_time: undefined })])).toBeNull();
    expect(maxLeadTime([])).toBeNull();
  });
});

describe("extendedCost", () => {
  it("sums quantity x unit price per currency, rounded to cents", () => {
    const parts = [
      found({ quantity: 3, price: { price_break: { from: 1, unit_price: 0.1 } } }),
      found({ quantity: 7, price: { price_break: { from: 1, unit_price: 0.2 } } }),
      found({ quantity: 2, currency_code: "EUR", price: { price_break: { from: 1, unit_price: 1.005 } } }),
    ];
    expect(extendedCost(parts)).toEqual({ extended_cost: { USD: 1.7, EUR: 2.01 }, unpriced: 0 });
  });

  it("skips and counts found parts with no applicable price break", () => {
    const parts = [
      found({ price: { price_break: null, reason: "no_pricing" } }),
      found({ price: { price_break: null, reason: "below_minimum", quantity_minimum: 500 } }),
      found({ price: undefined }),
      found({ quantity: 10 }),
    ];
    expect(extendedCost(parts)).toEqual({ extended_cost: { USD: 5 }, unpriced: 3 });
  });

  it("ignores parts that were not found and labels a missing currency UNKNOWN", () => {
    const missing = { part_number: "X", quantity: 5, quantity_given: true, status: "not_found" };
    const parts = [missing as PartResult, found({ quantity: 2, currency_code: undefined })];
    expect(extendedCost(parts)).toEqual({ extended_cost: { UNKNOWN: 1 }, unpriced: 0 });
    expect(extendedCost([])).toEqual({ extended_cost: {}, unpriced: 0 });
  });
});

describe("partsTable", () => {
  const parts = [
    found({ part_number: "OK1" }),
    found({ part_number: "SHORT", quantity_available: 1, lead_time: "CALL" }),
    { part_number: "GONE", quantity: 1, quantity_given: false, status: "not_found" } as PartResult,
  ];

  it("lists only problem parts in the summary table", () => {
    expect(partsTable(parts, false)).toEqual({
      columns: ISSUE_COLUMNS,
      rows: [
        ["SHORT", "found", "short_stock;call_for_leadtime", 100, 1, "CALL"],
        ["GONE", "not_found", "not_found", 1, null, null],
      ],
    });
  });

  it("lists every part with all columns when all is set", () => {
    const table = partsTable(parts, true);
    expect(table.columns).toEqual(PART_COLUMNS);
    expect(table.rows).toEqual([
      ["OK1", null, "found", "", 100, 500, 10, "12 Weeks", "USD", 0.5],
      ["SHORT", null, "found", "short_stock;call_for_leadtime", 100, 1, 10, "CALL", "USD", 0.5],
      ["GONE", null, "not_found", "not_found", 1, null, null, null, null, null],
    ]);
    expect(partsTable([], true)).toEqual({ columns: PART_COLUMNS, rows: [] });
  });
});

describe("future_lookup_parts problems-first summary", () => {
  it("describes the summary, the problem categories, detail and the budget", () => {
    for (const word of [
      "issues",
      "totals",
      "extended_cost",
      "unpriced",
      "max_lead_time",
      "short_stock",
      "below_moq",
      "call_for_leadtime",
      "not_attempted",
      'detail "all"',
      "FUTURE_MAX_OUTPUT_TOKENS",
      "truncated",
    ]) {
      expect(LOOKUP_PARTS_DESCRIPTION).toContain(word);
    }
  });

  it("lists detail with summary as the default", async () => {
    const conn = await connect(providerFor(stubClient()));
    open.push(conn);
    const { tools } = await conn.client.listTools();
    const detail = (tools.find((t) => t.name === LOOKUP_PARTS_TOOL_NAME)!.inputSchema
      .properties as Record<string, any>).detail;
    expect(detail.enum).toEqual(["summary", "all"]);
    expect(detail.default).toBe("summary");
  });

  it("summarizes 2000 clean parts in under 1000 tokens, the same size as 100", async () => {
    defaultBudget();
    const big = await call(providerFor(fixtureClient()), { parts: withQty(partNames(2000), 1000) });
    const small = await call(providerFor(fixtureClient()), { parts: withQty(partNames(100), 1000) });
    expect(estimateTokens(big.text)).toBeLessThan(1000);
    expect(Math.abs(big.text.length - small.text.length)).toBeLessThan(20);
    expect(big.text).not.toContain("\n");
    expect(big.json).toEqual({
      note: PRICING_DISCLAIMER,
      totals: {
        requested: 2000,
        unique: 2000,
        found: 2000,
        not_found: 0,
        errors: 0,
        not_attempted: 0,
        short_stock: 0,
        below_moq: 0,
        call_for_leadtime: 0,
        batches: 7,
        rate_limited: false,
      },
      extended_cost: { USD: 840000 },
      unpriced: 0,
      max_lead_time: "12 Weeks",
      issues: { columns: ISSUE_COLUMNS, rows: [] },
    });
  });

  it("lists exactly the 50 problem parts among 2000, in input order", async () => {
    defaultBudget();
    const names = partNames(2000);
    const problems = names.filter((_, i) => i % 40 === 7); // 50 parts
    const kind = new Map(problems.map((p, i) => [p, i % 4]));
    const stub = fixtureClient((p) => {
      const k = kind.get(p);
      if (k === 0) return undefined; // not_found
      if (k === 1) return variant({ quantity_available: 10 }); // short_stock
      if (k === 2) return variant({ factory_leadtime: "CALL" }); // call_for_leadtime
      return fixtureOffer;
    });
    // Kind 3 asks for less than the MOQ of 1000.
    const parts = names.map((p) => ({ part_number: p, quantity: kind.get(p) === 3 ? 10 : 1000 }));
    const { json } = await call(providerFor(stub), { parts });
    expect(json.issues.rows.map((r: any[]) => r[0])).toEqual(problems);
    expect(json.truncated).toBeUndefined();
    expect(json.totals).toMatchObject({
      found: 2000 - 13,
      not_found: 13,
      short_stock: 13,
      call_for_leadtime: 12,
      below_moq: 12,
    });
    const reasons = asObjects(json.issues).map((r) => r.reason);
    expect(reasons.slice(0, 4)).toEqual(["not_found", "short_stock", "call_for_leadtime", "below_moq"]);
  });

  it("detects every problem category, several reasons per part, and errors", async () => {
    const stub = fixtureClient((p) => {
      if (p === "SHORT") return variant({ quantity_available: 999 });
      if (p === "CALLLT") return variant({ factory_leadtime: " call " });
      if (p === "MULTI") return variant({ quantity_available: 5, factory_leadtime: "CALL" });
      if (p === "MISS") return undefined;
      return fixtureOffer;
    });
    const { json } = await call(providerFor(stub), {
      parts: [
        { part_number: "OKAY", quantity: 1000 },
        { part_number: "SHORT", quantity: 1000 },
        { part_number: "MOQ", quantity: 999 },
        { part_number: "CALLLT", quantity: 1000 },
        { part_number: "MULTI", quantity: 10 },
        "MISS",
        "ab",
        "NOQTY", // MOQ 1000 but no quantity given: not below_moq
      ],
    });
    expect(asObjects(json.issues)).toEqual([
      { part_number: "SHORT", status: "found", reason: "short_stock", quantity: 1000, available: 999, lead_time: "12 Weeks" },
      { part_number: "MOQ", status: "found", reason: "below_moq", quantity: 999, available: 12000, lead_time: "12 Weeks" },
      { part_number: "CALLLT", status: "found", reason: "call_for_leadtime", quantity: 1000, available: 12000, lead_time: "CALL" },
      {
        part_number: "MULTI",
        status: "found",
        reason: "short_stock;below_moq;call_for_leadtime",
        quantity: 10,
        available: 5,
        lead_time: "CALL",
      },
      { part_number: "MISS", status: "not_found", reason: "not_found", quantity: 1, available: null, lead_time: null },
      {
        part_number: "ab",
        status: "error",
        reason: "error: Part number must contain at least 3 alphanumeric characters.",
        quantity: 1,
        available: null,
        lead_time: null,
      },
    ]);
    expect(json.totals).toMatchObject({
      found: 6,
      not_found: 1,
      errors: 1,
      short_stock: 2,
      below_moq: 2,
      call_for_leadtime: 2,
    });
    // MOQ (999) and MULTI (10) are below the lowest price break, so unpriced.
    expect(json.unpriced).toBe(3); // NOQTY (qty 1) too
    expect(json.extended_cost).toEqual({ USD: 3 * 1000 * 0.42 });
  });

  it("lists not_attempted parts with a retry note after an unrecovered 429", async () => {
    let n = 0;
    const stub = fixtureClient();
    const inner = stub.batchLookup.getMockImplementation()!;
    stub.batchLookup.mockImplementation(async (parts: string[]) => {
      if (++n === 2) throw rateLimitError();
      return inner(parts);
    });
    const names = partNames(601);
    const { json } = await call(providerFor(stub), { parts: withQty(names, 1000) });
    expect(json.totals).toMatchObject({ found: 300, errors: 300, not_attempted: 1, rate_limited: true });
    expect(json.issues.rows).toHaveLength(301);
    expect(json.issues.rows.at(-1)).toEqual(["PART-0600", "not_attempted", "not_attempted", 1000, null, null]);
    expect(json.not_attempted_note).toBe(NOT_ATTEMPTED_MESSAGE);
  });

  it("omits not_attempted_note when every batch ran", async () => {
    const { json } = await call(providerFor(fixtureClient()), { parts: ["LM317T"] });
    expect(json.not_attempted_note).toBeUndefined();
  });

  it("reports extended cost per currency when currencies are mixed", async () => {
    const stub = fixtureClient((p) => (p.startsWith("EU") ? variant({}, "EUR") : fixtureOffer));
    const { json } = await call(providerFor(stub), {
      parts: [
        { part_number: "US1", quantity: 1000 },
        { part_number: "EU1", quantity: 5000 },
        { part_number: "EU2", quantity: 2000 },
      ],
    });
    expect(json.extended_cost).toEqual({ USD: 420, EUR: 5000 * 0.37 + 2000 * 0.42 });
    expect(json.unpriced).toBe(0);
  });

  it('caps detail "all" at the default budget with an explicit truncation note', async () => {
    defaultBudget();
    const names = partNames(2000);
    const { text, json, res } = await call(providerFor(fixtureClient()), {
      parts: withQty(names, 1000),
      detail: "all",
    });
    expect(res.isError).toBeFalsy();
    expect(text.length).toBeLessThanOrEqual(8000 * 4);
    expect(json.truncated.hint).toBe(TRUNCATION_HINT);
    expect(json.truncated.omitted + json.parts.rows.length).toBe(2000);
    expect(json.parts.rows.map((r: any[]) => r[0])).toEqual(names.slice(0, json.parts.rows.length));
    expect(json.totals.found).toBe(2000);
    expect(json.extended_cost).toEqual({ USD: 840000 });
  });

  it("caps a long issues table too, keeping the totals whole", async () => {
    defaultBudget();
    const { text, json } = await call(providerFor(fixtureClient(() => undefined)), {
      parts: partNames(2000),
    });
    expect(text.length).toBeLessThanOrEqual(32000);
    expect(json.totals.not_found).toBe(2000);
    expect(json.truncated.omitted + json.issues.rows.length).toBe(2000);
  });

  it.each([1000, 2500, 100000])("never exceeds FUTURE_MAX_OUTPUT_TOKENS=%d", async (budget) => {
    vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", String(budget));
    const names = partNames(2000);
    for (const args of [
      { parts: names, detail: "all" },
      { parts: names, raw: true },
      { parts: names },
    ]) {
      const { text } = await call(providerFor(fixtureClient(() => undefined)), args);
      expect(text.length).toBeLessThanOrEqual(budget * 4);
    }
  });

  it("applies the budget to raw output, dropping whole batches", async () => {
    defaultBudget();
    const { text, json } = await call(providerFor(fixtureClient()), {
      parts: partNames(2000),
      raw: true,
    });
    expect(text.length).toBeLessThanOrEqual(32000);
    expect(json.batches).toEqual([]);
    expect(json.truncated).toEqual({ omitted: 7, hint: TRUNCATION_HINT });
    expect(json.totals.found).toBe(2000);
  });

  it("rejects an invalid FUTURE_MAX_OUTPUT_TOKENS before any lookup", async () => {
    vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "10");
    const stub = fixtureClient();
    const { res, text } = await call(providerFor(stub), { parts: ["LM317T"] });
    expect(res.isError).toBe(true);
    expect(text).toBe("FUTURE_MAX_OUTPUT_TOKENS must be an integer from 1000 to 100000.");
    expect(stub.batchLookup).not.toHaveBeenCalled();
  });

  it("uses an explicit budget argument over the environment", async () => {
    vi.stubEnv("FUTURE_MAX_OUTPUT_TOKENS", "10");
    const stub = fixtureClient(() => undefined);
    const res = await lookupParts({ parts: partNames(2000) }, providerFor(stub), 1000);
    const text = (res.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(text).truncated.omitted).toBeGreaterThan(0);
  });
});
