import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  BASE_BACKOFF_MS,
  BATCH_LOOKUP_PATH,
  DEFAULT_TIMEOUT_MS,
  FutureApiError,
  FutureClient,
  LOOKUP_PATH,
  MAX_BATCH_PARTS,
  MAX_RETRY_DELAY_MS,
  STATUS_MESSAGES,
  redact,
  redactCause,
  retryDelayMs,
  validateBatch,
  validateLookupType,
  validatePartNumber,
  type FutureClientOptions,
} from "../src/client.js";
import type { LookupType } from "../src/types.js";

const KEY = "test-key";
const BASE = "https://api.futureelectronics.com";
const partFixture = readFileSync(new URL("./fixtures/part-lookup.json", import.meta.url), "utf8");
const batchFixture = readFileSync(new URL("./fixtures/batch-lookup.json", import.meta.url), "utf8");

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function setup(responses: Array<Response | Error>, options: Partial<FutureClientOptions> = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new FutureClient({ apiKey: KEY, fetch: fetchMock, sleep, ...options });
  return { client, fetchMock, sleep };
}

async function catchError(promise: Promise<unknown>): Promise<FutureApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FutureApiError);
    return error as FutureApiError;
  }
  throw new Error("expected promise to reject");
}

/** Serializes an error with its whole cause chain, for leak checks. */
function dump(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; current !== undefined && i < 10; i++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message, String(current.stack));
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

describe("redact", () => {
  it("replaces every occurrence of the key", () => {
    expect(redact("a test-key b test-keytest-key", KEY)).toBe("a [REDACTED] b [REDACTED][REDACTED]");
  });
  it("returns text unchanged when the key is absent or empty", () => {
    expect(redact("nothing here", KEY)).toBe("nothing here");
    expect(redact("nothing here", "")).toBe("nothing here");
    expect(redact("", KEY)).toBe("");
  });
  it("treats regex metacharacters in the key literally", () => {
    expect(redact("x a.b*c x aXbbc", "a.b*c")).toBe("x [REDACTED] x aXbbc");
  });
});

describe("redactCause", () => {
  it("rebuilds an Error with redacted message, name, and nested causes", () => {
    const inner = new Error("inner test-key");
    const outer = new TypeError("outer test-key", { cause: inner });
    const result = redactCause(outer, KEY);
    expect(result).not.toBe(outer);
    expect(result.name).toBe("TypeError");
    expect(result.message).toBe("outer [REDACTED]");
    expect((result.cause as Error).message).toBe("inner [REDACTED]");
    expect(dump(result)).not.toContain(KEY);
  });
  it("stringifies non-Error values", () => {
    expect(redactCause("boom test-key", KEY).message).toBe("boom [REDACTED]");
    expect(redactCause(undefined, KEY).message).toBe("undefined");
  });
  it("stops recursing after a few levels", () => {
    let error: Error = new Error("level test-key");
    for (let i = 0; i < 10; i++) error = new Error(`level ${i} test-key`, { cause: error });
    const result = redactCause(error, KEY);
    let depth = 0;
    for (let c: unknown = result; c instanceof Error; c = c.cause) depth++;
    expect(depth).toBe(4);
    expect(dump(result)).not.toContain(KEY);
  });
});

describe("validatePartNumber", () => {
  it.each([
    ["ABC", "ABC"],
    ["  LM317T  ", "LM317T"],
    ["A-B,C", "A-B,C"],
    ["1-2-3", "1-2-3"],
  ])("accepts %j", (input, expected) => {
    expect(validatePartNumber(input)).toBe(expected);
  });
  it.each(["", "   ", "AB", "A-B", "--,--", "a b", "é日本"])("rejects %j", (input) => {
    expect(() => validatePartNumber(input)).toThrow(/at least 3 alphanumeric/);
  });
  it.each([undefined, null, 123, {}])("rejects non-string %j", (input) => {
    const fn = () => validatePartNumber(input);
    expect(fn).toThrow(FutureApiError);
    expect(fn).toThrow(/must be a string/);
  });
  it("uses the invalid_input code", () => {
    try {
      validatePartNumber("A");
    } catch (error) {
      expect((error as FutureApiError).code).toBe("invalid_input");
      expect((error as FutureApiError).status).toBeUndefined();
    }
  });
});

