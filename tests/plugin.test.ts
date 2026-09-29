// Static checks on the Claude Code plugin manifest (.claude-plugin/plugin.json)
// and, if one is ever added, a root .mcp.json. No network, no key.

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
  mcpServers: Record<string, ServerConfig>;
};

interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const KEY_REFERENCE = "${FUTURE_API_KEY}";
/** Any `${VAR}` reference, the only allowed form of an env value. */
const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;
/** Mirrors the .gitleaks.toml rule: a key name followed by a real-looking literal. */
const LITERAL_KEY =
  /(?:x-orbweaver-licensekey|future_api_key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/.]{8,})/gi;

function checkServers(servers: Record<string, ServerConfig>) {
  const entries = Object.entries(servers);
  expect(entries.length).toBeGreaterThan(0);
  for (const [, server] of entries) {
    expect(server.command).toBe("node");
    expect(server.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/${pkg.main}`]);
    expect(server.env?.FUTURE_API_KEY).toBe(KEY_REFERENCE);
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

  it("runs the built entry point via ${CLAUDE_PLUGIN_ROOT} and passes the key through", () => {
    checkServers(plugin.mcpServers);
    expect(pkg.main).toBe("dist/index.js");
  });

  it("contains no literal key value", () => {
    checkNoLiteralKey(pluginText);
    expect(pluginText).toContain(KEY_REFERENCE);
  });
});

describe(".mcp.json (optional)", () => {
  const path = ".mcp.json";
  it.skipIf(!existsSync(root + path))("follows the same rules as plugin.json", () => {
    const text = read(path);
    checkServers((JSON.parse(text) as { mcpServers: Record<string, ServerConfig> }).mcpServers);
    checkNoLiteralKey(text);
  });
});

describe("literal-key detector", () => {
  it("flags a real-looking literal", () => {
    // Built at runtime so no key-shaped literal appears in the source.
    const fake = `"FUTURE_API_KEY": "${"a1".repeat(8)}"`;
    expect(() => checkNoLiteralKey(fake)).toThrow();
  });

  it("allows the ${FUTURE_API_KEY} reference", () => {
    expect(() => checkNoLiteralKey(`"FUTURE_API_KEY": "${KEY_REFERENCE}"`)).not.toThrow();
  });
});
