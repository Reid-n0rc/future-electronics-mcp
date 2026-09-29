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
  bestOffer,
  chunk,
  dedupeParts,
  lookupParts,
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
      batches: 0,
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

  it("splits 650 unique parts into exactly 3 sequential calls of 300/300/50", async () => {
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
      batches: 3,
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

  it("still returns the other chunks when the middle chunk fails", async () => {
    let n = 0;
    const stub = stubClient(async (parts) => {
      n++;
      if (n === 2) {
        throw new FutureApiError("Rate limited: too many requests to the Future API. Try again later.", {
          code: "http",
          status: 429,
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
      batches: 3,
    });
    expect(json.parts.slice(0, 300).every((p: any) => p.status === "found")).toBe(true);
    expect(json.parts.slice(600).every((p: any) => p.status === "found")).toBe(true);
    for (const p of json.parts.slice(300, 600)) {
      expect(p.status).toBe("error");
      expect(p.error).toMatch(/^Rate limited/);
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

describe("registerLookupPartsTool", () => {
  it("registers once and rejects a duplicate registration", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const getClient = providerFor(stubClient());
    registerLookupPartsTool(server, getClient);
    expect(() => registerLookupPartsTool(server, getClient)).toThrow();
  });
});
