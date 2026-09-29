import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BatchLookupPartSchema,
  BatchLookupResponseSchema,
  CategorySchema,
  CurrencySchema,
  DocumentSchema,
  ErrorResponseSchema,
  ImageSchema,
  LookupTypeSchema,
  OfferSchema,
  OrbweaverDataSchema,
  PartAttributeSchema,
  PartIdSchema,
  PartLookupResponseSchema,
  PeopleAndPlacesSchema,
  PriceBreakSchema,
  QuantitiesSchema,
  type BatchLookupResponse,
  type PartLookupResponse,
} from "../src/types.js";

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const clone = <T>(value: T): T => structuredClone(value);

const single = loadFixture("part-lookup.json") as PartLookupResponse;
const batch = loadFixture("batch-lookup.json") as BatchLookupResponse;

describe("fixtures", () => {
  it("parses the single-lookup fixture", () => {
    const parsed = PartLookupResponseSchema.parse(single);
    expect(parsed.lookup_type).toBe("exact");
    expect(parsed.offers).toHaveLength(2);
    expect(parsed.offers[0]?.part_id?.mpn).toBe("TEST-1234");
    expect(parsed.offers[0]?.pricing?.[1]?.quantity_to).toBeNull();
  });

  it("parses the null-heavy offer in the single-lookup fixture", () => {
    const offer = OfferSchema.parse(single.offers[1]);
    expect(offer._orbweaver_data).toBeNull();
    expect(offer.currency).toBeNull();
    expect(offer.quantities?.factory_leadtime).toBe("CALL");
  });

  it("parses the batch fixture, including a part with zero offers", () => {
    const parsed = BatchLookupResponseSchema.parse(batch);
    expect(parsed.lookup_parts).toHaveLength(2);
    expect(parsed.lookup_parts[0]?.offers).toEqual([]);
    expect(parsed.lookup_parts[1]?.offers).toHaveLength(1);
    expect(parsed.lookup_parts[1]?.offers[0]?.part_id?.unit_weight).toBe("1 oz");
  });

  it("parses the fixture output losslessly", () => {
    expect(PartLookupResponseSchema.parse(single)).toEqual(single);
    expect(BatchLookupResponseSchema.parse(batch)).toEqual(batch);
  });
});

