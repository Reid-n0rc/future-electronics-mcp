// Static checks on the Claude Code plugin manifest (.claude-plugin/plugin.json),
// the marketplace manifest (.claude-plugin/marketplace.json), and, if one is
// ever added, a root .mcp.json. No network, no key.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");

const pkg = JSON.parse(read("package.json")) as { version: string; main: string };
const pluginText = read(".claude-plugin/plugin.json");
const plugin = JSON.parse(pluginText) as {
  name: string;
  version: string;
  license?: string;
  repository?: string;
  homepage?: string;
  userConfig?: Record<string, UserConfigOption>;
  mcpServers: Record<string, ServerConfig>;
};
const marketplaceText = read(".claude-plugin/marketplace.json");
const marketplace = JSON.parse(marketplaceText) as {
  name: string;
  owner: { name: string };
  plugins: MarketplaceEntry[];
};

interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface UserConfigOption {
  type: string;
  title: string;
  description: string;
  required?: boolean;
  sensitive?: boolean;
  [key: string]: unknown;
}

interface MarketplaceEntry {
  name: string;
  source: { source: string; repo?: string; ref?: string } | string;
}

const REPO = "Reid-n0rc/future-electronics-mcp";
const BUNDLE = "server/future-electronics-mcp.mjs";
/** The plugin's key comes from its own install-time userConfig prompt. */
const PLUGIN_KEY_REFERENCE = "${user_config.future_api_key}";
/** The shell-environment reference, used by a root .mcp.json if one exists. */
const ENV_KEY_REFERENCE = "${FUTURE_API_KEY}";
/** The only allowed forms of an env value: `${VAR}` or `${user_config.name}`. */
const ENV_REFERENCE = /^\$\{(?:[A-Z_][A-Z0-9_]*|user_config\.[a-z_][a-z0-9_]*)\}$/;
/** Mirrors the .gitleaks.toml rule: a key name followed by a real-looking literal. */
const LITERAL_KEY =
  /(?:x-orbweaver-licensekey|future_api_key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/.]{8,})/gi;
/** Keys Claude Code accepts on a userConfig option; any other key fails loading. */
const USER_CONFIG_KEYS = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "sensitive",
  "min",
  "max",
  "options",
  "multiple",
]);

