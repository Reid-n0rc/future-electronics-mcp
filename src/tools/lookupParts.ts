// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj
//
// MCP tool `future_lookup_parts`: multi-part (BOM) lookup. The 300-part batch
// limit comes from the docs (MAX_BATCH_PARTS in src/client.ts).
//
// Behavior:
// - Part numbers are trimmed and deduplicated case-insensitively. The first
//   spelling wins. When duplicates carry quantities, the quantities are summed
//   (entries without a quantity add nothing). Parts with no quantity at all
//   are priced at quantity 1.
// - Parts that fail the client's part-number check (fewer than 3 alphanumeric
//   characters) are reported as errors and never sent, so one bad line cannot
//   fail a whole batch of 300.
// - Batches run in parallel through a small worker pool sized by the client's
//   `maxConcurrency` (1 when the client does not expose it). Workers take
//   batches in input order, and results are stored by index, so the output
//   order never depends on completion order. The client's own limiter still
//   caps in-flight requests; the pool only bounds how many batches this tool
//   dispatches at once.
// - A failed batch marks each of its parts with that batch's error message and
//   the remaining batches still run, except after an unrecovered rate limit: a
//   FutureApiError with status 429 means the client's retries are exhausted,
//   so no new batch starts. Batches already in flight finish and are reported
//   normally; batches never started are reported as `not_attempted`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FutureApiError, MAX_BATCH_PARTS, validatePartNumber } from "../client.js";
import { PRICING_DISCLAIMER, priceAt, summarizeOffer, type PriceAtResult } from "../format.js";
import type { BatchLookupPart, BatchLookupResponse, Offer } from "../types.js";
import { errorResult, jsonResult, type ClientProvider } from "./common.js";

export const LOOKUP_PARTS_TOOL_NAME = "future_lookup_parts";
export const MAX_LOOKUP_PARTS = 2000;
/** Upper bound for one quantity, so summed quantities stay safe integers. */
export const MAX_QUANTITY = 1_000_000_000;
/** Quantity used for pricing when none was requested. */
export const DEFAULT_QUANTITY = 1;
/** Error text for parts in batches skipped after an unrecovered rate limit. */
export const NOT_ATTEMPTED_MESSAGE =
  "Not attempted: the Future API rate limit was reached. Retry these parts later.";

const partNumberSchema = z
  .string()
  .refine((s) => s.trim() !== "", { message: "Part number must not be empty or whitespace." });

const partItemSchema = z.union([
  partNumberSchema,
  z.object({
    part_number: partNumberSchema,
    quantity: z.number().int().positive().max(MAX_QUANTITY).optional(),
  }),
]);

export const lookupPartsInputShape = {
  parts: z
    .array(partItemSchema)
    .min(1)
    .max(MAX_LOOKUP_PARTS)
    .describe(
      `1-${MAX_LOOKUP_PARTS} manufacturer part numbers. Each item is a string ("LM317T") or ` +
        `{"part_number": "LM317T", "quantity": 500}. Quantity is optional (positive integer) ` +
        "and selects the price break; duplicates are merged and their quantities summed.",
    ),
  raw: z
    .boolean()
    .default(false)
    .describe(
      "Return the untouched upstream batch responses instead of per-part summaries. Much larger; " +
        "use only when a field missing from the summary is needed.",
    ),
};

export type LookupPartsInput = {
  parts: Array<string | { part_number: string; quantity?: number }>;
  raw?: boolean;
};

export const LOOKUP_PARTS_DESCRIPTION =
  "Look up many Future Electronics parts at once, e.g. a whole bill of materials (BOM). " +
  `Accepts up to ${MAX_LOOKUP_PARTS} part numbers, each optionally with a quantity. ` +
  "Part numbers are trimmed and de-duplicated case-insensitively (quantities of duplicates are " +
  `summed), then sent in batches of ${MAX_BATCH_PARTS}, several batches in parallel. ` +
  'Returns one entry per unique part, in input order, with status "found", "not_found", ' +
  '"error" or "not_attempted". For found ' +
  "parts it reports the best offer (the one with the most stock): quantity_available, lead_time, " +
  "and price, the price break that applies at the requested quantity (quantity 1 when none is " +
  'given; price_break is null with a reason such as "below_minimum" when it does not apply). ' +
  "If one batch fails, its parts get the error and the rest are still returned. If the API rate " +
  "limit is still hit after retries, the lookup stops early: batches already running finish, and " +
  'parts in batches not yet started are marked "not_attempted" (retry them later; ' +
  "totals.rate_limited is true). Totals summarize the run. Prices are not an official quote. " +
  "Use the single-part lookup tool for full offer details of one part.";

