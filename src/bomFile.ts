// BOM files in the workspace folder (issue #43): read a .csv/.tsv file through
// resolveInWorkspace, parse it (RFC 4180), and pick the part number and
// quantity columns. Quantities are returned as text; the lookup tool validates
// them with the same schema as inline `parts`.
//
// Error messages quote only the file name as the caller gave it (just its last
// part when absolute), never the resolved path or the workspace path.

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { z } from "zod";
import { loadWorkspaceDir } from "./config.js";
import { resolveInWorkspace } from "./workspace.js";

/** Largest BOM file read, in bytes (checked with stat before reading). */
export const MAX_BOM_BYTES = 5 * 1024 * 1024;
export const BOM_EXTENSIONS = [".csv", ".tsv"];
export const DELIMITERS = [",", ";", "\t"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** Header aliases for column auto-detection (compared trimmed, lowercase, single-spaced). */
export const PART_ALIASES = ["mpn", "manufacturer part number", "part number", "part_number", "mfr part", "pn"];
export const QUANTITY_ALIASES = ["qty", "quantity", "quantity per", "count"];

/** Raised for any problem with a BOM file; the message is safe to show. */
export class BomFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BomFileError";
  }
}

const columnSchema = z.union([z.string().trim().min(1), z.number().int().positive()]);

export const bomFileSchema = z.object({
  path: z.string().min(1).describe("File name in the workspace folder, e.g. \"bom.csv\" (.csv or .tsv)."),
  part_column: columnSchema
    .optional()
    .describe("Part number column: header name or 1-based column number. Default: auto-detect."),
  quantity_column: columnSchema
    .optional()
    .describe("Quantity column: header name or 1-based column number. Default: auto-detect."),
  has_header: z.boolean().default(true).describe("First row is a header row (default true)."),
  delimiter: z
    .enum(DELIMITERS)
    .optional()
    .describe('"," ";" or tab. Default: auto-detect from the first line.'),
});
export type BomFileSpec = z.input<typeof bomFileSchema>;

/** One data row with a part number. `row` is the 1-based record number in the file. */
export interface BomRow {
  row: number;
  part_number: string;
  quantity?: string;
}

/** How the file was read, echoed to the caller. */
export interface BomSource {
  file: string;
  rows_read: number;
  rows_skipped: number;
  part_column: string;
  quantity_column: string | null;
}

/** The name to show in messages: as given, or its last part when absolute. */
export function displayName(name: string): string {
  const shown = isAbsolute(name) ? basename(name) : name;
  return JSON.stringify(shown.length > 120 ? `${shown.slice(0, 120)}...` : shown);
}

/**
 * The delimiter of the first line (outside quotes): the most frequent of
 * `,` `;` and tab. With no delimiter, or a tie, `fallback` wins if it is tied
 * for first, else the earlier candidate.
 */
export function detectDelimiter(text: string, fallback: Delimiter = ","): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && counts.has(c as Delimiter)) counts.set(c as Delimiter, counts.get(c as Delimiter)! + 1);
  }
  const max = Math.max(...counts.values());
  if (counts.get(fallback) === max) return fallback;
  return DELIMITERS.find((d) => counts.get(d) === max)!;
}

/**
 * RFC 4180 parser: quoted fields, `""` escapes, delimiters and newlines inside
 * quotes, and LF, CRLF or CR line ends. A final line end is optional. It is
 * lenient about stray quotes inside unquoted fields (kept as text) but throws
 * on an unterminated quoted field.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let wasQuoted = false;
  let quoteStart = 0;
  const endField = () => {
    record.push(field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else inQuotes = false;
    } else if (c === '"' && field === "" && !wasQuoted) {
      inQuotes = wasQuoted = true;
      quoteStart = records.length + 1;
    } else if (c === delimiter) {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endField();
      records.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new BomFileError(`Row ${quoteStart} has a quoted field that is never closed.`);
  if (field !== "" || wasQuoted || record.length > 0) {
    endField();
    records.push(record);
  }
  return records;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function listHeaders(headers: string[]): string {
  const shown = headers.slice(0, 40).map((h) => JSON.stringify(h.trim().slice(0, 60)));
  return shown.join(", ") + (headers.length > 40 ? `, and ${headers.length - 40} more` : "");
}

/**
 * The 0-based index of a column. `named` is a header name (case-insensitive)
 * or a 1-based column number; without it, the header is matched against
 * `aliases`. Returns undefined when auto-detection finds nothing.
 */
