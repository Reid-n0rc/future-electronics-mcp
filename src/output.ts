// Compact tool output and the output token budget (issue #41).
//
// Tool results are JSON without whitespace. Token counts are estimated as
// characters / 4. `fitToBudget` trims named list fields so a result never
// exceeds the budget, and it always says when it trimmed.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Error code returned when even an untrimmed-lists object exceeds the budget. */
export const BUDGET_EXCEEDED = "output_budget_exceeded";

export interface Truncation {
  omitted: number;
  hint: string;
}

export interface BudgetError {
  error: typeof BUDGET_EXCEEDED;
  message: string;
}

/** JSON without whitespace. */
export function toText(value: unknown): string {
  return JSON.stringify(value);
}

/** Estimated tokens for `text`: characters / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Maximum characters for a token budget. */
export function budgetChars(maxTokens: number): number {
  return Math.floor(maxTokens * 4);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function getAt(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) cur = isRecord(cur) ? cur[key] : undefined;
  return cur;
}

/** Copy `obj` with `value` at `path`, cloning only the objects along the path. */
function setAt(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  const child = obj[head!];
  return {
    ...obj,
    [head!]: rest.length === 0 ? value : setAt(isRecord(child) ? child : {}, rest, value),
  };
}

/**
 * Fit `value` into `maxTokens` (serialized with {@link toText}). `fields` are
 * dot paths to trimmable arrays (e.g. "issues.rows"); paths that are not
 * arrays are ignored. Rows are dropped from the end, emptying the last listed
 * field first, until the text fits. A trimmed result gets a top-level
 * `truncated: {omitted, hint}`. If the result cannot fit even with every
 * listed array emptied, a small {@link BudgetError} object is returned instead.
 * Never mutates `value`.
 */
export function fitToBudget<T extends Record<string, unknown>>(
  value: T,
  fields: string[],
  maxTokens: number,
  hint = "Some rows were omitted to stay within the output budget.",
): T | (T & { truncated: Truncation }) | BudgetError {
  const limit = budgetChars(maxTokens);
  if (toText(value).length <= limit) return value;

  const paths = fields.map((f) => f.split("."));
  const arrays = paths.map((p) => {
    const a = getAt(value, p);
    return Array.isArray(a) ? a : undefined;
  });
  const total = arrays.reduce((n, a) => n + (a?.length ?? 0), 0);

  // Drop `omit` rows from the end, last listed field first.
  const build = (omit: number): T & { truncated: Truncation } => {
    let out: Record<string, unknown> = value;
    let left = omit;
    for (let i = paths.length - 1; i >= 0; i--) {
      const a = arrays[i];
      if (!a) continue;
      const drop = Math.min(left, a.length);
      left -= drop;
      out = setAt(out, paths[i]!, a.slice(0, a.length - drop));
    }
    return { ...(out as T), truncated: { omitted: omit, hint } };
  };
  const fits = (omit: number) => toText(build(omit)).length <= limit;

  if (!fits(total)) {
    return {
      error: BUDGET_EXCEEDED,
      message:
        `The result exceeds the output budget of ${maxTokens} tokens even with every list ` +
        "emptied. Narrow the request or raise FUTURE_MAX_OUTPUT_TOKENS.",
    };
  }
  // Binary search for the fewest omitted rows that fit. `hi` always fits, so
  // the result always fits. Size shrinks (almost always strictly) as more rows
  // go: a dropped row removes at least 1 character, and `omitted` gains a
  // digit only at powers of ten.
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return build(lo);
}

/** True when `value` is the {@link BudgetError} from {@link fitToBudget}. */
export function isBudgetError(value: unknown): value is BudgetError {
  return isRecord(value) && value.error === BUDGET_EXCEEDED && Object.keys(value).length === 2;
}

/**
 * Budgeted tool result: fit `value`, serialize it compactly, and flag
 * `isError` when the budget could not be met.
 */
export function budgetedResult(
  value: Record<string, unknown>,
  fields: string[],
  maxTokens: number,
  hint?: string,
): CallToolResult {
  const fitted = fitToBudget(value, fields, maxTokens, hint);
  const result: CallToolResult = { content: [{ type: "text", text: toText(fitted) }] };
  if (isBudgetError(fitted)) result.isError = true;
  return result;
}
