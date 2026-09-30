// Tests for src/workspace.ts (issue #40), using real temp dirs and real
// symlinks. No network.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspace, listFiles, resolveInWorkspace, WorkspaceError } from "../src/workspace.js";

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let base: string; // real path of a fresh temp dir
let ws: string; // the workspace inside it
let outside: string; // a sibling folder outside the workspace

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fe-ws-")));
  ws = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  try {
    chmodSync(ws, 0o700);
  } catch {
    // the workspace may have been removed by a test
  }
  rmSync(base, { recursive: true, force: true });
});

/** Asserts a WorkspaceError whose message never contains the temp path. */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<WorkspaceError> {
  const error = await promise.then(
    () => expect.unreachable("expected a rejection"),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkspaceError);
  const message = (error as Error).message;
  expect(message).toMatch(pattern);
  expect(message).not.toContain(base);
  expect(message).not.toContain(ws);
  expect(String((error as Error).stack)).not.toContain(ws);
  return error as WorkspaceError;
}

describe("resolveInWorkspace: accepted names", () => {
  it("resolves a plain name that does not exist yet (for writes)", async () => {
    expect(await resolveInWorkspace("bom.csv", ws)).toBe(join(ws, "bom.csv"));
  });

  it("resolves an existing file", async () => {
    writeFileSync(join(ws, "bom.csv"), "x");
    expect(await resolveInWorkspace("bom.csv", ws)).toBe(join(ws, "bom.csv"));
  });

  it("resolves subpaths, existing or not", async () => {
    mkdirSync(join(ws, "sub"));
    expect(await resolveInWorkspace("sub/a.csv", ws)).toBe(join(ws, "sub", "a.csv"));
    expect(await resolveInWorkspace("new/deeper/a.csv", ws)).toBe(join(ws, "new", "deeper", "a.csv"));
  });

  it("normalizes harmless dot segments that stay inside", async () => {
    mkdirSync(join(ws, "sub"));
    expect(await resolveInWorkspace("./sub/../a.csv", ws)).toBe(join(ws, "a.csv"));
    expect(await resolveInWorkspace("sub/./b.csv", ws)).toBe(join(ws, "sub", "b.csv"));
  });

  it("accepts names that merely start with two dots", async () => {
    expect(await resolveInWorkspace("..bom.csv", ws)).toBe(join(ws, "..bom.csv"));
  });

  it("accepts an absolute path inside the workspace", async () => {
    expect(await resolveInWorkspace(join(ws, "a.csv"), ws)).toBe(join(ws, "a.csv"));
  });

  it("works when the workspace does not exist yet", async () => {
    const missing = join(base, "not-yet", "ws");
    expect(await resolveInWorkspace("a.csv", missing)).toBe(join(missing, "a.csv"));
  });

  it.skipIf(isWindows)("accepts a symlink that stays inside the workspace", async () => {
    mkdirSync(join(ws, "real"));
    writeFileSync(join(ws, "real", "a.csv"), "x");
    symlinkSync(join(ws, "real", "a.csv"), join(ws, "link.csv"));
    symlinkSync(join(ws, "real"), join(ws, "dirlink"));
    expect(await resolveInWorkspace("link.csv", ws)).toBe(join(ws, "real", "a.csv"));
    expect(await resolveInWorkspace("dirlink/new.csv", ws)).toBe(join(ws, "real", "new.csv"));
  });

  it.skipIf(isWindows)("handles a workspace that is itself a symlink", async () => {
    const link = join(base, "ws-link");
    symlinkSync(ws, link);
    expect(await resolveInWorkspace("a.csv", link)).toBe(join(ws, "a.csv"));
    // An absolute name may use either spelling of the workspace.
    expect(await resolveInWorkspace(join(link, "b.csv"), link)).toBe(join(ws, "b.csv"));
    expect(await resolveInWorkspace(join(ws, "c.csv"), link)).toBe(join(ws, "c.csv"));
    await expectRejected(resolveInWorkspace(join(outside, "secret.txt"), link), /outside/);
  });

  it.skipIf(isWindows)("handles a workspace under a symlinked parent", async () => {
    const parentLink = join(base, "parent-link");
    symlinkSync(base, parentLink);
    expect(await resolveInWorkspace("a.csv", join(parentLink, "workspace"))).toBe(join(ws, "a.csv"));
  });
});

