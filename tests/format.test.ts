import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRICING_DISCLAIMER,
  priceAt,
  summarizeBatch,
  summarizeLookup,
  summarizeOffer,
} from "../src/format.js";
import type { BatchLookupResponse, Offer, PartLookupResponse } from "../src/types.js";

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const single = loadFixture("part-lookup.json") as PartLookupResponse;
const batch = loadFixture("batch-lookup.json") as BatchLookupResponse;
const full = single.offers[0]!;
const sparse = single.offers[1]!;
const clone = <T>(v: T): T => structuredClone(v);
const lines = (v: unknown): number => JSON.stringify(v, null, 2).split("\n").length;

/** An offer with only the given pricing. */
const priced = (pricing: Offer["pricing"]): Offer => ({ pricing });

describe("PRICING_DISCLAIMER", () => {
  it("says pricing is not an official quote", () => {
    expect(PRICING_DISCLAIMER).toMatch(/^Pricing is not an official quote/);
  });
});

describe("summarizeOffer", () => {
  it("summarizes the full fixture offer in a stable key order", () => {
    const s = summarizeOffer(full);
    expect(s).toEqual({
      mpn: "TEST-1234",
      seller_part_number: "9999999",
      web_url: "https://example.com/p/9999999",
      quantity_available: 12000,
      quantity_on_order: 5000,
      quantity_minimum: 1000,
      order_mult_qty: 1000,
      lead_time: "12 Weeks",
      currency_code: "USD",
      pricing_type: "Preferred",
      price_breaks: [
        { from: 1000, to: 4999, unit_price: 0.42 },
        { from: 5000, unit_price: 0.37 },
      ],
      package_type: "REEL",
      mpq: "1000",
      rohs: "Y",
      datasheet_url: "https://example.com/docs/test-1234.pdf",
    });
    expect(Object.keys(s)).toEqual([
      "mpn",
      "seller_part_number",
      "web_url",
      "quantity_available",
      "quantity_on_order",
      "quantity_minimum",
      "order_mult_qty",
      "lead_time",
      "currency_code",
      "pricing_type",
      "price_breaks",
      "package_type",
      "mpq",
      "rohs",
      "datasheet_url",
    ]);
  });

  it("omits null and empty fields and passes CALL lead time through", () => {
    expect(summarizeOffer(sparse)).toEqual({
      mpn: "TEST-1234",
      seller_part_number: "9999998",
      lead_time: "CALL",
    });
  });

  it("includes the batch fixture's date code and EUR currency", () => {
    const s = summarizeOffer(batch.lookup_parts[1]!.offers[0]!);
    expect(s.date_code).toBe("2524");
    expect(s.package_type).toBe("CUTT");
    expect(s.currency_code).toBe("EUR");
    expect(s.lead_time).toBe("8 Weeks");
    expect(s.mpq).toBeUndefined();
  });

  it("includes image URLs only when asked", () => {
    expect(summarizeOffer(full).image_urls).toBeUndefined();
    expect(summarizeOffer(full, { images: true }).image_urls).toEqual([
      "https://example.com/img/test-1234.jpg",
    ]);
  });

  it("skips images without a usable URL and omits an empty image list", () => {
    const offer: Offer = {
      images: [{ url: null }, { type: "PNG" }, { url: "" }, null as never, { url: "https://x/a.png" }],
    };
    expect(summarizeOffer(offer, { images: true }).image_urls).toEqual(["https://x/a.png"]);
    expect(summarizeOffer(sparse, { images: true })).not.toHaveProperty("image_urls");
    expect(summarizeOffer({ images: null }, { images: true })).toEqual({});
  });

  it("returns {} for null, undefined, empty and non-object input", () => {
    expect(summarizeOffer(null)).toEqual({});
    expect(summarizeOffer(undefined)).toEqual({});
    expect(summarizeOffer({})).toEqual({});
    expect(summarizeOffer("offer" as never)).toEqual({});
    expect(summarizeOffer([] as never)).toEqual({});
  });

  it("does not throw when every nested field is null", () => {
    const offer = {
      _orbweaver_data: null,
      part_id: null,
      part_attributes: null,
      categories: null,
      documents: null,
      images: null,
      quantities: null,
      pricing: null,
      people_and_places: null,
      pricing_type: null,
      currency: null,
      internal1: null,
    } satisfies Offer;
    expect(summarizeOffer(offer, { images: true })).toEqual({});
  });

  it("tolerates wrong types and null entries inside arrays", () => {
    const offer = {
      part_id: { mpn: 42, seller_part_number: "" },
      quantities: { quantity_available: "12", quantity_minimum: Number.NaN },
      part_attributes: [null, { value: "x" }, { name: "rohs", value: { nested: true } }],
      documents: [null, { type: "Datasheet" }],
      pricing: [null, { unit_price: "1" }, { quantity_from: 1 }],
      currency: "USD",
    } as unknown as Offer;
    expect(() => summarizeOffer(offer, { images: true })).not.toThrow();
    expect(summarizeOffer(offer)).toEqual({});
  });

  it("keeps attribute values of every type and uses the first match", () => {
    const offer: Offer = {
      part_attributes: [
        { name: "packageType", value: "TRAY" },
        { name: "packageType", value: "REEL" },
        { name: "mpq", value: 250 },
        { name: "rohs", value: true },
        { name: "dateCode", value: "" },
      ],
    };
    expect(summarizeOffer(offer)).toEqual({ package_type: "TRAY", mpq: 250, rohs: true });
    expect(summarizeOffer({ part_attributes: [{ name: "rohs", value: false }] })).toEqual({
      rohs: false,
    });
  });

  it("matches attribute names exactly", () => {
    expect(summarizeOffer({ part_attributes: [{ name: "PackageType", value: "REEL" }] })).toEqual(
      {},
    );
  });

  it("picks the first datasheet case-insensitively and skips ones without a URL", () => {
    const offer: Offer = {
      documents: [
        { type: "Brochure", url: "https://x/brochure.pdf" },
        { type: "DATASHEET", url: null },
        { type: " datasheet ", url: "https://x/ds1.pdf" },
        { type: "Datasheet", url: "https://x/ds2.pdf" },
      ],
    };
    expect(summarizeOffer(offer).datasheet_url).toBe("https://x/ds1.pdf");
    expect(summarizeOffer({ documents: [{ type: "Brochure", url: "u" }] })).toEqual({});
  });

  it("formats lead time with and without units", () => {
    expect(summarizeOffer({ quantities: { factory_leadtime: "4" } }).lead_time).toBe("4");
    expect(
      summarizeOffer({ quantities: { factory_leadtime: "call", factory_leadtime_units: "Weeks" } })
        .lead_time,
    ).toBe("CALL");
    expect(summarizeOffer({ quantities: { factory_leadtime: " " } })).toEqual({});
  });

  it("keeps zero quantities", () => {
    expect(summarizeOffer({ quantities: { quantity_available: 0 } })).toEqual({
      quantity_available: 0,
    });
  });

  it("sorts price breaks and drops invalid ones", () => {
    const s = summarizeOffer(
      priced([
        { unit_price: 0.1, quantity_from: 100, quantity_to: null },
        { unit_price: 0.2, quantity_from: 1, quantity_to: 99 },
        { unit_price: null, quantity_from: 50 },
      ]),
    );
    expect(s.price_breaks).toEqual([
      { from: 1, to: 99, unit_price: 0.2 },
      { from: 100, unit_price: 0.1 },
    ]);
  });

  it("does not mutate the input offer", () => {
    const offer = clone(full);
    offer.pricing!.reverse();
    const before = clone(offer);
    summarizeOffer(offer, { images: true });
    expect(offer).toEqual(before);
  });
});

