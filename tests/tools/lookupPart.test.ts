import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FutureApiError, FutureClient } from "../../src/client.js";
import { PRICING_DISCLAIMER, summarizeOffer } from "../../src/format.js";
import { createServer } from "../../src/server.js";
import { lazyClientProvider, type ClientProvider } from "../../src/tools/common.js";
import {
  DEFAULT_MAX_OFFERS,
  LOOKUP_PART_DESCRIPTION,
  LOOKUP_PART_TOOL_NAME,
  MAX_MAX_OFFERS,
  buildLookupPartResult,
  registerLookupPartTool,
} from "../../src/tools/lookupPart.js";
import type { Offer, PartLookupResponse } from "../../src/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/part-lookup.json", import.meta.url), "utf8"),
) as PartLookupResponse;
const clone = <T>(v: T): T => structuredClone(v);

/** A response with `n` distinct offers, each priced 1+ at `n` cents. */
function manyOffers(n: number): PartLookupResponse {
  const offers: Offer[] = Array.from({ length: n }, (_, i) => ({
    part_id: { mpn: `MPN-${i}` },
    pricing: [{ quantity_from: 1, quantity_to: null, unit_price: i / 100 }],
  }));
  return { lookup_value: "MPN", lookup_results: `${n} Offers found`, offers } as PartLookupResponse;
}

type Stub = { lookup: ReturnType<typeof vi.fn>; batchLookup: ReturnType<typeof vi.fn> };

function stubClient(impl?: (...args: unknown[]) => unknown): Stub {
  return {
    lookup: vi.fn(impl ?? (async () => clone(fixture))),
    batchLookup: vi.fn(),
  };
}

const providerFor = (stub: Stub): ClientProvider => () => stub as unknown as FutureClient;

const clients: Client[] = [];

async function connect(getClient: ClientProvider): Promise<Client> {
  const server = createServer(getClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name: LOOKUP_PART_TOOL_NAME, arguments: args })) as CallToolResult;
}