export type PartStatus = "found" | "not_found" | "error" | "not_attempted";

export interface PartResult {
  part_number: string;
  /** Quantity used for pricing (requested total, or DEFAULT_QUANTITY). */
  quantity: number;
  status: PartStatus;
  offer_count?: number;
  mpn?: string;
  quantity_available?: number;
  lead_time?: string;
  currency_code?: string;
  price?: PriceAtResult;
  error?: string;
}

export interface LookupTotals {
  requested: number;
  unique: number;
  found: number;
  not_found: number;
  errors: number;
  not_attempted: number;
  batches: number;
  /** True when an unrecovered HTTP 429 stopped the lookup early. */
  rate_limited: boolean;
}

interface UniquePart {
  part_number: string;
  quantity?: number;
}

/**
 * Trim and dedupe case-insensitively, keeping first-seen order and spelling.
 * Quantities of duplicates are summed; entries without a quantity add nothing.
 */
export function dedupeParts(parts: LookupPartsInput["parts"]): UniquePart[] {
  const byKey = new Map<string, UniquePart>();
  for (const item of parts) {
    const raw = typeof item === "string" ? item : item.part_number;
    const quantity = typeof item === "string" ? undefined : item.quantity;
    const part_number = raw.trim();
    const key = part_number.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, quantity === undefined ? { part_number } : { part_number, quantity });
    } else if (quantity !== undefined) {
      existing.quantity = (existing.quantity ?? 0) + quantity;
    }
  }
  return [...byKey.values()];
}

/** Split into consecutive chunks of at most `size` items. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError("size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The offer with the most `quantity_available` (missing counts as none); first wins ties. */
export function bestOffer(offers: Offer[]): Offer | undefined {
  let best: Offer | undefined;
  let bestQty = -Infinity;
  for (const offer of offers) {
    const q = offer?.quantities?.quantity_available;
    const qty = typeof q === "number" && Number.isFinite(q) ? q : -1;
    if (best === undefined || qty > bestQty) {
      best = offer;
      bestQty = qty;
    }
  }
  return best;
}

/** Key-free message for a failure (FutureApiError/ConfigError text, else generic). */
function failureMessage(error: unknown): string {
  const first = errorResult(error).content[0];
  return first?.type === "text" ? first.text : "Unexpected error.";
}

/** Find the response entry for a part: by part_number (case-insensitive), else by position. */
function matchResponse(
  resp: BatchLookupResponse,
  partNumber: string,
  index: number,
): BatchLookupPart | undefined {
  const entries = Array.isArray(resp?.lookup_parts) ? resp.lookup_parts : [];
  const key = partNumber.toLowerCase();
  const byName = entries.find(
    (e) => typeof e?.part_number === "string" && e.part_number.trim().toLowerCase() === key,
  );
  if (byName) return byName;
  const positional = entries[index];
  return positional && typeof positional.part_number !== "string" ? positional : undefined;
}

function partResult(part: UniquePart, entry: BatchLookupPart | undefined): PartResult {
  const quantity = part.quantity ?? DEFAULT_QUANTITY;
  const offers = Array.isArray(entry?.offers) ? entry.offers : [];
  const best = bestOffer(offers);
  if (!best) return { part_number: part.part_number, quantity, status: "not_found" };
  const s = summarizeOffer(best);
  const result: PartResult = {
    part_number: part.part_number,
    quantity,
    status: "found",
    offer_count: offers.length,
  };
  if (s.mpn !== undefined) result.mpn = s.mpn;
  if (s.quantity_available !== undefined) result.quantity_available = s.quantity_available;
  if (s.lead_time !== undefined) result.lead_time = s.lead_time;
  if (s.currency_code !== undefined) result.currency_code = s.currency_code;
  result.price = priceAt(best, quantity);
  return result;
}

type RawBatch =
  | { part_numbers: string[]; response: BatchLookupResponse }
  | { part_numbers: string[]; error: string }
  | { part_numbers: string[]; not_attempted: true; error: string };

/** Worker-pool size: the client's maxConcurrency, or 1 when missing or invalid. */
export function poolSize(client: { maxConcurrency?: unknown } | undefined): number {
  const n = client?.maxConcurrency;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : 1;
}