describe("validateLookupType", () => {
  it.each(["default", "exact", "contains", "starts_with"])("accepts %s", (value) => {
    expect(validateLookupType(value)).toBe(value);
  });
  it.each(["EXACT", "fuzzy", "", undefined, 1])("rejects %j", (value) => {
    expect(() => validateLookupType(value)).toThrow(
      /lookup_type must be one of: default, exact, contains, starts_with/,
    );
  });
});

describe("validateBatch", () => {
  it("trims each part", () => {
    expect(validateBatch([" ABC ", "DEF-1"])).toEqual(["ABC", "DEF-1"]);
  });
  it("accepts exactly 1 and exactly 300 parts", () => {
    expect(validateBatch(["ABC"])).toHaveLength(1);
    expect(validateBatch(Array(MAX_BATCH_PARTS).fill("ABC"))).toHaveLength(300);
  });
  it("rejects an empty or oversized batch", () => {
    expect(() => validateBatch([])).toThrow(/at least 1/);
    expect(() => validateBatch(Array(MAX_BATCH_PARTS + 1).fill("ABC"))).toThrow(/at most 300/);
  });
  it("rejects a non-array", () => {
    expect(() => validateBatch("ABC")).toThrow(/must be an array/);
    expect(() => validateBatch(undefined)).toThrow(/must be an array/);
  });
  it("names the index of an invalid part", () => {
    expect(() => validateBatch(["ABC", "AB"])).toThrow(/Part at index 1: .*at least 3/);
    expect(() => validateBatch(["ABC", 5])).toThrow(/Part at index 1: .*must be a string/);
  });
});

describe("retryDelayMs", () => {
  it("honors Retry-After in seconds", () => {
    expect(retryDelayMs("0", 1)).toBe(0);
    expect(retryDelayMs("2", 1)).toBe(2000);
    expect(retryDelayMs("1.5", 2)).toBe(1500);
  });
  it("caps Retry-After", () => {
    expect(retryDelayMs("3600", 1)).toBe(MAX_RETRY_DELAY_MS);
  });
  it.each([null, "", "  ", "soon", "-1", "Wed, 99 Foo 2015 07:28:00 GMT", "12abc"])(
    "falls back to exponential backoff for %j",
    (value) => {
      expect(retryDelayMs(value, 1)).toBe(BASE_BACKOFF_MS);
      expect(retryDelayMs(value, 2)).toBe(BASE_BACKOFF_MS * 2);
      expect(retryDelayMs(value, 3)).toBe(BASE_BACKOFF_MS * 4);
    },
  );
  it("caps exponential backoff", () => {
    expect(retryDelayMs(null, 20)).toBe(MAX_RETRY_DELAY_MS);
  });

  const NOW = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  it("honors an HTTP-date in the future", () => {
    expect(retryDelayMs("Wed, 21 Oct 2015 07:28:05 GMT", 1, NOW)).toBe(5000);
    expect(retryDelayMs("  Wed, 21 Oct 2015 07:28:01 GMT ", 3, NOW)).toBe(1000);
  });
  it("treats an HTTP-date in the past (or now) as no wait", () => {
    expect(retryDelayMs("Wed, 21 Oct 2015 07:27:00 GMT", 1, NOW)).toBe(0);
    expect(retryDelayMs("Wed, 21 Oct 2015 07:28:00 GMT", 2, NOW)).toBe(0);
  });
  it("caps a far-future HTTP-date", () => {
    expect(retryDelayMs("Thu, 22 Oct 2015 07:28:00 GMT", 1, NOW)).toBe(MAX_RETRY_DELAY_MS);
  });
  it("uses the current time by default for HTTP-dates", () => {
    expect(retryDelayMs("Wed, 21 Oct 2015 07:28:00 GMT", 1)).toBe(0);
    expect(retryDelayMs(new Date(Date.now() + 3_600_000).toUTCString(), 1)).toBe(
      MAX_RETRY_DELAY_MS,
    );
  });
});

