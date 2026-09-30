// MCP tool `future_query_results` (issue #42): read any subset of a stored
// `future_lookup_parts` result by its result_id. It filters, selects columns
// and pages over the stored per-part results, and it never calls the Future
// API. Output is a compact {columns, rows} table capped by
// FUTURE_MAX_OUTPUT_TOKENS (src/output.ts).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadMaxOutputTokens } from "../config.js";
import { PRICING_DISCLAIMER } from "../format.js";
import { fitToBudget, isBudgetError, toText } from "../output.js";
import { defaultResultStore, unknownResultMessage, type ResultStore } from "../results.js";
import { errorResult } from "./common.js";
import {
  PART_COLUMNS,
  leadTimeDays,
  partsTable,
  problemReasons,
  type PartResult,
  type PartStatus,
} from "./lookupParts.js";

export const QUERY_RESULTS_TOOL_NAME = "future_query_results";
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;

/** Every status `future_lookup_parts` emits. */
export const PART_STATUSES = [
  "found", "not_found", "error", "not_attempted",
] as const satisfies readonly PartStatus[];
// Compile-time check that PART_STATUSES covers PartStatus exactly.
const statusesMatch: [PartStatus] extends [(typeof PART_STATUSES)[number]] ? true : false = true;
void statusesMatch;

/** Column names accepted by `fields` (the detail "all" columns). */
export const QUERY_COLUMNS = PART_COLUMNS as [string, ...string[]];

export const QUERY_TRUNCATION_HINT =
  "Rows were dropped from the end to fit FUTURE_MAX_OUTPUT_TOKENS. Continue from next_offset, " +
  "request fewer fields, or use a smaller limit.";

const fieldSchema = z.enum(QUERY_COLUMNS, {
  errorMap: () => ({ message: `Unknown field. Valid fields: ${QUERY_COLUMNS.join(", ")}.` }),
});
const statusSchema = z.enum(PART_STATUSES, {
  errorMap: () => ({ message: `Unknown status. Valid statuses: ${PART_STATUSES.join(", ")}.` }),
});

export const queryResultsInputShape = {
  result_id: z.string().min(1).describe("The result_id returned by future_lookup_parts."),
  status: z
    .array(statusSchema)
    .min(1)
    .optional()
    .describe(`Keep only parts with one of these statuses: ${PART_STATUSES.join(", ")}.`),
  min_lead_time_weeks: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Keep only parts whose lead time is at least this many weeks. Parts with an unknown or " +
        '"CALL" lead time are excluded.',
    ),
  short_stock: z
    .boolean()
    .optional()
    .describe("true: only parts with available < quantity. false: only parts without that problem."),
  below_moq: z
    .boolean()
    .optional()
    .describe("true: only parts whose given quantity is below the MOQ. false: only parts without it."),
  part_numbers: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("Keep only these part numbers (case-insensitive, as sent to future_lookup_parts)."),
  fields: z
    .array(fieldSchema)
    .min(1)
    .optional()
    .describe(`Columns to return, in this order (default: all). Valid: ${QUERY_COLUMNS.join(", ")}.`),
  offset: z.number().int().nonnegative().default(0).describe("Matching rows to skip (default 0)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .default(DEFAULT_QUERY_LIMIT)
    .describe(`Rows to return (default ${DEFAULT_QUERY_LIMIT}, max ${MAX_QUERY_LIMIT}).`),
};

export interface QueryResultsInput {
  result_id: string;
  status?: PartStatus[];
  min_lead_time_weeks?: number;
  short_stock?: boolean;
  below_moq?: boolean;
  part_numbers?: string[];
  fields?: string[];
  offset?: number;
  limit?: number;
}

