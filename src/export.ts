// CSV and JSON export of a stored BOM lookup result (issue #44, part 1: #73).
//
// toCsv and toJson are pure, so the lookup tool's `export` option and the MCP
// resources (later parts of #44) can reuse them. writeExport saves one of them
// under `exports/` in the workspace folder, through resolveInWorkspace, and
// returns only a workspace-relative path, never the workspace path itself.

import { mkdir, writeFile } from "node:fs/promises";
import { PRICING_DISCLAIMER } from "./format.js";
import type { StoredResult } from "./results.js";
import { PART_COLUMNS, partsTable } from "./tools/lookupParts.js";
import { WorkspaceError, ensureWorkspace, resolveInWorkspace } from "./workspace.js";
import { loadWorkspaceDir } from "./config.js";

export type ExportFormat = "csv" | "json";

/** Folder, inside the workspace, that exports are written to. */
export const EXPORTS_DIR = "exports";

/** CSV columns: the same columns `future_query_results` exposes, in that order. */
export const CSV_COLUMNS: readonly string[] = PART_COLUMNS;

/** Leading characters a spreadsheet may treat as the start of a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * One CSV cell. null and undefined are empty. A string starting with `=`, `+`,
 * `-`, `@`, tab or CR gets a leading `'` so spreadsheets show it as text
 * (formula-injection guard). Numbers are written as-is. A cell containing a
 * comma, quote, CR or LF is quoted, with quotes doubled (RFC 4180).
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The stored parts as RFC 4180 CSV: a header row of {@link CSV_COLUMNS}, then
 * one row per part in input order, every line ending in CRLF. An empty result
 * gives the header only.
 */
export function toCsv(stored: Pick<StoredResult, "parts">): string {
  const table = partsTable(stored.parts, true);
  const lines = [table.columns, ...table.rows].map((row) => row.map(csvCell).join(","));
  return lines.map((line) => `${line}\r\n`).join("");
}

/**
 * The full stored result as pretty-printed JSON, raw upstream batches
 * included, with its result_id and the pricing note. Ends with a newline.
 */
export function toJson(resultId: string, stored: StoredResult): string {
  return `${JSON.stringify({ result_id: resultId, note: PRICING_DISCLAIMER, ...stored }, null, 2)}\n`;
}

/** What writeExport saved. `path` is relative to the workspace and uses `/`. */
export interface ExportFile {
  format: ExportFormat;
  path: string;
  /** Parts in the export (CSV data rows, or entries in the JSON `parts`). */
  rows: number;
  bytes: number;
}

export interface WriteExportOptions {
  /** Workspace folder; defaults to the configured one (FUTURE_WORKSPACE_DIR). */
  root?: string;
  /** Clock; injectable for tests. */
  now?: () => Date;
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function exportTimestamp(date: Date): string {
  const iso = date.toISOString(); // 2026-10-07T12:34:56.789Z
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** The file name for an export; unsafe id characters become `_`. */
export function exportFileName(resultId: string, format: ExportFormat, date: Date, n = 1): string {
  const id = resultId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "result";
  return `${exportTimestamp(date)}-${id}${n > 1 ? `-${n}` : ""}.${format}`;
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "error";
}

/** Most name suffixes tried when an export with the same name already exists. */
const MAX_NAME_ATTEMPTS = 100;

/**
 * Write the stored result as CSV or JSON to
 * `exports/<YYYYMMDD-HHMMSS>-<result_id>.<format>` in the workspace, creating
 * the workspace and `exports/` if needed. It never overwrites a file: a name
 * that is taken gets `-2`, `-3`, ... appended. Throws {@link WorkspaceError}
 * (or ConfigError for a bad FUTURE_WORKSPACE_DIR) with no absolute path in it.
 */
export async function writeExport(
  resultId: string,
  stored: StoredResult,
  format: ExportFormat,
  options: WriteExportOptions = {},
): Promise<ExportFile> {
  const root = await ensureWorkspace(options.root ?? loadWorkspaceDir());
  const date = (options.now ?? (() => new Date()))();
  const content = format === "csv" ? toCsv(stored) : toJson(resultId, stored);
  try {
    await mkdir(await resolveInWorkspace(EXPORTS_DIR, root), { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(`Cannot create the ${EXPORTS_DIR} folder (${code(error)}).`);
  }
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const path = `${EXPORTS_DIR}/${exportFileName(resultId, format, date, n)}`;
    try {
      await writeFile(await resolveInWorkspace(path, root), content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (code(error) === "EEXIST") continue;
      throw new WorkspaceError(`Cannot write ${JSON.stringify(path)} (${code(error)}).`);
    }
    return { format, path, rows: stored.parts.length, bytes: Buffer.byteLength(content) };
  }
  throw new WorkspaceError(`Too many exports named like ${JSON.stringify(exportFileName(resultId, format, date))}.`);
}
