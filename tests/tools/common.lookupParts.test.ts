import { describe, expect, it } from "vitest";
import { FutureApiError, FutureClient } from "../../src/client.js";
import { ConfigError } from "../../src/config.js";
import { errorResult, jsonResult, lazyClientProvider } from "../../src/tools/common.js";

describe("lazyClientProvider", () => {
  it("does not read the environment until first use", () => {
    expect(() => lazyClientProvider({})).not.toThrow();
  });

  it("creates a FutureClient on first call and reuses it", () => {
    const get = lazyClientProvider({ FUTURE_API_KEY: "test-key" });
    const a = get();
    expect(a).toBeInstanceOf(FutureClient);
    expect(get()).toBe(a);
  });

  it("returns separate clients for separate providers", () => {
    const env = { FUTURE_API_KEY: "test-key" };
    expect(lazyClientProvider(env)()).not.toBe(lazyClientProvider(env)());
  });

  it("throws ConfigError when the key is missing, and retries on the next call", () => {
    const env: NodeJS.ProcessEnv = {};
    const get = lazyClientProvider(env);
    expect(() => get()).toThrow(ConfigError);
    env.FUTURE_API_KEY = "test-key";
    expect(get()).toBeInstanceOf(FutureClient);
  });

  it("throws ConfigError for an invalid base URL without echoing the key", () => {
    const get = lazyClientProvider({
      FUTURE_API_KEY: "test-key",
      FUTURE_API_BASE_URL: "http://example.com",
    });
    try {
      get();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain("test-key");
    }
  });
});

describe("jsonResult", () => {
  it("wraps a value as pretty-printed JSON text", () => {
    const res = jsonResult({ a: 1, b: [2] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify({ a: 1, b: [2] }, null, 2) }]);
  });

  it("handles primitives and null", () => {
    expect((jsonResult(null).content[0] as { text: string }).text).toBe("null");
    expect((jsonResult("x").content[0] as { text: string }).text).toBe('"x"');
  });
});

describe("errorResult", () => {
  const text = (e: unknown) => (errorResult(e).content[0] as { text: string }).text;

  it("passes FutureApiError messages through", () => {
    const res = errorResult(new FutureApiError("Rate limited.", { code: "http", status: 429 }));
    expect(res.isError).toBe(true);
    expect(text(new FutureApiError("Rate limited.", { code: "http" }))).toBe("Rate limited.");
  });

  it("passes ConfigError messages through", () => {
    expect(text(new ConfigError("FUTURE_API_KEY is not set."))).toBe("FUTURE_API_KEY is not set.");
  });

  it("hides the message of any other error", () => {
    const generic = "Unexpected error while calling the Future Electronics API.";
    expect(text(new Error("leak test-key"))).toBe(generic);
    expect(text("string thrown")).toBe(generic);
    expect(text(undefined)).toBe(generic);
    expect(errorResult(new TypeError("x")).isError).toBe(true);
  });
});
