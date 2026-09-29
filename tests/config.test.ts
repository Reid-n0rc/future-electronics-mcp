import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_BASE_URL, loadConfig, validateBaseUrl } from "../src/config.js";

describe("loadConfig", () => {
  it("reads the key and uses the default base URL", () => {
    expect(loadConfig({ FUTURE_API_KEY: "test-key" })).toEqual({
      apiKey: "test-key",
      baseUrl: DEFAULT_BASE_URL,
    });
  });

  it("trims the key and honors FUTURE_API_BASE_URL", () => {
    expect(
      loadConfig({ FUTURE_API_KEY: "  test-key\n", FUTURE_API_BASE_URL: " https://example.test/ " }),
    ).toEqual({ apiKey: "test-key", baseUrl: "https://example.test" });
  });

  it("falls back to the default when FUTURE_API_BASE_URL is blank", () => {
    expect(loadConfig({ FUTURE_API_KEY: "test-key", FUTURE_API_BASE_URL: "   " }).baseUrl).toBe(
      DEFAULT_BASE_URL,
    );
  });

  it.each([{}, { FUTURE_API_KEY: "" }, { FUTURE_API_KEY: "   " }])(
    "throws a clear ConfigError when the key is missing (%j)",
    (env) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(/FUTURE_API_KEY is not set/);
    },
  );

  it("rejects an http base URL without leaking the key", () => {
    try {
      loadConfig({ FUTURE_API_KEY: "test-key", FUTURE_API_BASE_URL: "http://example.test" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/https/);
      expect(String((error as Error).stack)).not.toContain("test-key");
    }
  });

  it("defaults to process.env", () => {
    const saved = process.env.FUTURE_API_KEY;
    process.env.FUTURE_API_KEY = "test-key";
    try {
      expect(loadConfig().apiKey).toBe("test-key");
    } finally {
      if (saved === undefined) delete process.env.FUTURE_API_KEY;
      else process.env.FUTURE_API_KEY = saved;
    }
  });
});

describe("validateBaseUrl", () => {
  it("accepts https and strips trailing slashes", () => {
    expect(validateBaseUrl("https://example.test")).toBe("https://example.test");
    expect(validateBaseUrl("https://example.test/prefix//")).toBe("https://example.test/prefix");
  });

  it.each([
    ["http://example.test", /https/],
    ["ftp://example.test", /https/],
    ["not a url", /not a valid URL/],
    ["", /non-empty/],
    [42, /non-empty/],
    [undefined, /non-empty/],
    ["https://user:test-key@example.test", /credentials/],
    ["https://example.test?x=1", /query/],
    ["https://example.test#frag", /fragment/],
  ])("rejects %j", (value, pattern) => {
    expect(() => validateBaseUrl(value)).toThrow(ConfigError);
    expect(() => validateBaseUrl(value)).toThrow(pattern);
  });

  it("never echoes the URL (which could carry a secret)", () => {
    try {
      validateBaseUrl("https://user:test-key@example.test");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("test-key");
    }
  });
});