describe("summarizeLookup", () => {
  it("summarizes the fixture with the disclaimer", () => {
    const s = summarizeLookup(single);
    expect(Object.keys(s)).toEqual(["lookup_value", "lookup_results", "note", "offers"]);
    expect(s.lookup_value).toBe("TEST-1234");
    expect(s.lookup_results).toBe("2 Offers found");
    expect(s.note).toBe(PRICING_DISCLAIMER);
    expect(s.offers).toEqual([summarizeOffer(full), summarizeOffer(sparse)]);
  });

  it("is under 40 lines of pretty-printed JSON for the fixture (acceptance criterion)", () => {
    expect(lines(summarizeLookup(single))).toBeLessThan(40);
    expect(lines(summarizeOffer(full))).toBeLessThan(40);
  });

  it("is JSON round-trippable", () => {
    const s = summarizeLookup(single, { images: true });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("passes the images option through", () => {
    expect(summarizeLookup(single, { images: true }).offers[0]!.image_urls).toHaveLength(1);
  });

  it("returns the untouched response with raw", () => {
    expect(summarizeLookup(single, { raw: true })).toBe(single);
  });

  it("keeps an empty offers array for no matches", () => {
    const s = summarizeLookup({ lookup_results: "0 Offers found", offers: [] });
    expect(s).toEqual({ lookup_results: "0 Offers found", note: PRICING_DISCLAIMER, offers: [] });
  });

  it("does not throw on malformed responses", () => {
    const empty = { note: PRICING_DISCLAIMER, offers: [] };
    expect(summarizeLookup(null as never)).toEqual(empty);
    expect(summarizeLookup({} as never)).toEqual(empty);
    expect(summarizeLookup({ offers: null } as never)).toEqual(empty);
    expect(summarizeLookup({ offers: [null] } as never).offers).toEqual([{}]);
  });
});

describe("summarizeBatch", () => {
  it("summarizes each part with the disclaimer", () => {
    const s = summarizeBatch(batch);
    expect(s.note).toBe(PRICING_DISCLAIMER);
    expect(s.parts).toHaveLength(2);
    expect(s.parts[0]).toEqual({
      part_number: "TEST-0000",
      lookup_results: "0 Offers found",
      offers: [],
    });
    expect(Object.keys(s.parts[1]!)).toEqual(["part_number", "lookup_results", "offers"]);
    expect(s.parts[1]!.offers[0]!.mpn).toBe("TEST-5678");
    expect(s.parts[1]!.offers[0]!.image_urls).toBeUndefined();
  });

  it("passes the images option through", () => {
    expect(summarizeBatch(batch, { images: true }).parts[1]!.offers[0]!.image_urls).toEqual([
      "https://example.com/img/test-5678.png",
    ]);
  });

  it("returns the untouched response with raw", () => {
    expect(summarizeBatch(batch, { raw: true })).toBe(batch);
  });

  it("does not throw on malformed responses", () => {
    const empty = { note: PRICING_DISCLAIMER, parts: [] };
    expect(summarizeBatch(null as never)).toEqual(empty);
    expect(summarizeBatch({} as never)).toEqual(empty);
    expect(summarizeBatch({ lookup_parts: null } as never)).toEqual(empty);
    expect(summarizeBatch({ lookup_parts: [null, { offers: null }] } as never).parts).toEqual([
      { offers: [] },
    ]);
  });
});

describe("priceAt", () => {
  it("returns below_minimum with the MOQ when qty is under the lowest break", () => {
    expect(priceAt(full, 999)).toEqual({
      price_break: null,
      reason: "below_minimum",
      quantity_minimum: 1000,
    });
    expect(priceAt(full, 1)).toMatchObject({ reason: "below_minimum" });
  });

  it("matches exactly on break boundaries", () => {
    expect(priceAt(full, 1000)).toEqual({
      price_break: { from: 1000, to: 4999, unit_price: 0.42 },
    });
    expect(priceAt(full, 4999).price_break?.unit_price).toBe(0.42);
    expect(priceAt(full, 5000)).toEqual({ price_break: { from: 5000, unit_price: 0.37 } });
  });

  it("uses the open-ended break for any large qty", () => {
    expect(priceAt(full, 1_000_000_000).price_break?.unit_price).toBe(0.37);
  });

  it("does not assume breaks are sorted", () => {
    const offer = clone(full);
    offer.pricing!.reverse();
    expect(priceAt(offer, 999)).toMatchObject({ reason: "below_minimum", quantity_minimum: 1000 });
    expect(priceAt(offer, 2000).price_break?.unit_price).toBe(0.42);
    expect(priceAt(offer, 6000).price_break?.unit_price).toBe(0.37);
  });

  it("prefers the break with the highest from when breaks overlap", () => {
    const offer = priced([
      { unit_price: 0.5, quantity_from: 1, quantity_to: null },
      { unit_price: 0.3, quantity_from: 10, quantity_to: 100 },
    ]);
    expect(priceAt(offer, 5).price_break?.unit_price).toBe(0.5);
    expect(priceAt(offer, 50).price_break?.unit_price).toBe(0.3);
    expect(priceAt(offer, 500).price_break?.unit_price).toBe(0.5);
  });

  it("returns no_matching_break above a bounded top break or in a gap", () => {
    const offer = priced([
      { unit_price: 0.5, quantity_from: 1, quantity_to: 9 },
      { unit_price: 0.3, quantity_from: 20, quantity_to: 99 },
    ]);
    expect(priceAt(offer, 15)).toEqual({ price_break: null, reason: "no_matching_break" });
    expect(priceAt(offer, 100)).toEqual({ price_break: null, reason: "no_matching_break" });
  });

  it("treats a missing quantity_to as open-ended", () => {
    expect(priceAt(priced([{ unit_price: 1, quantity_from: 1 }]), 99).price_break).toEqual({
      from: 1,
      unit_price: 1,
    });
  });

  it("returns no_pricing for missing, null, empty or all-invalid pricing", () => {
    const none = { price_break: null, reason: "no_pricing" };
    expect(priceAt(sparse, 1)).toEqual(none);
    expect(priceAt({}, 1)).toEqual(none);
    expect(priceAt(null, 1)).toEqual(none);
    expect(priceAt(undefined, 1)).toEqual(none);
    expect(priceAt(priced(null), 1)).toEqual(none);
    expect(priceAt(priced([{ unit_price: null, quantity_from: 1 }]), 1)).toEqual(none);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid qty %s",
    (qty) => {
      expect(() => priceAt(full, qty)).toThrow(RangeError);
    },
  );

  it("rejects a non-number qty", () => {
    expect(() => priceAt(full, "10" as never)).toThrow(RangeError);
  });
});
