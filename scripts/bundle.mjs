// Builds server/future-electronics-mcp.mjs: src/index.ts plus all runtime
// dependencies in one self-contained ESM file, so the server runs from a plain
// copy of the repo with no `npm install` and no build step (issue #32).
//
// The output must be deterministic (CI re-bundles and runs
// `git diff --exit-code server/`): no timestamps, no sourcemap, and paths in
// the output are relative to the repo root, never absolute.
import { build } from "esbuild";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outfile = "server/future-electronics-mcp.mjs";

// src/index.ts starts with a `#!/usr/bin/env node` hashbang, which esbuild
// keeps as the first line of the output. The banner goes right after it.
const banner = [
  "// future-electronics-mcp: MCP server for the Future Electronics Product Information API.",
  "// Source: https://github.com/Reid-n0rc/future-electronics-mcp",
  "// SPDX-License-Identifier: AGPL-3.0-or-later",
  "//",
  "// GENERATED FILE. Do not edit by hand. Rebuild with `npm run bundle`.",
  "// Bundled dependency license notices are at the end of this file.",
].join("\n");

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  charset: "utf8",
  banner: { js: banner },
  metafile: true,
  write: false,
  logLevel: "warning",
});

/** Package root ("node_modules/<name>" or "node_modules/@scope/<name>") of a bundled input path. */
function packageRoot(inputPath) {
  const parts = inputPath.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return undefined;
  const nameLength = parts[at + 1]?.startsWith("@") ? 2 : 1;
  return parts.slice(0, at + 1 + nameLength).join("/");
}

// None of the bundled dependencies mark their notices with @license or /*!,
// so `legalComments: "eof"` alone keeps nothing. Append each bundled
// package's LICENSE file instead, sorted by package name for stable output.
async function licenseNotices(inputs) {
  const roots = [...new Set(inputs.map(packageRoot).filter(Boolean))].sort();
  const sections = [];
  for (const root of roots) {
    const dir = join(repoRoot, root);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const licenseFile = (await readdir(dir)).sort().find((f) => /^licen[cs]e(\.|$)/i.test(f));
    if (!licenseFile) throw new Error(`No LICENSE file found for bundled package ${pkg.name}`);
    const text = (await readFile(join(dir, licenseFile), "utf8")).replace(/\r\n?/g, "\n").trimEnd();
    sections.push(
      [
        `// ---- ${pkg.name}@${pkg.version} (${pkg.license}) ----`,
        ...text.split("\n").map((line) => (line ? `// ${line}` : "//")),
      ].join("\n"),
    );
  }
  return ["// ==== Bundled dependency license notices ====", ...sections].join("\n//\n") + "\n";
}

const [output] = result.outputFiles;
const notices = await licenseNotices(Object.keys(result.metafile.inputs));
const target = join(repoRoot, outfile);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, output.text + "\n" + notices);
await chmod(target, 0o755);
