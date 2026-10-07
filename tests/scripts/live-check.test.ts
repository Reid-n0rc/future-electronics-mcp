// Tests for scripts/live-check.ts. Fetch is always mocked (or asserted
// unused); the real API is never contacted.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_CHECK_PART, runLiveCheck } from "../../scripts/live-check.js";
import { PRICING_DISCLAIMER } from "../../src/format.js";

const KEY = "test-key";
const partFixture = readFileSync(new URL("../fixtures/part-lookup.json", import.meta.url), "utf8");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

function mockFetch(status: number, body: string) {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runLiveCheck: missing key", () => {
  it.each([{}, { FUTURE_API_KEY: "" }, { FUTURE_API_KEY: "   " }])(
    "exits 1 with a clear message and no network call (%j)",
    async (env) => {
      const globalFetch = vi.fn();
      vi.stubGlobal("fetch", globalFetch);
      const injected = vi.fn<typeof fetch>();
      const { out, err, io } = capture();

      await expect(runLiveCheck({ env, fetch: injected, ...io })).resolves.toBe(1);

      expect(globalFetch).not.toHaveBeenCalled();
      expect(injected).not.toHaveBeenCalled();
      expect(out).toEqual([]);
      expect(err.join("\n")).toMatch(/FUTURE_API_KEY is not set/);
      expect(err.join("\n")).toMatch(/npm run live-check/);
    },
  );

  it("exits 1 for an invalid FUTURE_API_BASE_URL before any network call", async () => {
    const injected = vi.fn<typeof fetch>();
    const { err, io } = capture();
    const env = { FUTURE_API_KEY: KEY, FUTURE_API_BASE_URL: "http://insecure.test" };
    await expect(runLiveCheck({ env, fetch: injected, ...io })).resolves.toBe(1);
    expect(injected).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/must use https/);
    expect(err.join("\n")).not.toContain(KEY);
  });
});

describe("runLiveCheck: with a key (mocked fetch)", () => {
  it("looks up the live-check part exactly and prints the summary", async () => {
    const fetchMock = mockFetch(200, partFixture);
    const { out, err, io } = capture();

    await expect(runLiveCheck({ env: { FUTURE_API_KEY: KEY }, fetch: fetchMock, ...io })).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("part_number")).toBe(LIVE_CHECK_PART);
    expect(url.searchParams.get("lookup_type")).toBe("exact");
    expect(err).toEqual([]);
    expect(out[0]).toBe(`live-check: ${LIVE_CHECK_PART} OK`);
    const printed = JSON.parse(out[1]!);
    expect(printed.note).toBe(PRICING_DISCLAIMER);
    expect(printed.total_offers).toBe(2);
    expect(printed.offers[0].mpn).toBe("TEST-1234");
  });

  it("never prints the key", async () => {
    const fetchMock = mockFetch(200, partFixture);
    const { out, err, io } = capture();
    await runLiveCheck({ env: { FUTURE_API_KEY: KEY }, fetch: fetchMock, ...io });
    expect([...out, ...err].join("\n")).not.toContain(KEY);
  });

  it("redacts the key if the upstream response echoes it", async () => {
    const echoed = JSON.parse(partFixture);
    echoed.lookup_value = KEY;
    const { out, io } = capture();
    const code = await runLiveCheck({
      env: { FUTURE_API_KEY: KEY },
      fetch: mockFetch(200, JSON.stringify(echoed)),
      ...io,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain(KEY);
    expect(out.join("\n")).toContain("[REDACTED]");
  });

  it("uses the global fetch when none is injected", async () => {
    const globalFetch = mockFetch(200, partFixture);
    vi.stubGlobal("fetch", globalFetch);
    const { io } = capture();
    await expect(runLiveCheck({ env: { FUTURE_API_KEY: KEY }, ...io })).resolves.toBe(0);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, /Invalid API key/],
    [402, /Purchase required/],
    [403, /Not authorized/],
    [406, /API key expired/],
  ])("exits 1 with the mapped message on HTTP %i", async (status, message) => {
    const { out, err, io } = capture();
    const code = await runLiveCheck({
      env: { FUTURE_API_KEY: KEY },
      fetch: mockFetch(status, "{}"),
      ...io,
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(new RegExp(`${LIVE_CHECK_PART} FAILED`));
    expect(err.join("\n")).toMatch(message);
    expect(err.join("\n")).not.toContain(KEY);
  });

  it("exits 1 on a network error without leaking the key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error(`connect failed for ${KEY}`);
    });
    const { err, io } = capture();
    const code = await runLiveCheck({ env: { FUTURE_API_KEY: KEY }, fetch: fetchMock, ...io });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Network error/);
    expect(err.join("\n")).not.toContain(KEY);
  });

  it("exits 1 on an invalid (non-JSON) response body", async () => {
    const { err, io } = capture();
    const code = await runLiveCheck({
      env: { FUTURE_API_KEY: KEY },
      fetch: mockFetch(200, "not json"),
      ...io,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/FAILED/);
  });
});

describe("runLiveCheck: defaults", () => {
  it("writes to console.error and reads process.env when no options are given", async () => {
    vi.stubEnv("FUTURE_API_KEY", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runLiveCheck()).resolves.toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/FUTURE_API_KEY is not set/));
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not run the check on import", () => {
    // Importing the module above ran nothing: no exit code was set.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
