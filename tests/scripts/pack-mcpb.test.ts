// Tests for scripts/pack-mcpb.mjs (issue #34). The mcpb CLI is always replaced
// by a fake, so no npx call and no network. Each test uses a throwaway repo
// root in a temp dir.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCPB_CLI,
  OUTPUT,
  STAGED_FILES,
  checkTag,
  main,
  packMcpb,
  readVersions,
  versionFromTag,
} from "../../scripts/pack-mcpb.mjs";

let root: string;

function writeRepo({ manifestVersion = "1.2.3", pkgVersion = "1.2.3" } = {}) {
  mkdirSync(join(root, "mcpb"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "mcpb/manifest.json"), JSON.stringify({ name: "x", version: manifestVersion }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: pkgVersion }));
  writeFileSync(join(root, "server/future-electronics-mcp.mjs"), "// bundle\n");
  writeFileSync(join(root, "LICENSE"), "license text\n");
  writeFileSync(join(root, "README.md"), "# readme\n");
  // Files that must never reach the .mcpb.
  writeFileSync(join(root, ".env"), "FUTURE_API_KEY=test-key\n");
  mkdirSync(join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(join(root, "node_modules/dep/index.js"), "\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "\n");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split("\\").join("/"))
    .sort();
}

/** Fake mcpb CLI: records each call and the staged files, and writes a dummy output on pack. */
function fakeCli() {
  const calls: string[][] = [];
  const staged: string[][] = [];
  const run = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === "pack") {
      staged.push(listFiles(args[1]));
      writeFileSync(args[2], "zip");
    }
  });
  return { run, calls, staged };
}

function quietLog() {
  return { log: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fe-pack-mcpb-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("constants", () => {
  it("pins an exact mcpb CLI version", () => {
    expect(MCPB_CLI).toMatch(/^@anthropic-ai\/mcpb@\d+\.\d+\.\d+$/);
  });

  it("writes to build/ and stages only the manifest, bundle, LICENSE and README", () => {
    expect(OUTPUT).toBe("build/future-electronics-mcp.mcpb");
    expect(STAGED_FILES.map(([, to]) => to).sort()).toEqual([
      "LICENSE",
      "README.md",
      "manifest.json",
      "server/future-electronics-mcp.mjs",
    ]);
  });

  it("stages files that exist in the real repo", () => {
    const repo = new URL("../../", import.meta.url);
    for (const [from] of STAGED_FILES) expect(existsSync(new URL(from, repo))).toBe(true);
  });
});

describe("versionFromTag", () => {
  it.each([
    ["v1.2.3", "1.2.3"],
    ["1.2.3", "1.2.3"],
    ["v0.1.0", "0.1.0"],
    ["v2.0.0-rc.1", "2.0.0-rc.1"],
    [" v1.0.0 ", "1.0.0"],
  ])("maps %j to %j", (tag, version) => {
    expect(versionFromTag(tag)).toBe(version);
  });

  it.each(["", "v", "v1.2", "release-1.2.3", "vv1.2.3", "1.2.3.4", "refs/tags/v1.2.3"])(
    "rejects %j",
    (tag) => {
      expect(() => versionFromTag(tag)).toThrow(/is not a version like v1\.2\.3/);
    },
  );

  it.each([undefined, null, 123])("rejects non-string %j", (tag) => {
    expect(() => versionFromTag(tag as unknown as string)).toThrow(/is not a version/);
  });
});

describe("readVersions", () => {
  it("returns both versions when they match", async () => {
    writeRepo();
    await expect(readVersions(root)).resolves.toEqual({ manifest: "1.2.3", pkg: "1.2.3" });
  });

  it("throws when the manifest and package.json versions differ", async () => {
    writeRepo({ manifestVersion: "1.2.3", pkgVersion: "1.2.4" });
    await expect(readVersions(root)).rejects.toThrow(
      "mcpb/manifest.json version 1.2.3 does not match package.json version 1.2.4",
    );
  });

  it("throws when the manifest is missing", async () => {
    await expect(readVersions(root)).rejects.toThrow(/ENOENT/);
  });

  it("throws when the manifest is not JSON", async () => {
    writeRepo();
    writeFileSync(join(root, "mcpb/manifest.json"), "{ nope");
    await expect(readVersions(root)).rejects.toThrow(SyntaxError);
  });

  it("matches the real repo", async () => {
    const real = await readVersions();
    expect(real.manifest).toBe(real.pkg);
  });
});

describe("checkTag", () => {
  it("passes when the tag equals the manifest version", async () => {
    writeRepo();
    await expect(checkTag("v1.2.3", root)).resolves.toBe("1.2.3");
  });

  it("fails when the tag differs from the manifest version", async () => {
    writeRepo();
    await expect(checkTag("v1.2.4", root)).rejects.toThrow(
      "mcpb/manifest.json version 1.2.3 does not match release tag v1.2.4",
    );
  });

  it("fails on a malformed tag before reading any file", async () => {
    await expect(checkTag("latest", root)).rejects.toThrow(/is not a version/);
  });

  it("fails when package.json disagrees even if the tag matches the manifest", async () => {
    writeRepo({ pkgVersion: "9.9.9" });
    await expect(checkTag("v1.2.3", root)).rejects.toThrow(/does not match package\.json/);
  });
});

describe("packMcpb", () => {
  it("validates, then packs a staging dir holding only the four bundle files", async () => {
    writeRepo();
    const cli = fakeCli();
    const output = await packMcpb({ repoRoot: root, runMcpb: cli.run });

    expect(output).toBe(join(root, OUTPUT));
    expect(readFileSync(output, "utf8")).toBe("zip");
    expect(cli.calls.map((c) => c[0])).toEqual(["validate", "pack"]);
    expect(cli.calls[0][1]).toBe(join(cli.calls[1][1], "manifest.json"));
    expect(cli.calls[1][2]).toBe(output);
    expect(cli.staged[0]).toEqual([
      "LICENSE",
      "README.md",
      "manifest.json",
      "server/future-electronics-mcp.mjs",
    ]);
  });

  it("stages outside the repo and removes the staging dir afterwards", async () => {
    writeRepo();
    const cli = fakeCli();
    await packMcpb({ repoRoot: root, runMcpb: cli.run });
    const stage = cli.calls[1][1];
    expect(relative(root, stage).startsWith("..")).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });

  it("copies the manifest and bundle byte for byte", async () => {
    writeRepo();
    let manifest = "";
    let bundle = "";
    await packMcpb({
      repoRoot: root,
      runMcpb: (args: string[]) => {
        if (args[0] !== "pack") return;
        manifest = readFileSync(join(args[1], "manifest.json"), "utf8");
        bundle = readFileSync(join(args[1], "server/future-electronics-mcp.mjs"), "utf8");
        writeFileSync(args[2], "zip");
      },
    });
    expect(manifest).toBe(readFileSync(join(root, "mcpb/manifest.json"), "utf8"));
    expect(bundle).toBe("// bundle\n");
  });

  it("replaces a stale output file", async () => {
    writeRepo();
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, OUTPUT), "stale");
    let sawStale = true;
    await packMcpb({
      repoRoot: root,
      runMcpb: (args: string[]) => {
        if (args[0] === "pack") {
          sawStale = existsSync(args[2]);
          writeFileSync(args[2], "fresh");
        }
      },
    });
    expect(sawStale).toBe(false);
    expect(readFileSync(join(root, OUTPUT), "utf8")).toBe("fresh");
  });

  it("refuses to pack when the versions differ, without calling the CLI", async () => {
    writeRepo({ pkgVersion: "2.0.0" });
    const cli = fakeCli();
    await expect(packMcpb({ repoRoot: root, runMcpb: cli.run })).rejects.toThrow(/does not match/);
    expect(cli.run).not.toHaveBeenCalled();
  });

  it("fails when a staged file is missing, without calling the CLI", async () => {
    writeRepo();
    rmSync(join(root, "LICENSE"));
    const cli = fakeCli();
    await expect(packMcpb({ repoRoot: root, runMcpb: cli.run })).rejects.toThrow(/ENOENT/);
    expect(cli.run).not.toHaveBeenCalled();
  });

  it("propagates a validate failure and does not pack", async () => {
    writeRepo();
    const run = vi.fn((args: string[]) => {
      if (args[0] === "validate") throw new Error("invalid manifest");
    });
    await expect(packMcpb({ repoRoot: root, runMcpb: run })).rejects.toThrow("invalid manifest");
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, OUTPUT))).toBe(false);
  });
});

