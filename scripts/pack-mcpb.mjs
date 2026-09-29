// Builds build/future-electronics-mcp.mcpb, the Claude Desktop one-click
// install bundle (issue #34). MCPB spec:
// https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
//
// It stages only mcpb/manifest.json (as manifest.json), the committed server
// bundle, LICENSE and README.md into a fresh temp dir, so nothing else from the
// repo (.env, node_modules, src) can end up in the .mcpb. Then it runs the
// pinned mcpb CLI to validate and pack that dir.
//
// Usage:
//   node scripts/pack-mcpb.mjs                 validate and pack
//   node scripts/pack-mcpb.mjs --check-tag v1.2.3
//                                              only check that the manifest
//                                              version equals the tag without
//                                              its leading "v" (release workflow)
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned mcpb CLI (npm package @anthropic-ai/mcpb). */
export const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

/** Output path, relative to the repo root. build/ is git-ignored. */
export const OUTPUT = "build/future-electronics-mcp.mcpb";

/** Files copied into the bundle: [source in repo, path inside the .mcpb]. */
export const STAGED_FILES = [
  ["mcpb/manifest.json", "manifest.json"],
  ["server/future-electronics-mcp.mjs", "server/future-electronics-mcp.mjs"],
  ["LICENSE", "LICENSE"],
  ["README.md", "README.md"],
];

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

/** The version a release tag stands for: "v1.2.3" -> "1.2.3". Throws on a non-semver tag. */
export function versionFromTag(tag) {
  if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim())) {
    throw new Error(`Release tag ${JSON.stringify(tag)} is not a version like v1.2.3`);
  }
  return tag.trim().replace(/^v/, "");
}

/** Reads mcpb/manifest.json and package.json, and throws unless their versions match. */
export async function readVersions(repoRoot = defaultRoot) {
  const manifest = JSON.parse(await readFile(join(repoRoot, "mcpb/manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `mcpb/manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`,
    );
  }
  return { manifest: manifest.version, pkg: pkg.version };
}

/** Throws unless the manifest (and package.json) version equals the release tag without its "v". */
export async function checkTag(tag, repoRoot = defaultRoot) {
  const expected = versionFromTag(tag);
  const { manifest } = await readVersions(repoRoot);
  if (manifest !== expected) {
    throw new Error(`mcpb/manifest.json version ${manifest} does not match release tag ${tag}`);
  }
  return expected;
}

/** Runs the pinned mcpb CLI through npx. */
export function runMcpbCli(args) {
  execFileSync("npx", ["-y", MCPB_CLI, ...args], { stdio: "inherit" });
}

/**
 * Stages the bundle files in a temp dir, validates and packs them into
 * `<repoRoot>/build/future-electronics-mcp.mcpb`, and removes the temp dir.
 * `runMcpb` is injectable so tests can run without the network.
 */
export async function packMcpb({ repoRoot = defaultRoot, runMcpb = runMcpbCli } = {}) {
  await readVersions(repoRoot);
  const stage = await mkdtemp(join(tmpdir(), "fe-mcpb-"));
  const output = resolve(repoRoot, OUTPUT);
  try {
    for (const [from, to] of STAGED_FILES) {
      await mkdir(dirname(join(stage, to)), { recursive: true });
      await copyFile(join(repoRoot, from), join(stage, to));
    }
    await mkdir(dirname(output), { recursive: true });
    await rm(output, { force: true });
    runMcpb(["validate", join(stage, "manifest.json")]);
    runMcpb(["pack", stage, output]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return output;
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv, { repoRoot = defaultRoot, runMcpb = runMcpbCli, log = console } = {}) {
  try {
    if (argv[0] === "--check-tag") {
      const version = await checkTag(argv[1], repoRoot);
      log.log(`mcpb/manifest.json version ${version} matches release tag ${argv[1]}`);
      return 0;
    }
    if (argv.length > 0) throw new Error(`Unknown arguments: ${argv.join(" ")}`);
    const output = await packMcpb({ repoRoot, runMcpb });
    log.log(`Wrote ${output}`);
    return 0;
  } catch (error) {
    log.error(`pack-mcpb: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
