// Static checks on the Claude Desktop bundle manifest (mcpb/manifest.json,
// issue #34). Spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
// No network, no key.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");

interface Manifest {
  manifest_version: string;
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: { name: string };
  license?: string;
  repository?: { type: string; url: string };
  server: {
    type: string;
    entry_point: string;
    mcp_config: { command: string; args: string[]; env?: Record<string, string> };
  };
  tools?: Array<{ name: string; description: string }>;
  compatibility?: { runtimes?: Record<string, string> };
  user_config?: Record<
    string,
    {
      type: string;
      title: string;
      description: string;
      sensitive?: boolean;
      required?: boolean;
      default?: string;
    }
  >;
}

const pkg = JSON.parse(read("package.json")) as { version: string; license: string };
const manifestText = read("mcpb/manifest.json");
const manifest = JSON.parse(manifestText) as Manifest;

const KEY_REFERENCE = "${user_config.future_api_key}";
/** Mirrors the .gitleaks.toml rule: a key name followed by a real-looking literal. */
const LITERAL_KEY =
  /(?:x-orbweaver-licensekey|future_api_key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/.]{8,})/gi;

function literalKeys(text: string): string[] {
  return [...text.matchAll(LITERAL_KEY)].map((m) => m[1]);
}

describe("mcpb/manifest.json: metadata", () => {
  it("uses manifest_version 0.3 and has every required field", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("future-electronics-mcp");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.author.name.length).toBeGreaterThan(0);
    expect(manifest.display_name).toBeTruthy();
  });

  it("uses the package.json version (and the server's reported version)", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toBe(SERVER_VERSION);
  });

  it("has the package.json license and the repo URL", () => {
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.license).toBe("AGPL-3.0-or-later");
    expect(manifest.repository?.url).toBe("https://github.com/Reid-n0rc/future-electronics-mcp.git");
  });

  it("requires Node >=18, the target of the server bundle", () => {
    expect(manifest.compatibility?.runtimes).toEqual({ node: ">=18" });
    expect(read("scripts/bundle.mjs")).toContain('target: "node18"');
  });
});

describe("mcpb/manifest.json: server", () => {
  it("runs the committed self-contained bundle with node", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("server/future-electronics-mcp.mjs");
    expect(existsSync(root + manifest.server.entry_point)).toBe(true);
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual([`\${__dirname}/${manifest.server.entry_point}`]);
  });

  it("passes only the user-configured key and workspace folder through the environment", () => {
    expect(Object.entries(manifest.server.mcp_config.env ?? {})).toEqual([
      ["FUTURE_API_KEY", KEY_REFERENCE],
      ["FUTURE_WORKSPACE_DIR", "${user_config.workspace_dir}"],
    ]);
  });
});

describe("mcpb/manifest.json: user_config", () => {
  it("asks for an optional workspace directory, defaulting under Documents", () => {
    const dir = manifest.user_config!.workspace_dir;
    expect(dir.type).toBe("directory");
    expect(dir.required).toBe(false);
    expect(dir.sensitive).toBeUndefined();
    expect(dir.title.length).toBeGreaterThan(0);
    expect(dir.description.length).toBeGreaterThan(0);
    // ${DOCUMENTS} is a documented MCPB default-value variable.
    expect(dir.default).toBe("${DOCUMENTS}/Future Electronics MCP");
    expect(dir).not.toHaveProperty("multiple");
  });

  it("asks for the key as a required, sensitive string", () => {
    expect(Object.keys(manifest.user_config ?? {})).toEqual(["future_api_key", "workspace_dir"]);
    const key = manifest.user_config!.future_api_key;
    expect(key.type).toBe("string");
    expect(key.sensitive).toBe(true);
    expect(key.required).toBe(true);
    expect(key.title.length).toBeGreaterThan(0);
    expect(key.description.length).toBeGreaterThan(0);
    expect(key).not.toHaveProperty("default");
  });

  it("references every user_config entry it defines, and only those", () => {
    const referenced = [...manifestText.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    expect(new Set(referenced)).toEqual(new Set(Object.keys(manifest.user_config ?? {})));
  });
});

describe("mcpb/manifest.json: tools", () => {
  it("lists both tools the server registers, with short descriptions", () => {
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["future_lookup_part", "future_lookup_parts"]);
    const bundle = read(manifest.server.entry_point);
    for (const tool of manifest.tools ?? []) {
      expect(bundle).toContain(`"${tool.name}"`);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.description.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("mcpb/manifest.json: secrets", () => {
  it("contains no literal key value and never names the upstream header", () => {
    expect(literalKeys(manifestText)).toEqual([]);
    expect(manifestText).not.toMatch(/x-orbweaver-licensekey/i);
  });

  it("the detector flags a real-looking literal", () => {
    // Built at runtime so no key-shaped literal appears in the source.
    const fake = `"future_api_key": "${"a1".repeat(8)}"`;
    expect(literalKeys(fake)).toHaveLength(1);
  });

  it("the detector allows the ${user_config.future_api_key} reference", () => {
    expect(literalKeys(`"FUTURE_API_KEY": "${KEY_REFERENCE}"`)).toEqual([]);
  });
});

describe(".gitignore", () => {
  it("ignores the pack output so a .mcpb is never committed", () => {
    const lines = read(".gitignore").split("\n");
    expect(lines).toContain("build/");
    expect(lines).toContain("*.mcpb");
  });
});