export function findColumn(
  headers: string[] | undefined,
  named: string | number | undefined,
  aliases: string[],
  kind: string,
): number | undefined {
  const found = headers === undefined ? "The file has no header row." : `Headers found: ${listHeaders(headers)}.`;
  if (named !== undefined) {
    const matches = headers ? headers.flatMap((h, i) => (norm(h) === norm(String(named)) ? [i] : [])) : [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new BomFileError(`More than one column is named ${JSON.stringify(String(named))}. ${found}`);
    const n = typeof named === "number" ? named : /^\d+$/.test(named.trim()) ? Number(named) : NaN;
    if (n >= 1) return n - 1;
    throw new BomFileError(`No ${kind} column named ${JSON.stringify(named)}. ${found}`);
  }
  if (headers === undefined) return undefined;
  const matches = headers.flatMap((h, i) => (aliases.includes(norm(h)) ? [i] : []));
  if (matches.length > 1) {
    throw new BomFileError(
      `Several columns could be the ${kind} column (${listHeaders(matches.map((i) => headers[i]!))}). ` +
        `Name one with ${kind}_column. ${found}`,
    );
  }
  return matches[0];
}

/** Reads the file's text: extension check, then resolve, stat and size cap, then read. */
async function readBomText(name: string, root: string): Promise<string> {
  const shown = displayName(name);
  if (!BOM_EXTENSIONS.includes(extname(name).toLowerCase())) {
    throw new BomFileError(`${shown} is not a .csv or .tsv file.`);
  }
  const real = await resolveInWorkspace(name, root);
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BomFileError(`${shown} was not found in the workspace folder. Use future_list_bom_files to see the files there.`);
    }
    throw new BomFileError(`Cannot open ${shown} (${code ?? "error"}).`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new BomFileError(`${shown} is not a file.`);
    const tooBig = () => new BomFileError(`${shown} is larger than the ${MAX_BOM_BYTES / 1024 / 1024} MB limit.`);
    if (st.size > MAX_BOM_BYTES) throw tooBig();
    const bytes = await fh.readFile();
    if (bytes.length > MAX_BOM_BYTES) throw tooBig();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
      throw new BomFileError(`${shown} is not valid UTF-8 text. Save it as "CSV UTF-8".`);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Loads a BOM file from the workspace. Blank rows (every cell empty) are
 * ignored; rows with an empty part number are skipped and counted. Throws
 * {@link BomFileError} or a WorkspaceError, both with safe messages.
 */
export async function loadBomFile(
  spec: BomFileSpec,
  root: string = loadWorkspaceDir(),
): Promise<{ rows: BomRow[]; source: BomSource }> {
  const text = await readBomText(spec.path, root);
  const fallback = extname(spec.path).toLowerCase() === ".tsv" ? "\t" : ",";
  const records = parseCsv(text, spec.delimiter ?? detectDelimiter(text, fallback));
  const hasHeader = spec.has_header ?? true;
  const headers = hasHeader ? records[0] : undefined;
  if (hasHeader && headers === undefined) throw new BomFileError(`${displayName(spec.path)} is empty.`);
  const partIdx = findColumn(headers, spec.part_column, PART_ALIASES, "part") ?? (hasHeader ? undefined : 0);
  if (partIdx === undefined) {
    throw new BomFileError(
      `No part number column found. Name one with part_column. Headers found: ${listHeaders(headers!)}.`,
    );
  }
  const qtyIdx = findColumn(headers, spec.quantity_column, QUANTITY_ALIASES, "quantity");
  const label = (i: number) => headers?.[i]?.trim() || `column ${i + 1}`;
  const rows: BomRow[] = [];
  let read = 0;
  let skipped = 0;
  records.forEach((record, i) => {
    if ((hasHeader && i === 0) || record.every((cell) => cell.trim() === "")) return;
    read++;
    const part_number = record[partIdx]?.trim() ?? "";
    if (part_number === "") return void skipped++;
    const quantity = qtyIdx === undefined ? "" : (record[qtyIdx]?.trim() ?? "");
    rows.push(quantity === "" ? { row: i + 1, part_number } : { row: i + 1, part_number, quantity });
  });
  const source: BomSource = {
    file: isAbsolute(spec.path) ? basename(spec.path) : spec.path,
    rows_read: read,
    rows_skipped: skipped,
    part_column: label(partIdx),
    quantity_column: qtyIdx === undefined ? null : label(qtyIdx),
  };
  return { rows, source };
}