/** True for a rate limit that survived the client's retries. */
function isRateLimit(error: unknown): boolean {
  return error instanceof FutureApiError && error.status === 429;
}

function errorPart(part: UniquePart, message: string, status: PartStatus = "error"): PartResult {
  return {
    part_number: part.part_number,
    quantity: part.quantity ?? DEFAULT_QUANTITY,
    status,
    error: message,
  };
}

/** Run the lookup. Exported for tests; the MCP handler wraps it. */
export async function lookupParts(
  input: LookupPartsInput,
  getClient: ClientProvider,
): Promise<CallToolResult> {
  const unique = dedupeParts(input.parts);
  const results = new Map<string, PartResult>();
  const sendable: UniquePart[] = [];
  for (const part of unique) {
    try {
      validatePartNumber(part.part_number);
      sendable.push(part);
    } catch (error) {
      results.set(part.part_number, errorPart(part, failureMessage(error)));
    }
  }

  let client: ReturnType<ClientProvider> | undefined;
  if (sendable.length > 0) {
    try {
      client = getClient();
    } catch (error) {
      return errorResult(error);
    }
  }

  const chunks = chunk(sendable, MAX_BATCH_PARTS);
  // Index-addressed so output order is input order, not completion order.
  const rawBatches: RawBatch[] = new Array(chunks.length);
  let next = 0;
  let succeeded = 0;
  let rateLimited = false;

  const runBatch = async (index: number): Promise<void> => {
    const group = chunks[index]!;
    const names = group.map((p) => p.part_number);
    try {
      const resp = await client!.batchLookup(names);
      succeeded++;
      rawBatches[index] = { part_numbers: names, response: resp };
      group.forEach((p, i) => {
        results.set(p.part_number, partResult(p, matchResponse(resp, p.part_number, i)));
      });
    } catch (error) {
      // Retries are exhausted by now; stop dispatching new batches.
      if (isRateLimit(error)) rateLimited = true;
      const message = failureMessage(error);
      rawBatches[index] = { part_numbers: names, error: message };
      for (const p of group) results.set(p.part_number, errorPart(p, message));
    }
  };

  const worker = async (): Promise<void> => {
    while (!rateLimited && next < chunks.length) await runBatch(next++);
  };
  const workers = Math.min(poolSize(client), chunks.length);
  await Promise.all(Array.from({ length: workers }, worker));

  chunks.forEach((group, index) => {
    if (rawBatches[index] !== undefined) return;
    const names = group.map((p) => p.part_number);
    rawBatches[index] = { part_numbers: names, not_attempted: true, error: NOT_ATTEMPTED_MESSAGE };
    for (const p of group) {
      results.set(p.part_number, errorPart(p, NOT_ATTEMPTED_MESSAGE, "not_attempted"));
    }
  });

  const parts = unique.map((p) => results.get(p.part_number)!);
  const count = (s: PartStatus) => parts.filter((p) => p.status === s).length;
  const totals: LookupTotals = {
    requested: input.parts.length,
    unique: unique.length,
    found: count("found"),
    not_found: count("not_found"),
    errors: count("error"),
    not_attempted: count("not_attempted"),
    batches: chunks.length,
    rate_limited: rateLimited,
  };

  const sent = new Set(sendable.map((s) => s.part_number));
  const invalid = parts
    .filter((p) => !sent.has(p.part_number))
    .map((p) => ({ part_number: p.part_number, error: p.error }));
  const body = input.raw
    ? {
        note: PRICING_DISCLAIMER,
        totals,
        batches: rawBatches,
        ...(invalid.length > 0 ? { invalid_parts: invalid } : {}),
      }
    : { note: PRICING_DISCLAIMER, totals, parts };

  const result = jsonResult(body);
  // Nothing succeeded: every batch failed or was skipped, or every part was invalid.
  if (succeeded === 0) result.isError = true;
  return result;
}

/** Register `future_lookup_parts` on the server. */
export function registerLookupPartsTool(server: McpServer, getClient: ClientProvider): void {
  server.registerTool(
    LOOKUP_PARTS_TOOL_NAME,
    {
      title: "Future Electronics BOM lookup",
      description: LOOKUP_PARTS_DESCRIPTION,
      inputSchema: lookupPartsInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => lookupParts(args, getClient),
  );
}