function checkServers(
  servers: Record<string, ServerConfig>,
  expected: { entry: string; keyReference: string },
) {
  const entries = Object.entries(servers);
  expect(entries.length).toBeGreaterThan(0);
  for (const [, server] of entries) {
    expect(server.command).toBe("node");
    expect(server.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/${expected.entry}`]);
    expect(server.env?.FUTURE_API_KEY).toBe(expected.keyReference);
    for (const value of Object.values(server.env ?? {})) {
      expect(value).toMatch(ENV_REFERENCE);
    }
  }
}

function checkNoLiteralKey(text: string) {
  expect([...text.matchAll(LITERAL_KEY)].map((m) => m[1])).toEqual([]);
  expect(text).not.toMatch(/x-orbweaver-licensekey/i);
}

describe(".claude-plugin/plugin.json", () => {
  it("has a name and a license matching package.json", () => {
    expect(plugin.name).toBe("future-electronics");
    expect(plugin.license).toBe("AGPL-3.0-or-later");
  });

  it("uses the package.json version (and the server's reported version)", () => {
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.version).toBe(SERVER_VERSION);
  });

  it("has repository and homepage links to the GitHub repo", () => {
    expect(plugin.repository).toBe(`https://github.com/${REPO}`);
    expect(plugin.homepage).toMatch(new RegExp(`^https://github\\.com/${REPO}(?:#|$)`));
  });

  it("runs the committed bundle via ${CLAUDE_PLUGIN_ROOT}", () => {
    checkServers(plugin.mcpServers, { entry: BUNDLE, keyReference: PLUGIN_KEY_REFERENCE });
    expect(existsSync(root + BUNDLE)).toBe(true);
  });

  it("passes the key from the install prompt, exactly ${user_config.future_api_key}", () => {
    const env = plugin.mcpServers["future-electronics"]?.env;
    expect(Object.keys(env ?? {})).toEqual(["FUTURE_API_KEY"]);
    expect(env?.FUTURE_API_KEY).toBe(PLUGIN_KEY_REFERENCE);
  });

  it("asks for the key at install as a required, sensitive string", () => {
    const option = plugin.userConfig?.future_api_key;
    expect(option).toBeDefined();
    expect(option?.type).toBe("string");
    expect(option?.required).toBe(true);
    expect(option?.sensitive).toBe(true);
    expect(option?.title).toEqual(expect.any(String));
    expect(option?.title.length).toBeGreaterThan(0);
    expect(option?.description).toEqual(expect.any(String));
    expect(option?.description.length).toBeGreaterThan(0);
    // A sensitive option must never ship a default value.
    expect(option).not.toHaveProperty("default");
  });

  it("uses only userConfig keys that Claude Code accepts", () => {
    for (const option of Object.values(plugin.userConfig ?? {})) {
      for (const key of Object.keys(option)) {
        expect(USER_CONFIG_KEYS).toContain(key);
      }
    }
  });

  it("references only userConfig options that are declared", () => {
    const declared = Object.keys(plugin.userConfig ?? {});
    const used = [...pluginText.matchAll(/\$\{user_config\.([^}]+)\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(declared).toContain(name);
  });

  it("contains no literal key value", () => {
    checkNoLiteralKey(pluginText);
    expect(pluginText).toContain(PLUGIN_KEY_REFERENCE);
  });
});

describe(".claude-plugin/marketplace.json", () => {
  it("has the required name, owner, and plugins fields", () => {
    expect(marketplace.name).toBe("future-electronics-mcp");
    expect(marketplace.owner.name).toBe("Reid Crowe");
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins).toHaveLength(1);
  });

  it("lists the plugin under the same name as plugin.json", () => {
    const entry = marketplace.plugins[0];
    expect(entry?.name).toBe(plugin.name);
    // The install id documented in the README.
    expect(`${entry?.name}@${marketplace.name}`).toBe("future-electronics@future-electronics-mcp");
  });

  it("fetches the plugin from this GitHub repo, pinned to master", () => {
    expect(marketplace.plugins[0]?.source).toEqual({
      source: "github",
      repo: REPO,
      ref: "master",
    });
  });

  it("contains no literal key value", () => {
    checkNoLiteralKey(marketplaceText);
  });
});

describe(".mcp.json (optional)", () => {
  const path = ".mcp.json";
  it.skipIf(!existsSync(root + path))("follows the same rules as plugin.json", () => {
    const text = read(path);
    checkServers((JSON.parse(text) as { mcpServers: Record<string, ServerConfig> }).mcpServers, {
      entry: pkg.main,
      keyReference: ENV_KEY_REFERENCE,
    });
    checkNoLiteralKey(text);
  });
});

describe("literal-key detector", () => {
  it("flags a real-looking literal", () => {
    // Built at runtime so no key-shaped literal appears in the source.
    const fake = `"FUTURE_API_KEY": "${"a1".repeat(8)}"`;
    expect(() => checkNoLiteralKey(fake)).toThrow();
  });

  it("flags a literal assigned to the userConfig option name", () => {
    const fake = `"future_api_key": "${"b2".repeat(8)}"`;
    expect(() => checkNoLiteralKey(fake)).toThrow();
  });

  it("allows the ${FUTURE_API_KEY} and ${user_config.future_api_key} references", () => {
    expect(() => checkNoLiteralKey(`"FUTURE_API_KEY": "${ENV_KEY_REFERENCE}"`)).not.toThrow();
    expect(() => checkNoLiteralKey(`"FUTURE_API_KEY": "${PLUGIN_KEY_REFERENCE}"`)).not.toThrow();
    expect(() => checkNoLiteralKey(`"future_api_key": {`)).not.toThrow();
  });

  it("rejects env values that are not a reference", () => {
    expect("plain-value").not.toMatch(ENV_REFERENCE);
    expect("${user_config.Bad-Name}").not.toMatch(ENV_REFERENCE);
    expect(PLUGIN_KEY_REFERENCE).toMatch(ENV_REFERENCE);
    expect(ENV_KEY_REFERENCE).toMatch(ENV_REFERENCE);
  });
});
