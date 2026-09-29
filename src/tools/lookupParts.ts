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
// - Batches are sent sequentially (never in parallel) to avoid HTTP 429s. A
//   failed batch marks each of its parts with that batch's error message and
//   the remaining batches still run.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MAX_BATCH_PARTS, validatePartNumber } from "../client.js";
import { PRICING_DISCLAIMER, priceAt, summarizeOffer, type PriceAtResult } from "../format.js";
import type { BatchLookupPart, BatchLookupResponse, Offer } from "../types.js";
import { errorResult, jsonResult, type ClientProvider } from "./common.js";

export const LOOKUP_PARTS_TOOL_NAME = "future_lookup_parts";
export const MAX_LOOKUP_PARTS = 2000;
/** Upper bound for one quantity, so summed quantities stay safe integers. */
export const MAX_QUANTITY = 1_000_000_000;
/** Quantity used for pricing when none was requested. */
export const DEFAULT_QUANTITY = 1;

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
  `summed), then sent in batches of ${MAX_BATCH_PARTS}. ` +
  'Returns one entry per unique part with status "found", "not_found" or "error". For found ' +
  "parts it reports the best offer (the one with the most stock): quantity_available, lead_time, " +
  "and price, the price break that applies at the requested quantity (quantity 1 when none is " +
  'given; price_break is null with a reason such as "below_minimum" when it does not apply). ' +
  "If one batch fails, its parts get the error and the rest are still returned. Totals summarize " +
  "the run. Prices are not an official quote. Use the single-part lookup tool for full offer " +
  "details of one part.";

export type PartStatus = "found" | "not_found" | "error";

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
  batches: number;
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
  | { part_numbers: string[]; error: string };

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
      results.set(part.part_number, {
        part_number: part.part_number,
        quantity: part.quantity ?? DEFAULT_QUANTITY,
        status: "error",
        error: failureMessage(error),
      });
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
  const rawBatches: RawBatch[] = [];
  let succeeded = 0;
  for (const group of chunks) {
    const names = group.map((p) => p.part_number);
    try {
      // Sequential on purpose: parallel batches invite HTTP 429.
      const resp = await client!.batchLookup(names);
      succeeded++;
      rawBatches.push({ part_numbers: names, response: resp });
      group.forEach((p, i) => {
        results.set(p.part_number, partResult(p, matchResponse(resp, p.part_number, i)));
      });
    } catch (error) {
      const message = failureMessage(error);
      rawBatches.push({ part_numbers: names, error: message });
      for (const p of group) {
        results.set(p.part_number, {
          part_number: p.part_number,
          quantity: p.quantity ?? DEFAULT_QUANTITY,
          status: "error",
          error: message,
        });
      }
    }
  }

  const parts = unique.map((p) => results.get(p.part_number)!);
  const count = (s: PartStatus) => parts.filter((p) => p.status === s).length;
  const totals: LookupTotals = {
    requested: input.parts.length,
    unique: unique.length,
    found: count("found"),
    not_found: count("not_found"),
    errors: count("error"),
    batches: chunks.length,
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
  // Nothing succeeded: every batch failed, or every part was invalid.
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