describe("FutureClient constructor", () => {
  it.each([
    [{ apiKey: "" }, /non-empty apiKey/],
    [{ apiKey: "   " }, /non-empty apiKey/],
    [{ apiKey: undefined as unknown as string }, /non-empty apiKey/],
    [{ apiKey: KEY, baseUrl: "http://api.futureelectronics.com" }, /https/],
    [{ apiKey: KEY, timeoutMs: 0 }, /timeoutMs/],
    [{ apiKey: KEY, timeoutMs: -1 }, /timeoutMs/],
    [{ apiKey: KEY, timeoutMs: Number.NaN }, /timeoutMs/],
    [{ apiKey: KEY, maxRetries: -1 }, /maxRetries/],
    [{ apiKey: KEY, maxRetries: 1.5 }, /maxRetries/],
  ])("rejects %j", (options, pattern) => {
    expect(() => new FutureClient(options)).toThrow(ConfigError);
    expect(() => new FutureClient(options)).toThrow(pattern);
  });

  it("uses global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(200, partFixture));
    try {
      await new FutureClient({ apiKey: KEY }).lookup("TEST-1234");
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not expose the key as an enumerable property", () => {
    const client = new FutureClient({ apiKey: KEY });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client)).not.toContain(KEY);
  });
});

describe("FutureClient.lookup", () => {
  it("sends GET with the right URL and headers, and parses the response", async () => {
    const { client, fetchMock } = setup([response(200, partFixture)]);
    const result = await client.lookup("  TEST-1234 ", "exact");
    expect(result.offers).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(BASE + LOOKUP_PATH);
    expect(parsed.searchParams.get("part_number")).toBe("TEST-1234");
    expect(parsed.searchParams.get("lookup_type")).toBe("exact");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-orbweaver-licensekey": KEY,
    });
  });

  it("omits lookup_type when not provided", async () => {
    const { client, fetchMock } = setup([response(200, partFixture)]);
    await client.lookup("TEST-1234");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has("lookup_type")).toBe(false);
  });

  it("URL-encodes part numbers with punctuation", async () => {
    const { client, fetchMock } = setup([response(200, partFixture)]);
    await client.lookup("AB&C=1#2");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("part_number")).toBe("AB&C=1#2");
    expect([...url.searchParams.keys()]).toEqual(["part_number"]);
  });

  it("uses a custom https base URL with a path prefix", async () => {
    const { client, fetchMock } = setup([response(200, partFixture)], {
      baseUrl: "https://proxy.example.test/future/",
    });
    await client.lookup("TEST-1234");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://proxy.example.test/future" + LOOKUP_PATH);
  });

  it("accepts an empty offers list", async () => {
    const body = JSON.stringify({ lookup_results: "0 Offers found", offers: [] });
    const { client } = setup([response(200, body)]);
    expect((await client.lookup("NOPE123")).offers).toEqual([]);
  });

  it("rejects invalid input before any network call", async () => {
    const { client, fetchMock } = setup([]);
    expect((await catchError(client.lookup("AB"))).code).toBe("invalid_input");
    expect((await catchError(client.lookup("ABC", "fuzzy" as LookupType))).code).toBe(
      "invalid_input",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("FutureClient.batchLookup", () => {
  it("sends POST with the parts body and parses the response", async () => {
    const { client, fetchMock } = setup([response(200, batchFixture)]);
    const result = await client.batchLookup([" TEST-0000", "TEST-5678 "]);
    expect(result.lookup_parts.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(BASE + BATCH_LOOKUP_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ parts: ["TEST-0000", "TEST-5678"] });
    expect(init?.headers).toMatchObject({ "x-orbweaver-licensekey": KEY });
  });

  it.each([[[]], [Array(301).fill("ABC")], [["ABC", "X"]]])(
    "rejects an invalid batch before any network call",
    async (parts) => {
      const { client, fetchMock } = setup([]);
      expect((await catchError(client.batchLookup(parts as string[]))).code).toBe("invalid_input");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a batch of exactly 300 parts", async () => {
    const { client, fetchMock } = setup([response(200, batchFixture)]);
    await client.batchLookup(Array(300).fill("ABC"));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).parts).toHaveLength(300);
  });
});

describe("HTTP error mapping", () => {
  it.each([400, 401, 402, 403, 406])("maps %i to its documented message", async (status) => {
    const { client, fetchMock } = setup([response(status, "")]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("http");
    expect(error.status).toBe(status);
    expect(error.message).toBe(STATUS_MESSAGES[status]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("covers every documented status", () => {
    expect(Object.keys(STATUS_MESSAGES).map(Number).sort()).toEqual([400, 401, 402, 403, 406, 429]);
    expect(STATUS_MESSAGES[401]).toMatch(/Invalid API key/);
    expect(STATUS_MESSAGES[402]).toMatch(/Purchase required/);
    expect(STATUS_MESSAGES[403]).toMatch(/Not authorized/);
    expect(STATUS_MESSAGES[406]).toMatch(/expired/);
    expect(STATUS_MESSAGES[429]).toMatch(/Rate limited/);
  });

  it.each([404, 500, 503, 302])("uses a generic message for %i", async (status) => {
    const { client } = setup([response(status, "<html>oops</html>")]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.message).toBe(`Future API request failed with HTTP ${status}.`);
    expect(error.status).toBe(status);
  });

  it("includes the body message when it parses", async () => {
    const body = JSON.stringify({ status: "bad_request", message: "Invalid lookup type" });
    const { client } = setup([response(400, body)]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.message).toBe(`${STATUS_MESSAGES[400]} API message: Invalid lookup type`);
  });

  it("falls back to the body error field", async () => {
    const body = JSON.stringify({ status: 400, error: "Bad part" });
    const { client } = setup([response(400, body)]);
    expect((await catchError(client.lookup("ABC"))).message).toMatch(/API message: Bad part$/);
  });

  it("ignores bodies that do not match the error schema", async () => {
    const { client } = setup([response(401, JSON.stringify({ message: "no status field" }))]);
    expect((await catchError(client.lookup("ABC"))).message).toBe(STATUS_MESSAGES[401]);
  });

  it("truncates a long body message", async () => {
    const body = JSON.stringify({ status: 500, message: "x".repeat(5000) });
    const { client } = setup([response(500, body)]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.message.length).toBeLessThan(400);
    expect(error.message.endsWith("…")).toBe(true);
  });

  it("redacts the key from the body message, even near the truncation point", async () => {
    const message = "x".repeat(296) + KEY + " and " + KEY;
    const { client } = setup([response(401, JSON.stringify({ status: 401, message }))]);
    const error = await catchError(client.lookup("ABC"));
    expect(dump(error)).not.toContain(KEY);
    expect(dump(error)).not.toContain("test-");
    expect(error.message).toContain("x[RED");
    expect(error.message.endsWith("…")).toBe(true);
  });
});

describe("429 retry", () => {
  it("retries and then succeeds, honoring Retry-After", async () => {
    const { client, fetchMock, sleep } = setup([
      response(429, "", { "Retry-After": "2" }),
      response(429, ""),
      response(200, partFixture),
    ]);
    expect((await client.lookup("ABC")).offers).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, BASE_BACKOFF_MS * 2]);
  });

  it("gives up after 3 attempts total", async () => {
    const body = JSON.stringify({ status: 429, message: "Slow down" });
    const { client, fetchMock, sleep } = setup([
      response(429, body),
      response(429, body),
      response(429, body),
      response(200, partFixture),
    ]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.status).toBe(429);
    expect(error.message).toBe(`${STATUS_MESSAGES[429]} API message: Slow down`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("caps a huge Retry-After", async () => {
    const { client, sleep } = setup([
      response(429, "", { "Retry-After": "86400" }),
      response(200, partFixture),
    ]);
    await client.lookup("ABC");
    expect(sleep).toHaveBeenCalledWith(MAX_RETRY_DELAY_MS);
  });

  it("retries batch lookups too", async () => {
    const { client, fetchMock } = setup([response(429, ""), response(200, batchFixture)]);
    await client.batchLookup(["ABC"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when maxRetries is 0", async () => {
    const { client, fetchMock, sleep } = setup([response(429, "")], { maxRetries: 0 });
    expect((await catchError(client.lookup("ABC"))).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([400, 401, 500, 503])("does not retry %i", async (status) => {
    const { client, fetchMock, sleep } = setup([response(status, ""), response(200, partFixture)]);
    await catchError(client.lookup("ABC"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry network errors", async () => {
    const { client, fetchMock } = setup([new TypeError("fetch failed"), response(200, partFixture)]);
    expect((await catchError(client.lookup("ABC"))).code).toBe("network");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses a real (default) sleep when none is injected", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(429, "", { "Retry-After": "1" }))
        .mockResolvedValueOnce(response(200, partFixture));
      const client = new FutureClient({ apiKey: KEY, fetch: fetchMock });
      const pending = client.lookup("ABC");
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("network errors and timeouts", () => {
  it("wraps a fetch rejection as a network error", async () => {
    const cause = new Error("ECONNREFUSED");
    const { client } = setup([new TypeError("fetch failed", { cause })]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("network");
    expect(error.status).toBeUndefined();
    expect(error.message).toBe("Network error contacting the Future API: fetch failed");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).name).toBe("TypeError");
    expect(((error.cause as Error).cause as Error).message).toBe("ECONNREFUSED");
  });

  it("wraps a non-Error rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce("socket hang up");
    const client = new FutureClient({ apiKey: KEY, fetch: fetchMock });
    const error = await catchError(client.lookup("ABC"));
    expect(error.message).toBe("Network error contacting the Future API: socket hang up");
  });

  it("treats a failure while reading the body as a network error", async () => {
    const res = response(200, partFixture);
    vi.spyOn(res, "text").mockRejectedValueOnce(new Error("terminated"));
    const { client } = setup([res]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("network");
    expect(error.message).toMatch(/terminated/);
  });

  it("times out and aborts the request", async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    });
    const client = new FutureClient({ apiKey: KEY, fetch: fetchMock, timeoutMs: 20 });
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("Timed out after 20 ms waiting for the Future API.");
    expect((error.cause as Error).name).toBe("AbortError");
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("defaults the timeout to 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const client = new FutureClient({ apiKey: KEY, fetch: fetchMock });
      const pending = catchError(client.lookup("ABC"));
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).code).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer after a successful request", async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup([response(200, partFixture)]);
      await client.lookup("ABC");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unexpected response shape", () => {
  it("rejects a non-JSON success body", async () => {
    const { client } = setup([response(200, "<html>" + "x".repeat(10_000))]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("invalid_response");
    expect(error.message).toBe(
      "Unexpected response shape from the Future API (lookup): body is not valid JSON.",
    );
  });

  it("rejects a lookup body without offers, without dumping the payload", async () => {
    const payload = JSON.stringify({ lookup_results: "y".repeat(10_000) });
    const { client } = setup([response(200, payload)]);
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("invalid_response");
    expect(error.message).toMatch(/^Unexpected response shape from the Future API \(lookup\): offers:/);
    expect(error.message.length).toBeLessThan(200);
  });

  it("rejects a batch body without lookup_parts", async () => {
    const { client } = setup([response(200, JSON.stringify({ offers: [] }))]);
    const error = await catchError(client.batchLookup(["ABC"]));
    expect(error.message).toMatch(/\(batch lookup\): lookup_parts:/);
  });

  it("reports root-level mismatches", async () => {
    const { client } = setup([response(200, "[]")]);
    expect((await catchError(client.lookup("ABC"))).message).toMatch(/\(root\)/);
  });
});

describe("key never leaks", () => {
  const leaks: Array<[string, () => Response | Error]> = [
    ["fetch rejection message", () => new TypeError(`bad header value ${KEY}`)],
    [
      "nested fetch cause",
      () => new TypeError("fetch failed", { cause: new Error(`header ${KEY} rejected`) }),
    ],
    ["error body message", () => response(401, JSON.stringify({ status: 401, message: KEY }))],
    ["error body error field", () => response(403, JSON.stringify({ status: 403, error: KEY }))],
    ["generic status body", () => response(500, JSON.stringify({ status: 500, message: `k=${KEY}` }))],
    ["429 after retries", () => response(429, JSON.stringify({ status: 429, message: KEY }))],
  ];

  it.each(leaks)("redacts the key from %s", async (_name, make) => {
    const { client } = setup([make(), make(), make()]);
    const error = await catchError(client.lookup("ABC"));
    expect(dump(error)).not.toContain(KEY);
  });

  it("redacts the key from timeout causes", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${KEY}`)));
        }),
    );
    const client = new FutureClient({ apiKey: KEY, fetch: fetchMock, timeoutMs: 5 });
    const error = await catchError(client.lookup("ABC"));
    expect(error.code).toBe("timeout");
    expect(dump(error)).not.toContain(KEY);
  });

  it("redacts the key from invalid-response details", async () => {
    // The payload carries the key in a field name and a bad value; neither may surface.
    const body = JSON.stringify({ lookup_parts: [{ [KEY]: 1, offers: KEY }] });
    const { client } = setup([response(200, body)]);
    const error = await catchError(client.batchLookup(["ABC"]));
    expect(error.code).toBe("invalid_response");
    expect(dump(error)).not.toContain(KEY);
  });

  it("redacts the key when it is echoed as the part number", async () => {
    const { client } = setup([
      response(400, JSON.stringify({ status: "bad_request", message: `Bad part ${KEY}` })),
    ]);
    const error = await catchError(client.lookup(KEY));
    expect(error.message).toContain("[REDACTED]");
    expect(dump(error)).not.toContain(KEY);
  });
});

describe("rate limiting", () => {
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  /** fetch mock whose responses the test releases one at a time. */
  function gatedFetch() {
    const pending: Array<(res: Response) => void> = [];
    const state = { active: 0, peak: 0 };
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          state.active++;
          state.peak = Math.max(state.peak, state.active);
          pending.push((res) => {
            state.active--;
            resolve(res);
          });
        }),
    );
    return { fetchMock, pending, state };
  }

  it("exposes maxConcurrency, defaulting to 4", () => {
    expect(new FutureClient({ apiKey: KEY }).maxConcurrency).toBe(4);
    expect(new FutureClient({ apiKey: KEY, maxConcurrency: 9 }).maxConcurrency).toBe(9);
  });

  it.each([
    [{ maxConcurrency: 0 }, /maxConcurrency/],
    [{ maxConcurrency: 2.5 }, /maxConcurrency/],
    [{ minRequestIntervalMs: -5 }, /minIntervalMs/],
  ])("rejects %j", (options, pattern) => {
    expect(() => new FutureClient({ apiKey: KEY, ...options })).toThrow(ConfigError);
    expect(() => new FutureClient({ apiKey: KEY, ...options })).toThrow(pattern);
  });

  it("accepts a loadConfig result directly", () => {
    const config = loadConfig({ FUTURE_API_KEY: KEY, FUTURE_MAX_CONCURRENCY: "3" });
    expect(new FutureClient(config).maxConcurrency).toBe(3);
  });

  it.each([1, 2, 4])("keeps at most %i requests in flight", async (n) => {
    const gate = gatedFetch();
    const client = new FutureClient({ apiKey: KEY, fetch: gate.fetchMock, maxConcurrency: n });
    const total = n * 2 + 1;
    const calls = Array.from({ length: total }, (_, i) =>
      i % 2 ? client.batchLookup(["ABC"]) : client.lookup("ABC"),
    );
    await flush();
    expect(gate.state.active).toBe(n);
    while (gate.pending.length) {
      gate.pending.shift()!(response(500, ""));
      await flush();
      expect(gate.state.active).toBeLessThanOrEqual(n);
    }
    await Promise.allSettled(calls);
    expect(gate.state.peak).toBe(n);
    expect(gate.fetchMock).toHaveBeenCalledTimes(total);
  });

  it("adds no delay for a single call with the defaults", async () => {
    const { client, sleep } = setup([response(200, partFixture)]);
    await client.lookup("ABC");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("frees slots after timeouts, network errors, HTTP errors and schema mismatches", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(500, ""))
      .mockResolvedValueOnce(response(200, JSON.stringify({ wrong: true })))
      .mockResolvedValueOnce(response(200, "not json"));
    const client = new FutureClient({
      apiKey: KEY,
      fetch: fetchMock,
      maxConcurrency: 1,
      timeoutMs: 10,
    });
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await catchError(client.lookup("ABC"))).code);
    expect(codes).toEqual(["timeout", "network", "http", "invalid_response", "invalid_response"]);
    // With a single slot, these would hang forever if any failure had leaked it.
    fetchMock.mockImplementation(async () => response(200, partFixture));
    await expect(Promise.all([client.lookup("ABC"), client.lookup("ABC")])).resolves.toHaveLength(
      2,
    );
  });

  it("pauses every caller after a 429 without cancelling in-flight requests", async () => {
    let time = 0;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = vi.fn(
      (ms: number) => new Promise<void>((resolve) => timers.push({ at: time + ms, resolve })),
    );
    const advance = async (ms: number) => {
      time += ms;
      for (const t of timers.filter((t) => t.at <= time)) {
        timers.splice(timers.indexOf(t), 1);
        t.resolve();
      }
      await flush();
    };
    const gate = gatedFetch();
    const client = new FutureClient({
      apiKey: KEY,
      fetch: gate.fetchMock,
      sleep,
      now: () => time,
    });

    const a = client.lookup("AAA");
    const b = client.lookup("BBB");
    await flush();
    expect(gate.fetchMock).toHaveBeenCalledTimes(2);

    // A gets a 429 with Retry-After: 2 while B is still in flight.
    gate.pending.shift()!(response(429, "", { "Retry-After": "2" }));
    await flush();
    const c = client.lookup("CCC");
    await flush();
    await advance(1999);
    expect(gate.fetchMock).toHaveBeenCalledTimes(2); // nothing new starts during the cooldown

    // B was not cancelled and completes normally.
    gate.pending.shift()!(response(200, partFixture));
    await expect(b).resolves.toBeDefined();

    await advance(1);
    expect(gate.fetchMock).toHaveBeenCalledTimes(4); // A's retry and C start together
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 2000]);
    gate.pending.shift()!(response(200, partFixture));
    gate.pending.shift()!(response(200, partFixture));
    await expect(Promise.all([a, c])).resolves.toHaveLength(2);
  });

  it("still pauses other callers after a final 429 that is not retried", async () => {
    let time = 0;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = vi.fn(
      (ms: number) => new Promise<void>((resolve) => timers.push({ at: time + ms, resolve })),
    );
    const advance = async (ms: number) => {
      time += ms;
      for (const t of timers.filter((t) => t.at <= time)) {
        timers.splice(timers.indexOf(t), 1);
        t.resolve();
      }
      await flush();
    };
    const gate = gatedFetch();
    const client = new FutureClient({
      apiKey: KEY,
      fetch: gate.fetchMock,
      sleep,
      now: () => time,
      maxRetries: 0,
    });

    const a = catchError(client.lookup("AAA"));
    await flush();
    gate.pending.shift()!(response(429, "", { "Retry-After": "3" }));
    expect((await a).status).toBe(429); // no retries left: A fails immediately

    const b = client.lookup("BBB");
    await flush();
    await advance(2999);
    expect(gate.fetchMock).toHaveBeenCalledTimes(1); // B waits out A's cooldown
    await advance(1);
    expect(gate.fetchMock).toHaveBeenCalledTimes(2);
    gate.pending.shift()!(response(200, partFixture));
    await expect(b).resolves.toBeDefined();
  });

  it("honors an HTTP-date Retry-After on retry", async () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const { client, sleep } = setup(
      [
        response(429, "", { "Retry-After": "Wed, 21 Oct 2015 07:28:03 GMT" }),
        response(200, partFixture),
      ],
      { now: () => now },
    );
    await client.lookup("ABC");
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([3000]);
  });

  it("paces request starts when minRequestIntervalMs is set", async () => {
    const { client, sleep } = setup([response(200, partFixture), response(200, partFixture)], {
      minRequestIntervalMs: 500,
      now: () => 0,
    });
    await client.lookup("ABC");
    await client.lookup("ABC");
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500]);
  });

  it("keeps the key out of rate-limit errors", async () => {
    const body = JSON.stringify({ message: `slow down ${KEY}` });
    const { client } = setup([response(429, body)], { maxRetries: 0 });
    const error = await catchError(client.lookup("ABC"));
    expect(error.status).toBe(429);
    expect(dump(error)).not.toContain(KEY);
  });
});