describe("main", () => {
  it("packs and returns 0", async () => {
    writeRepo();
    const cli = fakeCli();
    const log = quietLog();
    await expect(main([], { repoRoot: root, runMcpb: cli.run, log })).resolves.toBe(0);
    expect(log.log).toHaveBeenCalledWith(`Wrote ${join(root, OUTPUT)}`);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("--check-tag returns 0 on a match without packing", async () => {
    writeRepo();
    const cli = fakeCli();
    const log = quietLog();
    await expect(main(["--check-tag", "v1.2.3"], { repoRoot: root, runMcpb: cli.run, log })).resolves.toBe(0);
    expect(cli.run).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledWith("mcpb/manifest.json version 1.2.3 matches release tag v1.2.3");
  });

  it("--check-tag returns 1 on a mismatch", async () => {
    writeRepo();
    const log = quietLog();
    await expect(main(["--check-tag", "v0.0.1"], { repoRoot: root, runMcpb: fakeCli().run, log })).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "pack-mcpb: mcpb/manifest.json version 1.2.3 does not match release tag v0.0.1",
    );
  });

  it("--check-tag without a tag returns 1", async () => {
    writeRepo();
    const log = quietLog();
    await expect(main(["--check-tag"], { repoRoot: root, runMcpb: fakeCli().run, log })).resolves.toBe(1);
    expect(log.error.mock.calls[0][0]).toMatch(/is not a version/);
  });

  it("rejects unknown arguments", async () => {
    writeRepo();
    const cli = fakeCli();
    const log = quietLog();
    await expect(main(["--sign"], { repoRoot: root, runMcpb: cli.run, log })).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith("pack-mcpb: Unknown arguments: --sign");
    expect(cli.run).not.toHaveBeenCalled();
  });

  it("reports a CLI failure as exit code 1", async () => {
    writeRepo();
    const log = quietLog();
    const run = () => {
      throw new Error("Command failed: npx");
    };
    await expect(main([], { repoRoot: root, runMcpb: run, log })).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith("pack-mcpb: Command failed: npx");
  });

  it("reports a non-Error throw", async () => {
    writeRepo();
    const log = quietLog();
    const run = () => {
      throw "boom";
    };
    await expect(main([], { repoRoot: root, runMcpb: run, log })).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith("pack-mcpb: boom");
  });
});
