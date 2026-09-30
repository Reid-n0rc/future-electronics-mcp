import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FutureApiError, FutureClient, MAX_BATCH_PARTS } from "../../src/client.js";
import { ConfigError } from "../../src/config.js";
import { PRICING_DISCLAIMER } from "../../src/format.js";
import { createServer } from "../../src/server.js";
import type { ClientProvider } from "../../src/tools/common.js";
import {
  DEFAULT_QUANTITY,
  LOOKUP_PARTS_TOOL_NAME,
  MAX_LOOKUP_PARTS,
  NOT_ATTEMPTED_MESSAGE,
  bestOffer,
  chunk,
  dedupeParts,
  lookupParts,
  poolSize,
  registerLookupPartsTool,
} from "../../src/tools/lookupParts.js";
import type { BatchLookupResponse, Offer } from "../../src/types.js";

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
      batches: 0,
      rate_limited: false,
    });
    expect(json.parts[0].error).toMatch(/at least 3 alphanumeric/);
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
    const { res, json } = await call(providerFor(stub), { parts: names });
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
      batches: 3,
      rate_limited: false,
    });
    expect(json.parts).toHaveLength(650);
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
    });
    expect(stub.batchLookup).toHaveBeenCalledTimes(1);
    expect(stub.batchLookup.mock.calls[0]![0]).toEqual(["LM317T", "NE555"]);
    expect(json.totals).toMatchObject({ requested: 4, unique: 2 });
    const lm = json.parts[0];
    expect(lm.part_number).toBe("LM317T");
    expect(lm.quantity).toBe(110);
    expect(lm.price).toEqual({ price_break: { from: 100, to: 999, unit_price: 0.8 } });
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
    });
    const [p1, p2, p3] = json.parts;
    expect(p1).toEqual({
      part_number: "QTY1",
      quantity: 5,
      status: "found",
      offer_count: 2,
      mpn: "BIG",
      quantity_available: 5000,
      lead_time: "12 Weeks",
      currency_code: "USD",
      price: { price_break: { from: 1, to: 99, unit_price: 1 } },
    });
    expect(p2.price).toEqual({ price_break: { from: 1000, unit_price: 0.5 } });
    expect(p3.quantity).toBe(DEFAULT_QUANTITY);
    expect(p3.price.price_break.unit_price).toBe(1);
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
    });
    expect(json.parts[0].price).toEqual({
      price_break: null,
      reason: "below_minimum",
      quantity_minimum: 50,
    });
    expect(json.parts[1].price).toEqual({ price_break: null, reason: "no_pricing" });
  });

  it("marks parts with no offers or no response entry as not_found", async () => {
    const stub = stubClient(async () => ({
      lookup_parts: [{ part_number: "MISS-1", offers: [] }],
    }));
    const { res, json } = await call(providerFor(stub), { parts: ["MISS-1", "GONE-2"] });
    expect(res.isError).toBeFalsy();
    expect(json.parts).toEqual([
      { part_number: "MISS-1", quantity: 1, status: "not_found" },
      { part_number: "GONE-2", quantity: 1, status: "not_found" },
    ]);
    expect(json.totals).toMatchObject({ found: 0, not_found: 2, errors: 0 });
  });

  it("matches response entries case-insensitively, and by position when unnamed", async () => {
    const stub = stubClient(async () => ({
      lookup_parts: [
        { part_number: "abc123", offers: [offer(1)] },
        { offers: [offer(2)] },
      ],
    }));
    const { json } = await call(providerFor(stub), { parts: ["ABC123", "DEF456"] });
    expect(json.parts[0]).toMatchObject({ status: "found", quantity_available: 1 });
    expect(json.parts[1]).toMatchObject({ status: "found", quantity_available: 2 });
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
    const { res, json } = await call(providerFor(stub), { parts: names });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup).toHaveBeenCalledTimes(3);
    expect(json.totals).toEqual({
      requested: 650,
      unique: 650,
      found: 350,
      not_found: 0,
      errors: 300,
      not_attempted: 0,
      batches: 3,
      rate_limited: false,
    });
    expect(json.parts.slice(0, 300).every((p: any) => p.status === "found")).toBe(true);
    expect(json.parts.slice(600).every((p: any) => p.status === "found")).toBe(true);
    for (const p of json.parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.error).toBe("Future API request failed with HTTP 503.");
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
    const { res, json } = await call(providerFor(stub), { parts: names });
    expect(res.isError).toBeFalsy();
    expect(stub.batchLookup).toHaveBeenCalledTimes(2);
    expect(json.totals).toEqual({
      requested: 650,
      unique: 650,
      found: 300,
      not_found: 0,
      errors: 300,
      not_attempted: 50,
      batches: 3,
      rate_limited: true,
    });
    for (const p of json.parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.error).toMatch(/^Rate limited/);
    }
    for (const p of json.parts.slice(600)) {
      expect(p).toEqual({
        part_number: p.part_number,
        quantity: 1,
        status: "not_attempted",
        error: NOT_ATTEMPTED_MESSAGE,
      });
    }
  });

  it("uses a generic message for unexpected (non-API) errors so internals never leak", async () => {
    const stub = stubClient(async () => {
      throw new Error("secret internal detail test-key");
    });
    const { res, text, json } = await call(providerFor(stub), { parts: ["LM317T"] });
    expect(res.isError).toBe(true);
    expect(text).not.toContain("test-key");
    expect(text).not.toContain("secret internal");
    expect(json.parts[0].error).toBe("Unexpected error while calling the Future Electronics API.");
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
    expect(json.parts[1]).toMatchObject({ part_number: "a-b", status: "error" });
    expect(json.parts[1].error).toMatch(/at least 3 alphanumeric/);
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

  it("defaults raw to false", async () => {
    const { json } = await call(providerFor(stubClient()), { parts: ["LM317T"] });
    expect(json.parts).toHaveLength(1);
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
    const done = lookupParts({ parts: names }, getClient);
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
    expect(json.parts.map((p: any) => p.part_number)).toEqual(names);
    json.parts.forEach((p: any, i: number) => expect(p.quantity_available).toBe(i));
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
    const done = lookupParts({ parts: names }, getClient);
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
      batches: 7,
      rate_limited: true,
    });
    expect(json.parts.map((p: any) => p.part_number)).toEqual(names);
    expect(json.parts.slice(0, 300).every((p: any) => p.status === "found")).toBe(true);
    expect(json.parts.slice(600, 900).every((p: any) => p.status === "found")).toBe(true);
    for (const p of json.parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.error).toMatch(/^Rate limited/);
    }
    for (const p of json.parts.slice(900)) {
      expect(p).toMatchObject({ status: "not_attempted", error: NOT_ATTEMPTED_MESSAGE });
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
    expect(json.parts[300].error).toBe("Bad request.");
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
    expect(json.parts[0].error).toMatch(/^Rate limited/);
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
