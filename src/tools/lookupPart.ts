// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj
//
// MCP tool `future_lookup_part`: single-part lookup via GET /lookup. The
// `lookup_type` values and the 3-character part number minimum come from the
// docs; the client re-validates both before any network call.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PRICING_DISCLAIMER,
  priceAt,
  summarizeLookup,
  type LookupSummary,
  type OfferSummary,
  type PriceAtResult,
} from "../format.js";
import type { Offer, PartLookupResponse } from "../types.js";
import { LookupTypeSchema } from "../types.js";
import { errorResult, jsonResult, type ClientProvider } from "./common.js";

export const LOOKUP_PART_TOOL_NAME = "future_lookup_part";
export const DEFAULT_MAX_OFFERS = 10;
export const MAX_MAX_OFFERS = 50;

export const LOOKUP_PART_DESCRIPTION = [
  "Look up one electronic component in the Future Electronics catalog by manufacturer part number (MPN).",
  "Returns a compact JSON summary: lookup_value, lookup_results, total_offers (offers found before truncation), and up to max_offers offers.",
  "Each offer lists MPN, Future part number, product URL, stock (quantity_available, quantity_on_order), minimum and order multiple, lead time, currency, price breaks, package type, MPQ, RoHS, date code, and datasheet URL when known.",
  "When quantity is given, each offer also has price_at_quantity: the price break that applies to that quantity, or a reason there is none (below_minimum, no_pricing, no_matching_break).",
  `Pricing matches the Future website and is NOT an official quote: ${PRICING_DISCLAIMER}`,
  "lookup_type defaults to exact, which matches the full part number. Use starts_with when you know only the beginning of the MPN (for example a base part without its packaging or temperature suffix), and contains when you know a fragment from the middle. Those return more, less precise offers, so check the mpn of each result.",
  "Set raw to true only when you need upstream fields the summary omits; it returns the untouched API response (offers still truncated to max_offers) and ignores quantity.",
  "For many parts at once, use future_lookup_parts instead.",
].join(" ");

export const lookupPartInputShape = {
  part_number: z
    .string()
    .min(3)
    .describe("Manufacturer part number, at least 3 alphanumeric characters."),
  lookup_type: LookupTypeSchema.default("exact").describe(
    "Match mode: exact (default), starts_with, contains, or default (the API's own default).",
  ),
  quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional order quantity; reports the applicable price break per offer."),
  max_offers: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_OFFERS)
    .default(DEFAULT_MAX_OFFERS)
    .describe(`Maximum offers to return, 1-${MAX_MAX_OFFERS} (default ${DEFAULT_MAX_OFFERS}).`),
  raw: z
    .boolean()
    .default(false)
    .describe("Return the untouched upstream response instead of the summary."),
};

const LookupPartInputSchema = z.object(lookupPartInputShape);
export type LookupPartInput = z.infer<typeof LookupPartInputSchema>;

export type LookupPartOffer = OfferSummary & { price_at_quantity?: PriceAtResult };

export interface LookupPartResult extends Omit<LookupSummary, "offers"> {
  total_offers: number;
  quantity?: number;
  offers: LookupPartOffer[];
}

const rawOffers = (resp: PartLookupResponse): unknown[] =>
  Array.isArray(resp?.offers) ? resp.offers : [];

/**
 * Build the tool output from an upstream response. Pure, so it is testable
 * without the MCP plumbing. `raw` returns the upstream object with only its
 * `offers` array truncated.
 */
export function buildLookupPartResult(
  resp: PartLookupResponse,
  input: Pick<LookupPartInput, "max_offers" | "raw" | "quantity">,
): LookupPartResult | PartLookupResponse {
  const all = rawOffers(resp);
  const kept = all.slice(0, input.max_offers);
  if (input.raw) {
    return Array.isArray(resp?.offers) ? { ...resp, offers: kept as Offer[] } : resp;
  }
  const summary = summarizeLookup({ ...resp, offers: kept as Offer[] });
  const { offers, ...rest } = summary;
  const result: LookupPartResult = { ...rest, total_offers: all.length, offers };
  if (input.quantity !== undefined) {
    const qty = input.quantity;
    result.quantity = qty;
    result.offers = offers.map((offer, i) => ({
      ...offer,
      price_at_quantity: priceAt(kept[i] as Offer, qty),
    }));
  }
  return result;
}

/** Register `future_lookup_part` on the server. */
export function registerLookupPartTool(server: McpServer, getClient: ClientProvider): void {
  server.registerTool(
    LOOKUP_PART_TOOL_NAME,
    {
      title: "Future Electronics part lookup",
      description: LOOKUP_PART_DESCRIPTION,
      inputSchema: lookupPartInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const resp = await getClient().lookup(input.part_number, input.lookup_type);
        return jsonResult(buildLookupPartResult(resp, input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