const text = (result: CallToolResult): string => {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
};
const json = (result: CallToolResult): any => JSON.parse(text(result));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("tools/list", () => {
  it("lists future_lookup_part with its description and input schema", async () => {
    const client = await connect(providerFor(stubClient()));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === LOOKUP_PART_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(LOOKUP_PART_DESCRIPTION);
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    const props = tool!.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(
      ["lookup_type", "max_offers", "part_number", "quantity", "raw"].sort(),
    );
    expect(tool!.inputSchema.required).toEqual(["part_number"]);
    expect(props.lookup_type.enum).toEqual(["default", "exact", "contains", "starts_with"]);
    expect(props.lookup_type.default).toBe("exact");
    expect(props.max_offers.default).toBe(DEFAULT_MAX_OFFERS);
    expect(props.max_offers.maximum).toBe(MAX_MAX_OFFERS);
    expect(props.raw.default).toBe(false);
  });

  it("does not create a client just to list tools", async () => {
    const getClient = vi.fn(providerFor(stubClient()));
    const client = await connect(getClient);
    await client.listTools();
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("tool description", () => {
  it("says pricing is not an official quote", () => {
    expect(LOOKUP_PART_DESCRIPTION).toMatch(/not an official quote/i);
    expect(LOOKUP_PART_DESCRIPTION).toContain(PRICING_DISCLAIMER);
  });

  it("explains when to use contains and starts_with", () => {
    expect(LOOKUP_PART_DESCRIPTION).toMatch(/starts_with when/);
    expect(LOOKUP_PART_DESCRIPTION).toMatch(/contains when/);
    expect(LOOKUP_PART_DESCRIPTION).toMatch(/total_offers/);
  });
});

describe("tools/call: happy path", () => {
  it("defaults lookup_type to exact and returns a summary", async () => {
    const stub = stubClient();
    const client = await connect(providerFor(stub));
    const result = await call(client, { part_number: "TEST-1234" });
    expect(result.isError).toBeFalsy();
    expect(stub.lookup).toHaveBeenCalledWith("TEST-1234", "exact");
    const out = json(result);
    expect(out.lookup_value).toBe("TEST-1234");
    expect(out.lookup_results).toBe("2 Offers found");
    expect(out.note).toBe(PRICING_DISCLAIMER);
    expect(out.total_offers).toBe(2);
    expect(out.offers).toHaveLength(2);
    expect(out.offers[0]).toEqual(summarizeOffer(fixture.offers[0]));
    expect(out).not.toHaveProperty("quantity");
    expect(out.offers[0]).not.toHaveProperty("price_at_quantity");
  });

  it.each(["default", "exact", "contains", "starts_with"] as const)(
    "passes lookup_type %s through to the client",
    async (lookupType) => {
      const stub = stubClient();
      const client = await connect(providerFor(stub));
      await call(client, { part_number: "ABC", lookup_type: lookupType });
      expect(stub.lookup).toHaveBeenCalledWith("ABC", lookupType);
    },
  );

  it("truncates to max_offers (default 10) and reports total_offers", async () => {
    const stub = stubClient(async () => manyOffers(25));
    const client = await connect(providerFor(stub));
    const out = json(await call(client, { part_number: "MPN" }));
    expect(out.total_offers).toBe(25);
    expect(out.offers).toHaveLength(10);
    expect(out.offers.map((o: any) => o.mpn)).toEqual(
      Array.from({ length: 10 }, (_, i) => `MPN-${i}`),
    );
  });

  it("honors an explicit max_offers", async () => {
    const client = await connect(providerFor(stubClient(async () => manyOffers(25))));
    const out = json(await call(client, { part_number: "MPN", max_offers: 3 }));
    expect(out.total_offers).toBe(25);
    expect(out.offers).toHaveLength(3);
  });

  it("accepts max_offers at both bounds", async () => {
    const client = await connect(providerFor(stubClient(async () => manyOffers(60))));
    expect(json(await call(client, { part_number: "MPN", max_offers: 1 })).offers).toHaveLength(1);
    expect(json(await call(client, { part_number: "MPN", max_offers: 50 })).offers).toHaveLength(
      50,
    );
  });

  it("returns an empty offers list with total_offers 0 when nothing matches", async () => {
    const client = await connect(
      providerFor(
        stubClient(async () => ({ lookup_value: "NOPE", lookup_results: "0 Offers found", offers: [] })),
      ),
    );
    const out = json(await call(client, { part_number: "NOPE" }));
    expect(out.total_offers).toBe(0);
    expect(out.offers).toEqual([]);
  });

  it("adds price_at_quantity to each offer when quantity is set", async () => {
    const client = await connect(providerFor(stubClient()));
    const out = json(await call(client, { part_number: "TEST-1234", quantity: 5000 }));
    expect(out.quantity).toBe(5000);
    expect(out.offers[0].price_at_quantity).toEqual({
      price_break: { from: 5000, unit_price: 0.37 },
    });
    expect(out.offers[1].price_at_quantity).toEqual({ price_break: null, reason: "no_pricing" });
  });

  it("reports below_minimum when quantity is under the first break", async () => {
    const client = await connect(providerFor(stubClient()));
    const out = json(await call(client, { part_number: "TEST-1234", quantity: 10 }));
    expect(out.offers[0].price_at_quantity).toEqual({
      price_break: null,
      reason: "below_minimum",
      quantity_minimum: 1000,
    });
  });

  it("returns the untouched response with raw: true", async () => {
    const client = await connect(providerFor(stubClient()));
    const out = json(await call(client, { part_number: "TEST-1234", raw: true }));
    expect(out).toEqual(fixture);
  });

  it("still truncates offers with raw: true", async () => {
    const resp = manyOffers(15);
    const client = await connect(providerFor(stubClient(async () => clone(resp))));
    const out = json(await call(client, { part_number: "MPN", raw: true, max_offers: 4 }));
    expect(out.offers).toEqual(resp.offers.slice(0, 4));
    expect(out.lookup_results).toBe("15 Offers found");
    expect(out).not.toHaveProperty("total_offers");
  });

  it("ignores quantity with raw: true", async () => {
    const client = await connect(providerFor(stubClient()));
    const out = json(await call(client, { part_number: "TEST-1234", raw: true, quantity: 5000 }));
    expect(out).toEqual(fixture);
  });
});

describe("tools/call: invalid input", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing part_number", {}],
    ["part_number shorter than 3", { part_number: "AB" }],
    ["non-string part_number", { part_number: 12345 }],
    ["unknown lookup_type", { part_number: "ABC", lookup_type: "fuzzy" }],
    ["zero quantity", { part_number: "ABC", quantity: 0 }],
    ["negative quantity", { part_number: "ABC", quantity: -5 }],
    ["fractional quantity", { part_number: "ABC", quantity: 1.5 }],
    ["max_offers 0", { part_number: "ABC", max_offers: 0 }],
    ["max_offers above 50", { part_number: "ABC", max_offers: 51 }],
    ["fractional max_offers", { part_number: "ABC", max_offers: 2.5 }],
    ["non-boolean raw", { part_number: "ABC", raw: "yes" }],
  ];

  it.each(cases)("rejects %s without calling the API", async (_name, args) => {
    const stub = stubClient();
    const client = await connect(providerFor(stub));
    const result = await call(client, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/validation/i);
    expect(stub.lookup).not.toHaveBeenCalled();
  });

  it("surfaces the client's alphanumeric check as a tool error", async () => {
    // Real client with a fetch that must never be called.
    const fetch = vi.fn();
    const real = new FutureClient({ apiKey: "test-key", fetch: fetch as unknown as typeof globalThis.fetch });
    const client = await connect(() => real);
    const result = await call(client, { part_number: "-- --" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Part number must contain at least 3 alphanumeric characters.");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("tools/call: error paths", () => {
  it("returns a FutureApiError message as isError", async () => {
    const message = "Rate limited: too many requests to the Future API. Try again later.";
    const stub = stubClient(async () => {
      throw new FutureApiError(message, { code: "http", status: 429 });
    });
    const client = await connect(providerFor(stub));
    const result = await call(client, { part_number: "ABC" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(message);
  });

  it("hides unexpected error details behind a generic message", async () => {
    const stub = stubClient(async () => {
      throw new Error("internal detail test-key");
    });
    const client = await connect(providerFor(stub));
    const result = await call(client, { part_number: "ABC" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unexpected error while calling the Future Electronics API.");
    expect(text(result)).not.toContain("test-key");
  });

  it("returns the missing-key message when FUTURE_API_KEY is unset", async () => {
    const client = await connect(lazyClientProvider({}));
    const result = await call(client, { part_number: "ABC" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^FUTURE_API_KEY is not set/);
  });

  it("returns a tool error if the provider itself throws a non-API error", async () => {
    const client = await connect(() => {
      throw new TypeError("boom");
    });
    const result = await call(client, { part_number: "ABC" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unexpected error while calling the Future Electronics API.");
  });
});

describe("registerLookupPartTool", () => {
  it("registers exactly one tool and does not call the provider", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const getClient = vi.fn();
    registerLookupPartTool(server, getClient);
    expect(getClient).not.toHaveBeenCalled();
    expect(() => registerLookupPartTool(server, getClient)).toThrow(/already registered/);
  });
});

describe("buildLookupPartResult", () => {
  const base = { max_offers: 10, raw: false } as const;

  it("does not mutate the upstream response", () => {
    const resp = manyOffers(12);
    const before = clone(resp);
    buildLookupPartResult(resp, { ...base, max_offers: 2, quantity: 1 });
    buildLookupPartResult(resp, { ...base, max_offers: 2, raw: true });
    expect(resp).toEqual(before);
  });

  it("keeps total_offers equal to offers length when nothing is truncated", () => {
    const out = buildLookupPartResult(manyOffers(3), base) as any;
    expect(out.total_offers).toBe(3);
    expect(out.offers).toHaveLength(3);
  });

  it("pairs price_at_quantity with the right offer after truncation", () => {
    const out = buildLookupPartResult(manyOffers(5), { ...base, max_offers: 2, quantity: 7 }) as any;
    expect(out.offers.map((o: any) => o.price_at_quantity.price_break.unit_price)).toEqual([0, 0.01]);
  });

  it("tolerates null and missing offers arrays", () => {
    for (const offers of [null, undefined]) {
      const resp = { lookup_value: "X", offers } as unknown as PartLookupResponse;
      const out = buildLookupPartResult(resp, { ...base, quantity: 5 }) as any;
      expect(out.total_offers).toBe(0);
      expect(out.offers).toEqual([]);
      expect(buildLookupPartResult(resp, { ...base, raw: true })).toBe(resp);
    }
  });

  it("gives null offers an empty summary and a no_pricing result", () => {
    const resp = { offers: [null] } as unknown as PartLookupResponse;
    const out = buildLookupPartResult(resp, { ...base, quantity: 1 }) as any;
    expect(out.offers).toEqual([{ price_at_quantity: { price_break: null, reason: "no_pricing" } }]);
  });
});
