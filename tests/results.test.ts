import { describe, expect, it } from "vitest";
import {
  MAX_STORED_RESULTS,
  RESULT_TTL_MS,
  ResultStore,
  defaultResultStore,
  unknownResultMessage,
  type StoredResult,
} from "../src/results.js";
import type { LookupTotals } from "../src/tools/lookupParts.js";

const totals: LookupTotals = {
  requested: 1,
  unique: 1,
  found: 1,
  not_found: 0,
  errors: 0,
  not_attempted: 0,
  short_stock: 0,
  below_moq: 0,
  call_for_leadtime: 0,
  batches: 1,
  rate_limited: false,
};

const data = (name = "LM317T"): Omit<StoredResult, "created_at"> => ({
  parts: [{ part_number: name, quantity: 1, quantity_given: false, status: "found" }],
  batches: [{ part_numbers: [name], response: { lookup_parts: [] } }],
  totals,
});

/** A controllable clock. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("ResultStore basics", () => {
  it("stores structured data and returns it by id, with created_at from the clock", () => {
    const clock = fakeClock(42);
    const store = new ResultStore({ now: clock.now });
    const d = data();
    const id = store.put(d);
    const got = store.get(id)!;
    expect(got).toEqual({ ...d, created_at: 42 });
    // Structured, not serialized: the same part objects are kept.
    expect(got.parts[0]).toBe(d.parts[0]);
    expect(store.size).toBe(1);
  });

  it("returns undefined for an unknown id", () => {
    const store = new ResultStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.get("")).toBeUndefined();
  });

  it("uses random UUIDs by default: unique, not sequential", () => {
    const store = new ResultStore({ maxEntries: 100 });
    const ids = Array.from({ length: 50 }, () => store.put(data()));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("regenerates an id that collides with a live entry", () => {
    const seq = ["a", "a", "b"];
    const store = new ResultStore({ newId: () => seq.shift()! });
    expect(store.put(data("P1"))).toBe("a");
    expect(store.put(data("P2"))).toBe("b");
    expect(store.get("a")!.parts[0]!.part_number).toBe("P1");
  });

  it("clear drops every entry", () => {
    const store = new ResultStore();
    const id = store.put(data());
    store.clear();
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("rejects invalid options", () => {
    expect(() => new ResultStore({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new ResultStore({ ttlMs: -1 })).toThrow(RangeError);
    expect(() => new ResultStore({ ttlMs: Number.NaN })).toThrow(RangeError);
    expect(() => new ResultStore({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new ResultStore({ maxEntries: 1.5 })).toThrow(RangeError);
  });

  it("has the documented defaults and a shared default store", () => {
    expect(RESULT_TTL_MS).toBe(60 * 60 * 1000);
    expect(MAX_STORED_RESULTS).toBe(20);
    expect(defaultResultStore).toBeInstanceOf(ResultStore);
  });
});

describe("ResultStore TTL (fake clock)", () => {
  it("expires an entry exactly ttl after its last access", () => {
    const clock = fakeClock();
    const store = new ResultStore({ now: clock.now });
    const id = store.put(data());
    clock.advance(RESULT_TTL_MS - 1);
    expect(store.size).toBe(1);
    clock.advance(1);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("refreshes the TTL on every read", () => {
    const clock = fakeClock();
    const store = new ResultStore({ now: clock.now });
    const id = store.put(data());
    for (let i = 0; i < 5; i++) {
      clock.advance(RESULT_TTL_MS - 1);
      expect(store.get(id)).toBeDefined();
    }
    clock.advance(RESULT_TTL_MS);
    expect(store.get(id)).toBeUndefined();
  });

  it("keeps created_at fixed when reads refresh the TTL", () => {
    const clock = fakeClock(5);
    const store = new ResultStore({ now: clock.now });
    const id = store.put(data());
    clock.advance(1000);
    expect(store.get(id)!.created_at).toBe(5);
  });

  it("expires only stale entries and honors a custom ttl", () => {
    const clock = fakeClock();
    const store = new ResultStore({ now: clock.now, ttlMs: 100 });
    const old = store.put(data("OLD"));
    clock.advance(60);
    const fresh = store.put(data("NEW"));
    clock.advance(40);
    expect(store.get(old)).toBeUndefined();
    expect(store.get(fresh)).toBeDefined();
  });

  it("frees expired slots so they do not count toward the LRU cap", () => {
    const clock = fakeClock();
    const store = new ResultStore({ now: clock.now, maxEntries: 2, ttlMs: 10 });
    store.put(data("A"));
    clock.advance(5);
    const b = store.put(data("B"));
    clock.advance(6); // A expired, B still live
    const c = store.put(data("C"));
    expect(store.get(b)).toBeDefined();
    expect(store.get(c)).toBeDefined();
  });
});

describe("ResultStore LRU", () => {
  it("keeps at most 20 entries by default, evicting the oldest", () => {
    const store = new ResultStore();
    const ids = Array.from({ length: MAX_STORED_RESULTS + 1 }, (_, i) => store.put(data(`P${i}`)));
    expect(store.size).toBe(MAX_STORED_RESULTS);
    expect(store.get(ids[0]!)).toBeUndefined();
    for (const id of ids.slice(1)) expect(store.get(id)).toBeDefined();
  });

  it("evicts the least recently used, not the least recently stored", () => {
    const store = new ResultStore({ maxEntries: 3 });
    const a = store.put(data("A"));
    const b = store.put(data("B"));
    const c = store.put(data("C"));
    store.get(a); // A is now the most recent; B is least recent
    const d = store.put(data("D"));
    expect(store.get(b)).toBeUndefined();
    expect(store.get(a)).toBeDefined();
    expect(store.get(c)).toBeDefined();
    expect(store.get(d)).toBeDefined();
  });

  it("with maxEntries 1 keeps only the newest", () => {
    const store = new ResultStore({ maxEntries: 1 });
    const a = store.put(data("A"));
    const b = store.put(data("B"));
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeDefined();
  });

  it("a failed get does not change the LRU order", () => {
    const store = new ResultStore({ maxEntries: 2 });
    const a = store.put(data("A"));
    const b = store.put(data("B"));
    store.get("missing");
    store.put(data("C"));
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeDefined();
  });
});

describe("unknownResultMessage", () => {
  it("names the id, the expiry rules and the fix", () => {
    const msg = unknownResultMessage("abc");
    expect(msg).toContain('"abc"');
    expect(msg).toContain("60 minutes");
    expect(msg).toContain(String(MAX_STORED_RESULTS));
    expect(msg).toContain("future_lookup_parts");
  });
});