describe("resolveInWorkspace: rejected names", () => {
  it.each(["../x", "..", "../outside/secret.txt", "sub/../../x", "a/b/../../../x", "./../x"])(
    "rejects traversal %j",
    async (name) => {
      await expectRejected(resolveInWorkspace(name, ws), /outside the workspace/);
    },
  );

  it("rejects an absolute path outside the workspace", async () => {
    const error = await expectRejected(resolveInWorkspace(join(outside, "secret.txt"), ws), /outside the workspace/);
    // An absolute name is quoted by its last part only.
    expect(error.message).toMatch(/^"secret\.txt" is outside/);
    await expectRejected(resolveInWorkspace("/etc/passwd", ws), /outside the workspace/);
  });

  it("rejects a sibling folder whose name starts with the workspace name", async () => {
    mkdirSync(`${ws}2`);
    await expectRejected(resolveInWorkspace(join(`${ws}2`, "a.csv"), ws), /outside the workspace/);
  });

  it.each(["", "   ", ".", "./", "sub/.."])("rejects %j (empty or the workspace itself)", async (name) => {
    await expectRejected(resolveInWorkspace(name, ws), /required|workspace folder itself/);
  });

  it("rejects a non-string name", async () => {
    await expectRejected(resolveInWorkspace(42 as unknown as string, ws), /required/);
  });

  it.each(["a\0.csv", "\0", "sub/\0/../a"])("rejects a NUL byte in %j", async (name) => {
    await expectRejected(resolveInWorkspace(name, ws), /NUL/);
  });

  it("quotes only the given name, truncated", async () => {
    const long = `../${"x".repeat(500)}`;
    const error = await expectRejected(resolveInWorkspace(long, ws), /outside/);
    expect(error.message.length).toBeLessThan(250);
    expect(error.message).toContain("...");
  });

  it.skipIf(isWindows)("rejects a file symlink that escapes", async () => {
    symlinkSync(join(outside, "secret.txt"), join(ws, "escape.txt"));
    await expectRejected(resolveInWorkspace("escape.txt", ws), /outside the workspace/);
  });

  it.skipIf(isWindows)("rejects a directory symlink that escapes, for reads and writes", async () => {
    symlinkSync(outside, join(ws, "out"));
    await expectRejected(resolveInWorkspace("out/secret.txt", ws), /outside the workspace/);
    await expectRejected(resolveInWorkspace("out/new.csv", ws), /outside the workspace/);
    await expectRejected(resolveInWorkspace("out/new/deeper.csv", ws), /outside the workspace/);
  });

  it.skipIf(isWindows)("rejects a symlink to the workspace folder itself", async () => {
    symlinkSync(ws, join(ws, "self"));
    await expectRejected(resolveInWorkspace("self", ws), /outside the workspace/);
  });

  it.skipIf(isWindows)("rejects a dangling symlink (a write would land outside)", async () => {
    symlinkSync(join(outside, "created-later.txt"), join(ws, "dangling.csv"));
    await expectRejected(resolveInWorkspace("dangling.csv", ws), /broken symlink/);
  });

  it.skipIf(isWindows)("rejects a symlink hop through `..` inside a linked folder", async () => {
    mkdirSync(join(outside, "deep"));
    symlinkSync(join(outside, "deep"), join(ws, "deep"));
    // Lexically "deep/../a.csv" is ws/a.csv, which is allowed; the returned
    // path is the real one, so the caller never follows the link.
    expect(await resolveInWorkspace("deep/../a.csv", ws)).toBe(join(ws, "a.csv"));
    await expectRejected(resolveInWorkspace("deep/x.csv", ws), /outside/);
  });

  it.skipIf(isWindows)("rejects when the workspace itself is a broken symlink", async () => {
    const link = join(base, "broken-ws");
    symlinkSync(join(base, "gone"), link);
    await expectRejected(resolveInWorkspace("a.csv", link), /workspace folder is a broken symlink/);
  });

  it.skipIf(isWindows || isRoot)("wraps filesystem errors without the path", async () => {
    mkdirSync(join(ws, "locked"));
    chmodSync(join(ws, "locked"), 0o000);
    try {
      await expectRejected(resolveInWorkspace("locked/inner/a.csv", ws), /Cannot check "locked/);
    } finally {
      chmodSync(join(ws, "locked"), 0o700);
    }
  });

  it("uses FUTURE_WORKSPACE_DIR by default", async () => {
    const saved = process.env.FUTURE_WORKSPACE_DIR;
    process.env.FUTURE_WORKSPACE_DIR = ws;
    try {
      expect(await resolveInWorkspace("a.csv")).toBe(join(ws, "a.csv"));
      expect(await listFiles()).toEqual([]);
      expect(await ensureWorkspace()).toBe(ws);
    } finally {
      if (saved === undefined) delete process.env.FUTURE_WORKSPACE_DIR;
      else process.env.FUTURE_WORKSPACE_DIR = saved;
    }
  });
});

describe("ensureWorkspace", () => {
  it.skipIf(isWindows)("creates the folder lazily with mode 0700", async () => {
    const target = join(base, "new", "ws");
    expect(await ensureWorkspace(target)).toBe(target);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(base, "new")).mode & 0o777).toBe(0o700);
  });

  it("is a no-op for an existing folder", async () => {
    writeFileSync(join(ws, "keep.csv"), "x");
    expect(await ensureWorkspace(ws)).toBe(ws);
    expect(statSync(join(ws, "keep.csv")).isFile()).toBe(true);
  });

  it.skipIf(isWindows)("returns the real path of a symlinked workspace", async () => {
    const link = join(base, "ws-link");
    symlinkSync(ws, link);
    expect(await ensureWorkspace(link)).toBe(ws);
  });

  it("fails clearly, without the path, when a file is in the way", async () => {
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    const error = await ensureWorkspace(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toMatch(/Cannot create or open the workspace folder \(E/);
    expect((error as Error).message).not.toContain(base);
  });
});

describe("listFiles", () => {
  beforeEach(() => {
    writeFileSync(join(ws, "b.csv"), "x");
    writeFileSync(join(ws, "A.CSV"), "x");
    writeFileSync(join(ws, "notes.txt"), "x");
    writeFileSync(join(ws, ".hidden.csv"), "x");
    mkdirSync(join(ws, "dir.csv"));
    writeFileSync(join(ws, "dir.csv", "nested.csv"), "x");
  });

  it("lists top-level files, sorted, skipping hidden files and folders", async () => {
    expect(await listFiles(undefined, ws)).toEqual(["A.CSV", "b.csv", "notes.txt"]);
  });

  it.each([".csv", "csv", "CSV", " .Csv "])("filters by extension %j, case-insensitively", async (ext) => {
    expect(await listFiles(ext, ws)).toEqual(["A.CSV", "b.csv"]);
  });

  it("accepts several extensions", async () => {
    expect(await listFiles(["txt", ".csv"], ws)).toEqual(["A.CSV", "b.csv", "notes.txt"]);
  });

  it("returns nothing for an unmatched extension", async () => {
    expect(await listFiles("xlsx", ws)).toEqual([]);
  });

  it("returns an empty list, without creating it, when the workspace is missing", async () => {
    const missing = join(base, "missing");
    expect(await listFiles(undefined, missing)).toEqual([]);
    expect(() => statSync(missing)).toThrow();
  });

  it.skipIf(isWindows)("keeps symlinks to files inside, drops escaping, dangling, and folder links", async () => {
    symlinkSync(join(ws, "b.csv"), join(ws, "inside.csv"));
    symlinkSync(join(outside, "secret.txt"), join(ws, "escape.csv"));
    symlinkSync(join(base, "gone.csv"), join(ws, "dangling.csv"));
    symlinkSync(join(ws, "dir.csv"), join(ws, "folderlink.csv"));
    expect(await listFiles("csv", ws)).toEqual(["A.CSV", "b.csv", "inside.csv"]);
  });

  it("fails clearly when the workspace is not a folder", async () => {
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    const error = await listFiles(undefined, file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toMatch(/Cannot list the workspace folder \(ENOTDIR\)/);
    expect((error as Error).message).not.toContain(base);
  });
});
