import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_BASE_URL,
  MAX_CONCURRENCY_DEFAULT,
  MAX_OUTPUT_TOKENS_DEFAULT,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN,
  MIN_REQUEST_INTERVAL_DEFAULT_MS,
  defaultWorkspaceDir,
  loadConfig,
  loadMaxOutputTokens,
  loadWorkspaceDir,
  parseIntSetting,
  validateBaseUrl,
  WORKSPACE_FOLDER_NAME,
} from "../src/config.js";

describe("loadConfig", () => {
  it("reads the key and uses the default base URL", () => {
    expect(loadConfig({ FUTURE_API_KEY: "test-key" })).toEqual({
      apiKey: "test-key",
      baseUrl: DEFAULT_BASE_URL,
      maxConcurrency: 4,
      minRequestIntervalMs: 0,
    });
  });

  it("trims the key and honors FUTURE_API_BASE_URL", () => {
    expect(
      loadConfig({ FUTURE_API_KEY: "  test-key\n", FUTURE_API_BASE_URL: " https://example.test/ " }),
    ).toMatchObject({ apiKey: "test-key", baseUrl: "https://example.test" });
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

describe("rate limit settings", () => {
  const load = (extra: Record<string, string>) => loadConfig({ FUTURE_API_KEY: "test-key", ...extra });

  it("defaults to 4 in flight and no pacing", () => {
    expect(MAX_CONCURRENCY_DEFAULT).toBe(4);
    expect(MIN_REQUEST_INTERVAL_DEFAULT_MS).toBe(0);
    expect(load({})).toMatchObject({ maxConcurrency: 4, minRequestIntervalMs: 0 });
  });

  it("treats blank values as unset", () => {
    expect(
      load({ FUTURE_MAX_CONCURRENCY: "  ", FUTURE_MIN_REQUEST_INTERVAL_MS: "" }),
    ).toMatchObject({ maxConcurrency: 4, minRequestIntervalMs: 0 });
  });

  it.each([
    ["1", 1],
    ["32", 32],
    [" 8 ", 8],
    ["04", 4],
  ])("accepts FUTURE_MAX_CONCURRENCY=%j", (raw, expected) => {
    expect(load({ FUTURE_MAX_CONCURRENCY: raw }).maxConcurrency).toBe(expected);
  });

  it.each([
    ["0", 0],
    ["60000", 60_000],
    ["250", 250],
  ])("accepts FUTURE_MIN_REQUEST_INTERVAL_MS=%j", (raw, expected) => {
    expect(load({ FUTURE_MIN_REQUEST_INTERVAL_MS: raw }).minRequestIntervalMs).toBe(expected);
  });

  it.each(["0", "33", "-1", "1.5", "4e0", "abc", "0x4", "+4", "99999999999999999999"])(
    "rejects FUTURE_MAX_CONCURRENCY=%j",
    (raw) => {
      expect(() => load({ FUTURE_MAX_CONCURRENCY: raw })).toThrow(ConfigError);
      expect(() => load({ FUTURE_MAX_CONCURRENCY: raw })).toThrow(
        "FUTURE_MAX_CONCURRENCY must be an integer from 1 to 32.",
      );
    },
  );

  it.each(["-1", "60001", "2.5", "fast", "1_000"])(
    "rejects FUTURE_MIN_REQUEST_INTERVAL_MS=%j",
    (raw) => {
      expect(() => load({ FUTURE_MIN_REQUEST_INTERVAL_MS: raw })).toThrow(
        "FUTURE_MIN_REQUEST_INTERVAL_MS must be an integer from 0 to 60000.",
      );
    },
  );

  it("never echoes the raw value or the key", () => {
    try {
      load({ FUTURE_MAX_CONCURRENCY: "test-key" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String((error as Error).stack)).not.toContain("test-key");
    }
  });
});

describe("parseIntSetting", () => {
  it("returns the fallback for undefined", () => {
    expect(parseIntSetting(undefined, "X", 7, 0, 10)).toBe(7);
  });
  it("accepts both bounds and rejects just outside them", () => {
    expect(parseIntSetting("2", "X", 7, 2, 5)).toBe(2);
    expect(parseIntSetting("5", "X", 7, 2, 5)).toBe(5);
    expect(() => parseIntSetting("1", "X", 7, 2, 5)).toThrow("X must be an integer from 2 to 5.");
    expect(() => parseIntSetting("6", "X", 7, 2, 5)).toThrow(ConfigError);
  });
});

describe("defaultWorkspaceDir", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fe-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("uses ~/Documents/Future Electronics MCP when Documents exists", () => {
    mkdirSync(join(home, "Documents"));
    expect(defaultWorkspaceDir(home)).toBe(join(home, "Documents", WORKSPACE_FOLDER_NAME));
  });

  it("falls back to ~/Future Electronics MCP without a Documents folder", () => {
    expect(defaultWorkspaceDir(home)).toBe(join(home, WORKSPACE_FOLDER_NAME));
  });

  it("ignores a Documents entry that is a file, not a folder", () => {
    writeFileSync(join(home, "Documents"), "x");
    expect(defaultWorkspaceDir(home)).toBe(join(home, WORKSPACE_FOLDER_NAME));
  });

  it("creates nothing", () => {
    mkdirSync(join(home, "Documents"));
    defaultWorkspaceDir(home);
    loadWorkspaceDir({}, home);
    expect(existsSync(join(home, "Documents", WORKSPACE_FOLDER_NAME))).toBe(false);
    expect(existsSync(join(home, WORKSPACE_FOLDER_NAME))).toBe(false);
  });

  it("defaults to the user's home directory", () => {
    expect(defaultWorkspaceDir().endsWith(WORKSPACE_FOLDER_NAME)).toBe(true);
    expect(defaultWorkspaceDir().startsWith(homedir())).toBe(true);
  });
});

describe("loadWorkspaceDir", () => {
  const home = join(tmpdir(), "fe-no-such-home");
  const absolute = resolve(tmpdir(), "my-boms");

  it.each([
    {},
    { FUTURE_WORKSPACE_DIR: "" },
    { FUTURE_WORKSPACE_DIR: "   " },
    { FUTURE_WORKSPACE_DIR: "${user_config.workspace_dir}" },
    { FUTURE_WORKSPACE_DIR: " ${WORKSPACE} " },
  ])("uses the default when unset, empty, or an unsubstituted placeholder (%j)", (env) => {
    expect(loadWorkspaceDir(env, home)).toBe(join(home, WORKSPACE_FOLDER_NAME));
  });

  it("uses an absolute FUTURE_WORKSPACE_DIR, trimmed and normalized", () => {
    const value = ` ${absolute}${sep}x${sep}..${sep} `;
    expect(loadWorkspaceDir({ FUTURE_WORKSPACE_DIR: value }, home)).toBe(absolute);
  });

  it.each(["relative/boms", "./boms", "~/boms", "boms"])(
    "rejects a relative path (%j) without echoing it",
    (value) => {
      try {
        loadWorkspaceDir({ FUTURE_WORKSPACE_DIR: value }, home);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toMatch(/must be an absolute path/);
        expect((error as Error).message).not.toContain(value);
      }
    },
  );

  it("rejects a NUL byte", () => {
    expect(() => loadWorkspaceDir({ FUTURE_WORKSPACE_DIR: `${absolute}\0x` }, home)).toThrow(/NUL/);
  });

  it("defaults to process.env", () => {
    const saved = process.env.FUTURE_WORKSPACE_DIR;
    process.env.FUTURE_WORKSPACE_DIR = absolute;
    try {
      expect(loadWorkspaceDir()).toBe(absolute);
    } finally {
      if (saved === undefined) delete process.env.FUTURE_WORKSPACE_DIR;
      else process.env.FUTURE_WORKSPACE_DIR = saved;
    }
  });
});

describe("loadMaxOutputTokens", () => {
  it("defaults to 8000 when unset or blank", () => {
    expect(MAX_OUTPUT_TOKENS_DEFAULT).toBe(8000);
    expect(loadMaxOutputTokens({})).toBe(8000);
    expect(loadMaxOutputTokens({ FUTURE_MAX_OUTPUT_TOKENS: "  " })).toBe(8000);
  });

  it("does not need an API key", () => {
    expect(loadMaxOutputTokens({ FUTURE_MAX_OUTPUT_TOKENS: "5000" })).toBe(5000);
  });

  it("accepts the range bounds, trimmed", () => {
    expect(MAX_OUTPUT_TOKENS_MIN).toBe(1000);
    expect(MAX_OUTPUT_TOKENS_MAX).toBe(100000);
    expect(loadMaxOutputTokens({ FUTURE_MAX_OUTPUT_TOKENS: "1000" })).toBe(1000);
    expect(loadMaxOutputTokens({ FUTURE_MAX_OUTPUT_TOKENS: " 100000 " })).toBe(100000);
  });

  it.each(["999", "100001", "0", "-5", "8k", "1.5", "1e4", "abc"])(
    "rejects %j without echoing it",
    (value) => {
      try {
        loadMaxOutputTokens({ FUTURE_MAX_OUTPUT_TOKENS: value });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toBe(
          "FUTURE_MAX_OUTPUT_TOKENS must be an integer from 1000 to 100000.",
        );
      }
    },
  );

  it("defaults to process.env", () => {
    const saved = process.env.FUTURE_MAX_OUTPUT_TOKENS;
    process.env.FUTURE_MAX_OUTPUT_TOKENS = "2500";
    try {
      expect(loadMaxOutputTokens()).toBe(2500);
    } finally {
      if (saved === undefined) delete process.env.FUTURE_MAX_OUTPUT_TOKENS;
      else process.env.FUTURE_MAX_OUTPUT_TOKENS = saved;
    }
  });
});
