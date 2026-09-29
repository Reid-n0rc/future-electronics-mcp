import { describe, expect, it } from "vitest";
import { FutureApiError, FutureClient } from "../../src/client.js";
import { ConfigError } from "../../src/config.js";
import { errorResult, jsonResult, lazyClientProvider } from "../../src/tools/common.js";

describe("lazyClientProvider", () => {
  it("does not read the environment until first called", () => {
    expect(() => lazyClientProvider({})).not.toThrow();
  });

  it("throws the missing-key ConfigError when FUTURE_API_KEY is unset", () => {
    const get = lazyClientProvider({});
    expect(get).toThrow(ConfigError);
    expect(get).toThrow(/^FUTURE_API_KEY is not set/);
  });

  it("throws ConfigError for a blank key", () => {
    expect(lazyClientProvider({ FUTURE_API_KEY: "   " })).toThrow(ConfigError);
  });

  it("throws ConfigError for a non-https base URL", () => {
    const get = lazyClientProvider({ FUTURE_API_KEY: "test-key", FUTURE_API_BASE_URL: "http://x" });
    expect(get).toThrow(/https/);
  });

  it("creates one FutureClient and reuses it", () => {
    const get = lazyClientProvider({ FUTURE_API_KEY: "test-key" });
    const a = get();
    expect(a).toBeInstanceOf(FutureClient);
    expect(get()).toBe(a);
  });

  it("retries creation after a failure (nothing is cached on error)", () => {
    const env: NodeJS.ProcessEnv = {};
    const get = lazyClientProvider(env);
    expect(get).toThrow(ConfigError);
    env.FUTURE_API_KEY = "test-key";
    expect(get()).toBeInstanceOf(FutureClient);
  });

  it("gives separate providers separate clients", () => {
    const env = { FUTURE_API_KEY: "test-key" };
    expect(lazyClientProvider(env)()).not.toBe(lazyClientProvider(env)());
  });
});

describe("jsonResult", () => {
  it("wraps a value as pretty-printed JSON text", () => {
    const value = { a: 1, b: ["x"] };
    const result = jsonResult(value);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(value, null, 2) }]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(value);
  });

  it("handles primitives and empty values", () => {
    expect((jsonResult(null).content[0] as { text: string }).text).toBe("null");
    expect((jsonResult([]).content[0] as { text: string }).text).toBe("[]");
    expect((jsonResult("s").content[0] as { text: string }).text).toBe('"s"');
  });
});

describe("errorResult", () => {
  it("passes a FutureApiError message through", () => {
    const result = errorResult(new FutureApiError("Invalid API key.", { code: "http", status: 401 }));
    expect(result).toEqual({ content: [{ type: "text", text: "Invalid API key." }], isError: true });
  });

  it("passes a ConfigError message through", () => {
    const result = errorResult(new ConfigError("FUTURE_API_KEY is not set."));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "FUTURE_API_KEY is not set." }]);
  });

  it.each([new Error("secret test-key"), new TypeError("x"), "string", 42, null, undefined])(
    "uses a generic message for %s",
    (error) => {
      const result = errorResult(error);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Unexpected error while calling the Future Electronics API." },
      ]);
    },
  );
});