describe("LookupTypeSchema", () => {
  it.each(["default", "exact", "contains", "starts_with"])("accepts %s", (value) => {
    expect(LookupTypeSchema.parse(value)).toBe(value);
  });

  it.each(["", "EXACT", "startsWith", "starts-with", "fuzzy", 1, null, undefined])(
    "rejects %j",
    (value) => {
      expect(LookupTypeSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("PartLookupResponseSchema", () => {
  it("accepts an unexpected lookup_type echo (lenient response parsing)", () => {
    const payload = { ...clone(single), lookup_type: "EXACT" };
    expect(PartLookupResponseSchema.parse(payload).lookup_type).toBe("EXACT");
  });

  it("rejects a non-string lookup_type echo", () => {
    const payload = { ...clone(single), lookup_type: 42 };
    expect(PartLookupResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts a null or missing lookup_type", () => {
    expect(PartLookupResponseSchema.safeParse({ offers: [], lookup_type: null }).success).toBe(true);
    expect(PartLookupResponseSchema.safeParse({ offers: [] }).success).toBe(true);
  });

  it("accepts an empty offers array", () => {
    const parsed = PartLookupResponseSchema.parse({
      lookup_value: "NOPE-0",
      lookup_type: "default",
      lookup_results: "0 Offers found",
      offers: [],
    });
    expect(parsed.offers).toEqual([]);
  });

  // Decision: `offers` is required. A no-match lookup returns `offers: []`,
  // so a missing or null array means the response is malformed.
  it("rejects a response without an offers array", () => {
    const { offers: _omit, ...rest } = clone(single);
    expect(PartLookupResponseSchema.safeParse(rest).success).toBe(false);
    expect(PartLookupResponseSchema.safeParse({ ...rest, offers: null }).success).toBe(false);
    expect(PartLookupResponseSchema.safeParse({ ...rest, offers: {} }).success).toBe(false);
  });

  it("keeps unknown top-level fields", () => {
    const parsed = PartLookupResponseSchema.parse({ offers: [], extra_field: { a: 1 } });
    expect(parsed).toMatchObject({ extra_field: { a: 1 } });
  });

  it.each([null, "string", 42, []])("rejects a non-object body %j", (value) => {
    expect(PartLookupResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an offer that is not an object", () => {
    expect(PartLookupResponseSchema.safeParse({ offers: ["x"] }).success).toBe(false);
  });
});

describe("BatchLookupResponseSchema", () => {
  it("accepts an empty lookup_parts array", () => {
    expect(BatchLookupResponseSchema.parse({ lookup_parts: [] }).lookup_parts).toEqual([]);
  });

  it("rejects a missing or null lookup_parts", () => {
    expect(BatchLookupResponseSchema.safeParse({}).success).toBe(false);
    expect(BatchLookupResponseSchema.safeParse({ lookup_parts: null }).success).toBe(false);
  });

  it("rejects a part without an offers array", () => {
    const payload = { lookup_parts: [{ part_number: "TEST-1", lookup_results: "x" }] };
    expect(BatchLookupResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("keeps unknown fields on the response and on each part", () => {
    const parsed = BatchLookupResponseSchema.parse({
      lookup_parts: [{ offers: [], note: "extra" }],
      trace_id: "abc",
    });
    expect(parsed).toMatchObject({ trace_id: "abc" });
    expect(parsed.lookup_parts[0]).toMatchObject({ note: "extra" });
  });

  it("accepts null part_number and lookup_results", () => {
    const part = BatchLookupPartSchema.parse({ part_number: null, lookup_results: null, offers: [] });
    expect(part.part_number).toBeNull();
  });
});

describe("OfferSchema", () => {
  it("accepts an empty object", () => {
    expect(OfferSchema.parse({})).toEqual({});
  });

  it("accepts null for every documented field", () => {
    const keys = [
      "_orbweaver_data",
      "part_id",
      "part_attributes",
      "categories",
      "documents",
      "images",
      "quantities",
      "pricing",
      "people_and_places",
      "pricing_type",
      "currency",
      "internal1",
    ];
    const offer = Object.fromEntries(keys.map((k) => [k, null]));
    expect(OfferSchema.parse(offer)).toEqual(offer);
  });

  it("keeps unknown fields at every nesting level", () => {
    const offer = clone(single.offers[0]) as Record<string, any>;
    offer.new_top = 1;
    offer.part_id.new_id_field = "x";
    offer.quantities.new_qty = 5;
    offer.pricing[0].new_price = true;
    offer.part_attributes[0].unit = "pcs";
    const parsed = OfferSchema.parse(offer) as Record<string, any>;
    expect(parsed.new_top).toBe(1);
    expect(parsed.part_id.new_id_field).toBe("x");
    expect(parsed.quantities.new_qty).toBe(5);
    expect(parsed.pricing[0].new_price).toBe(true);
    expect(parsed.part_attributes[0].unit).toBe("pcs");
  });

  it.each([
    ["pricing", "not-an-array"],
    ["part_attributes", {}],
    ["part_id", "9999999"],
    ["pricing_type", 1],
    ["internal1", false],
  ])("rejects %s with the wrong type", (key, value) => {
    expect(OfferSchema.safeParse({ [key]: value }).success).toBe(false);
  });
});

describe("PartIdSchema", () => {
  it("accepts unit_weight as a number", () => {
    expect(PartIdSchema.parse({ unit_weight: 1.25 }).unit_weight).toBe(1.25);
  });

  it("accepts unit_weight as a string", () => {
    expect(PartIdSchema.parse({ unit_weight: "1 oz" }).unit_weight).toBe("1 oz");
  });

  it("accepts unit_weight as null or missing", () => {
    expect(PartIdSchema.parse({ unit_weight: null }).unit_weight).toBeNull();
    expect(PartIdSchema.parse({}).unit_weight).toBeUndefined();
  });

  it.each([true, {}, []])("rejects unit_weight %j", (value) => {
    expect(PartIdSchema.safeParse({ unit_weight: value }).success).toBe(false);
  });

  it("accepts buyer_part_number and rejects a numeric mpn", () => {
    expect(PartIdSchema.parse({ buyer_part_number: "CPN-1" }).buyer_part_number).toBe("CPN-1");
    expect(PartIdSchema.safeParse({ mpn: 1234 }).success).toBe(false);
  });
});

describe("PartAttributeSchema", () => {
  it.each(["92", 2000, 0.5, true, false, null])("accepts value %j", (value) => {
    expect(PartAttributeSchema.parse({ name: "x", value }).value).toBe(value);
  });

  it("accepts a missing value", () => {
    expect(PartAttributeSchema.parse({ name: "x" }).value).toBeUndefined();
  });

  it.each([{}, [], ["a"]])("rejects value %j", (value) => {
    expect(PartAttributeSchema.safeParse({ name: "x", value }).success).toBe(false);
  });

  it("rejects a non-string name", () => {
    expect(PartAttributeSchema.safeParse({ name: 5, value: "x" }).success).toBe(false);
  });
});

describe("QuantitiesSchema", () => {
  it("accepts all nulls", () => {
    expect(QuantitiesSchema.safeParse(single.offers[1]?.quantities).success).toBe(true);
  });

  it("rejects a numeric factory_leadtime and a string quantity", () => {
    expect(QuantitiesSchema.safeParse({ factory_leadtime: 8 }).success).toBe(false);
    expect(QuantitiesSchema.safeParse({ quantity_available: "10" }).success).toBe(false);
  });
});

describe("PriceBreakSchema", () => {
  it("accepts a null quantity_to for an open-ended break", () => {
    const pb = PriceBreakSchema.parse({ unit_price: 0.1, quantity_from: 100, quantity_to: null });
    expect(pb.quantity_to).toBeNull();
  });

  it("rejects a string unit_price", () => {
    expect(PriceBreakSchema.safeParse({ unit_price: "0.10" }).success).toBe(false);
  });
});

describe("small object schemas", () => {
  it.each([
    ["OrbweaverDataSchema", OrbweaverDataSchema, { datasource_name: "X" }, { datasource_name: 1 }],
    ["CategorySchema", CategorySchema, { id: "1", name: "a", subcategory_name: "b" }, { id: 1 }],
    ["DocumentSchema", DocumentSchema, { url: "https://example.com/a.pdf", revision: null }, { url: 1 }],
    ["ImageSchema", ImageSchema, { url: "https://example.com/a.png", type: "PNG" }, { type: [] }],
    ["PeopleAndPlacesSchema", PeopleAndPlacesSchema, { buyer_address_id: null, site: "NA" }, { site: 1 }],
    ["CurrencySchema", CurrencySchema, { currency_code: "USD" }, { currency_code: 840 }],
  ] as const)("%s accepts valid, empty and extra-field input and rejects wrong types", (_n, schema, good, bad) => {
    expect(schema.parse(good)).toEqual(good);
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ ...good, extra: 1 })).toMatchObject({ extra: 1 });
    expect(schema.safeParse(bad).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});

describe("ErrorResponseSchema", () => {
  it("parses a message with a string status", () => {
    const body = {
      message: "Part number must be at least 3 characters for starts with or contains search",
      status: "bad_request",
    };
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it("parses a numeric status", () => {
    expect(ErrorResponseSchema.parse({ message: "Unauthorized", status: 401 }).status).toBe(401);
  });

  it("parses the `error` variant without a message", () => {
    const parsed = ErrorResponseSchema.parse({ status: 400, error: "Bad Request" });
    expect(parsed.error).toBe("Bad Request");
    expect(parsed.message).toBeUndefined();
  });

  it("keeps unknown fields", () => {
    expect(ErrorResponseSchema.parse({ status: 500, path: "/x" })).toMatchObject({ path: "/x" });
  });

  it("rejects a body without a status", () => {
    expect(ErrorResponseSchema.safeParse({ message: "oops" }).success).toBe(false);
  });

  it.each([null, true, {}, []])("rejects status %j", (status) => {
    expect(ErrorResponseSchema.safeParse({ message: "x", status }).success).toBe(false);
  });

  it("does not match a successful lookup body", () => {
    expect(ErrorResponseSchema.safeParse(single).success).toBe(false);
  });
});
