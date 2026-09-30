// The workspace folder (issue #40): the one folder where the server reads BOM
// files and writes exports. Every file path goes through resolveInWorkspace,
// which confines access to that folder, following symlinks with realpath.
//
// Errors raised here never include the workspace path (it can reveal the
// user's name and folder layout to the model). At most they quote the name
// the caller passed in, or only its last part when that name is absolute.

import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadWorkspaceDir } from "./config.js";

/** Raised when a name is rejected or the workspace cannot be used. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Longest name quoted back in an error message. */
const MAX_QUOTED = 120;

/** Quotes a name for an error; an absolute name is cut to its last part. */
function quote(name: string): string {
  if (isAbsolute(name)) name = basename(name);
  const short = name.length > MAX_QUOTED ? `${name.slice(0, MAX_QUOTED)}...` : name;
  return JSON.stringify(short);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** True if `child` is `parent` or lies inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves every symlink in `path`, including in the part that does not exist
 * yet: it realpaths the deepest existing ancestor and appends the rest.
 * Returns undefined for a dangling symlink, whose target cannot be checked.
 */
async function realpathLoose(path: string): Promise<string | undefined> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      await lstat(current);
    } catch (error) {
      if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
      continue;
    }
    try {
      return join(await realpath(current), ...rest);
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
  }
}

/**
 * Returns the absolute, symlink-free path of `name` inside the workspace, or
 * throws a {@link WorkspaceError}. `name` may be a plain file name, a subpath,
 * or an absolute path that is already inside the workspace. It rejects `..`
 * escapes, absolute paths elsewhere, NUL bytes, dangling symlinks, and
 * symlinks (of the file or any parent, or of the workspace itself) that lead
 * outside. The file need not exist yet, so this also works for writes.
 */
export async function resolveInWorkspace(
  name: string,
  root: string = loadWorkspaceDir(),
): Promise<string> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new WorkspaceError("A file name is required.");
  }
  if (name.includes("\0")) {
    throw new WorkspaceError("The file name must not contain a NUL byte.");
  }
  const outside = () =>
    new WorkspaceError(`${quote(name)} is outside the workspace folder. Use a name inside it.`);
  const rootPath = resolve(root);
  const target = resolve(rootPath, name);
  const check = async (path: string) => {
    try {
      return await realpathLoose(path);
    } catch (error) {
      throw new WorkspaceError(`Cannot check ${quote(name)} (${code(error) ?? "error"}).`);
    }
  };
  const realRoot = await check(rootPath);
  if (realRoot === undefined) {
    throw new WorkspaceError("The workspace folder is a broken symlink.");
  }
  // Lexical check first, so nothing outside is touched. An absolute name may
  // spell the workspace by its real path when the workspace is a symlink.
  if (!isWithin(rootPath, target) && !isWithin(realRoot, target)) throw outside();
  if (target === rootPath || target === realRoot) {
    throw new WorkspaceError(`${quote(name)} is the workspace folder itself, not a file.`);
  }
  const realTarget = await check(target);
  if (realTarget === undefined) {
    throw new WorkspaceError(`${quote(name)} is a broken symlink.`);
  }
  if (realTarget === realRoot || !isWithin(realRoot, realTarget)) throw outside();
  return realTarget;
}

/**
 * Creates the workspace folder (mode 0700) if it does not exist, and returns
 * its real path. Call this before the first write; never at startup.
 */
export async function ensureWorkspace(root: string = loadWorkspaceDir()): Promise<string> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const real = await realpath(root);
    if (!(await stat(real)).isDirectory()) throw Object.assign(new Error(), { code: "ENOTDIR" });
    return real;
  } catch (error) {
    throw new WorkspaceError(
      `Cannot create or open the workspace folder (${code(error) ?? "error"}). ` +
        "Check FUTURE_WORKSPACE_DIR.",
    );
  }
}

/**
 * Lists the file names directly in the workspace (not recursive), sorted.
 * Hidden files are skipped, and so are symlinks that lead outside the
 * workspace. `ext` filters by extension, case-insensitively (".csv" or "csv",
 * or several). A workspace that does not exist yet has no files.
 */
export async function listFiles(
  ext?: string | string[],
  root: string = loadWorkspaceDir(),
): Promise<string[]> {
  const wanted = (ext === undefined ? [] : [ext].flat()).map(
    (e) => `.${e.trim().replace(/^\./, "").toLowerCase()}`,
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw new WorkspaceError(`Cannot list the workspace folder (${code(error) ?? "error"}).`);
  }
  const names: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (wanted.length > 0 && !wanted.some((e) => name.toLowerCase().endsWith(e))) continue;
    if (entry.isSymbolicLink()) {
      try {
        const real = await resolveInWorkspace(name, root);
        if (!(await stat(real)).isFile()) continue;
      } catch {
        continue;
      }
    } else if (!entry.isFile()) {
      continue;
    }
    names.push(name);
  }
  return names.sort();
}