export const QUERY_RESULTS_DESCRIPTION =
  "Query a stored future_lookup_parts result by its result_id, without calling the Future API " +
  "again. Use this instead of re-running a BOM lookup to see parts the summary left out, other " +
  "columns, or a filtered subset. Filters (all optional, combined with AND): status[] " +
  `(${PART_STATUSES.join(", ")}), min_lead_time_weeks, short_stock, below_moq, part_numbers[]. ` +
  `fields[] picks columns from: ${QUERY_COLUMNS.join(", ")}. Paged with offset and limit ` +
  `(default ${DEFAULT_QUERY_LIMIT}, max ${MAX_QUERY_LIMIT}). Returns total_matching, ` +
  "next_offset (null on the last page) and a {columns, rows} table, capped at " +
  "FUTURE_MAX_OUTPUT_TOKENS. Results expire 60 minutes after last use.";

/** Parts that pass every given filter, in stored (input) order. */
export function filterParts(parts: PartResult[], input: QueryResultsInput): PartResult[] {
  const statuses = input.status ? new Set<string>(input.status) : undefined;
  const names = input.part_numbers
    ? new Set(input.part_numbers.map((p) => p.trim().toLowerCase()))
    : undefined;
  const minDays = input.min_lead_time_weeks === undefined ? undefined : input.min_lead_time_weeks * 7;
  return parts.filter((p) => {
    if (statuses && !statuses.has(p.status)) return false;
    if (names && !names.has(p.part_number.toLowerCase())) return false;
    if (minDays !== undefined) {
      const days = leadTimeDays(p.lead_time);
      if (days === undefined || days < minDays) return false;
    }
    const reasons = problemReasons(p);
    if (input.short_stock !== undefined && reasons.includes("short_stock") !== input.short_stock) {
      return false;
    }
    if (input.below_moq !== undefined && reasons.includes("below_moq") !== input.below_moq) {
      return false;
    }
    return true;
  });
}

/** Run the query. Exported for tests; the MCP handler wraps it. Never calls the API. */
export function queryResults(
  input: QueryResultsInput,
  store: ResultStore = defaultResultStore,
  maxOutputTokens?: number,
): CallToolResult {
  let budget: number;
  try {
    budget = maxOutputTokens ?? loadMaxOutputTokens();
  } catch (error) {
    return errorResult(error);
  }
  const stored = store.get(input.result_id);
  if (!stored) return { content: [{ type: "text", text: unknownResultMessage(input.result_id) }], isError: true };

  const fields = input.fields ?? QUERY_COLUMNS;
  const unknown = fields.filter((f) => !QUERY_COLUMNS.includes(f));
  if (unknown.length > 0) {
    const text = `Unknown field(s): ${unknown.join(", ")}. Valid fields: ${QUERY_COLUMNS.join(", ")}.`;
    return { content: [{ type: "text", text }], isError: true };
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_QUERY_LIMIT;

  const matching = filterParts(stored.parts, input);
  const full = partsTable(matching.slice(offset, offset + limit), true);
  const idx = fields.map((f) => full.columns.indexOf(f));
  const rows = full.rows.map((r) => idx.map((i) => r[i]!));

  // next_offset starts as a placeholder at least as wide as its final value
  // (a number <= total_matching, or null), so replacing it never grows the
  // text past the budget.
  const total = matching.length;
  const value = {
    result_id: input.result_id,
    note: PRICING_DISCLAIMER,
    total_matching: total,
    offset,
    next_offset: Math.max(total, 9999) as number | null,
    columns: fields,
    rows,
  };
  const fitted = fitToBudget(value, ["rows"], budget, QUERY_TRUNCATION_HINT);
  if (isBudgetError(fitted)) return { content: [{ type: "text", text: toText(fitted) }], isError: true };
  const end = offset + fitted.rows.length;
  fitted.next_offset = end < total ? end : null;
  return { content: [{ type: "text", text: toText(fitted) }] };
}

/** Register `future_query_results` on the server. It takes no client: it never calls the API. */
export function registerQueryResultsTool(
  server: McpServer,
  store: ResultStore = defaultResultStore,
): void {
  server.registerTool(
    QUERY_RESULTS_TOOL_NAME,
    {
      title: "Query a stored Future Electronics BOM result",
      description: QUERY_RESULTS_DESCRIPTION,
      inputSchema: queryResultsInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => queryResults(args, store),
  );
}
