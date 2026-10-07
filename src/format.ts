// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj
//
// Compact, LLM-friendly summaries of Future Electronics offers.
//
// Design notes:
// - Every upstream field may be missing or null, so nothing here throws on
//   sparse data. Only `priceAt` throws, and only for an invalid `qty` argument.
// - Output objects are plain JSON with a stable key order. Null, missing and
//   empty fields are omitted to keep tool output small.
// - A price break with no `to` is open-ended (upstream `quantity_to: null`).

import type {
  BatchLookupResponse,
  Offer,
  PartAttribute,
  PartLookupResponse,
  PriceBreak,
  Quantities,
} from "./types.js";

/** Disclaimer attached to every lookup and batch summary. */
export const PRICING_DISCLAIMER =
  "Pricing is not an official quote. Confirm price and availability with Future Electronics before ordering.";

/** One price break. `to` is omitted when the break has no upper bound. */
export interface PriceBreakSummary {
  from: number;
  to?: number;
  unit_price: number;
}

/** Compact view of one offer. Every field is optional because upstream data is sparse. */
export interface OfferSummary {
  mpn?: string;
  seller_part_number?: string;
  web_url?: string;
  quantity_available?: number;
  quantity_on_order?: number;
  quantity_minimum?: number;
  order_mult_qty?: number;
  /** e.g. "12 Weeks", or "CALL" when the lead time is extended. */
  lead_time?: string;
  currency_code?: string;
  pricing_type?: string;
  /** Sorted by `from`, ascending. */
  price_breaks?: PriceBreakSummary[];
  package_type?: AttributeValue;
  mpq?: AttributeValue;
  rohs?: AttributeValue;
  date_code?: AttributeValue;
  datasheet_url?: string;
  image_urls?: string[];
}

export type AttributeValue = string | number | boolean;

export interface SummarizeOptions {
  /** Include image URLs (off by default to keep output small). */
  images?: boolean;
}

export interface SummarizeResponseOptions extends SummarizeOptions {
  /** Return the upstream response untouched instead of a summary. */
  raw?: boolean;
}

export interface LookupSummary {
  lookup_value?: string;
  lookup_results?: string;
  note: string;
  offers: OfferSummary[];
}

export interface BatchPartSummary {
  part_number?: string;
  lookup_results?: string;
  offers: OfferSummary[];
}

export interface BatchSummary {
  note: string;
  parts: BatchPartSummary[];
}

export type PriceAtResult =
  | { price_break: PriceBreakSummary }
  | { price_break: null; reason: "below_minimum"; quantity_minimum: number }
  | { price_break: null; reason: "no_pricing" | "no_matching_break" };

/** Upstream attribute names mapped to summary keys, in output order. */
const KEY_ATTRIBUTES = [
  ["packageType", "package_type"],
  ["mpq", "mpq"],
  ["rohs", "rohs"],
  ["dateCode", "date_code"],
] as const;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Copy only the defined entries, preserving insertion order. */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

/** Valid price breaks (numeric `from` and `unit_price`), sorted by `from`. */
function priceBreaks(offer: Offer | null | undefined): PriceBreakSummary[] {
  const breaks: PriceBreakSummary[] = [];
  for (const b of arr<PriceBreak | null>(offer?.pricing)) {
    if (!isObject(b)) continue;
    const from = num(b.quantity_from);
    const unit_price = num(b.unit_price);
    if (from === undefined || unit_price === undefined) continue;
    breaks.push(compact({ from, to: num(b.quantity_to), unit_price }));
  }
  return breaks.sort((a, b) => a.from - b.from);
}

/** Value of the first attribute with this name, or undefined if absent, null or empty. */
function attribute(offer: Offer, name: string): AttributeValue | undefined {
  const attr = arr<PartAttribute | null>(offer.part_attributes).find(
    (a) => isObject(a) && a.name === name,
  );
  const v = attr?.value;
  if (typeof v === "string") return str(v);
  if (typeof v === "boolean") return v;
  return num(v);
}

/** URL of the first document typed "datasheet" (case-insensitive) that has a URL. */
function datasheetUrl(offer: Offer): string | undefined {
  for (const d of arr(offer.documents)) {
    if (!isObject(d)) continue;
    const type = str(d.type)?.trim().toLowerCase();
    const url = str(d.url);
    if (type === "datasheet" && url) return url;
  }
  return undefined;
}

/** Lead time plus units, e.g. "12 Weeks"; "CALL" passes through. */
function leadTime(q: Quantities | undefined): string | undefined {
  const lt = str(q?.factory_leadtime)?.trim();
  if (!lt) return undefined;
  if (lt.toUpperCase() === "CALL") return "CALL";
  const units = str(q?.factory_leadtime_units)?.trim();
  return units ? `${lt} ${units}` : lt;
}

/** Summarize one offer. Never throws, even for null or empty input. */
export function summarizeOffer(
  offer: Offer | null | undefined,
  options: SummarizeOptions = {},
): OfferSummary {
  if (!isObject(offer)) return {};
  const o = offer as Offer;
  const partId = isObject(o.part_id) ? o.part_id : undefined;
  const q = isObject(o.quantities) ? o.quantities : undefined;
  const currency = isObject(o.currency) ? o.currency : undefined;

  const summary: OfferSummary = {
    mpn: str(partId?.mpn),
    seller_part_number: str(partId?.seller_part_number),
    web_url: str(partId?.web_url),
    quantity_available: num(q?.quantity_available),
    quantity_on_order: num(q?.quantity_on_order),
    quantity_minimum: num(q?.quantity_minimum),
    order_mult_qty: num(q?.order_mult_qty),
    lead_time: leadTime(q),
    currency_code: str(currency?.currency_code),
    pricing_type: str(o.pricing_type),
    price_breaks: priceBreaks(o),
  };
  for (const [name, key] of KEY_ATTRIBUTES) summary[key] = attribute(o, name);
  summary.datasheet_url = datasheetUrl(o);
  if (options.images) {
    summary.image_urls = arr(o.images)
      .map((img) => (isObject(img) ? str(img.url) : undefined))
      .filter((u): u is string => u !== undefined);
  }
  return compact(summary);
}

const summarizeOffers = (offers: unknown, options: SummarizeOptions): OfferSummary[] =>
  arr(offers as Offer[]).map((o) => summarizeOffer(o, options));

/** Summarize a single-part lookup response, or return it untouched with `raw: true`. */
export function summarizeLookup(
  resp: PartLookupResponse,
  options: SummarizeResponseOptions & { raw: true },
): PartLookupResponse;
export function summarizeLookup(
  resp: PartLookupResponse,
  options?: SummarizeResponseOptions,
): LookupSummary;
export function summarizeLookup(
  resp: PartLookupResponse,
  options: SummarizeResponseOptions = {},
): LookupSummary | PartLookupResponse {
  if (options.raw) return resp;
  const r = isObject(resp) ? resp : undefined;
  return {
    ...compact({ lookup_value: str(r?.lookup_value), lookup_results: str(r?.lookup_results) }),
    note: PRICING_DISCLAIMER,
    // Kept even when empty: "no offers" is a meaningful result.
    offers: summarizeOffers(r?.offers, options),
  };
}

/** Summarize a batch lookup response, or return it untouched with `raw: true`. */
export function summarizeBatch(
  resp: BatchLookupResponse,
  options: SummarizeResponseOptions & { raw: true },
): BatchLookupResponse;
export function summarizeBatch(
  resp: BatchLookupResponse,
  options?: SummarizeResponseOptions,
): BatchSummary;
export function summarizeBatch(
  resp: BatchLookupResponse,
  options: SummarizeResponseOptions = {},
): BatchSummary | BatchLookupResponse {
  if (options.raw) return resp;
  const parts = arr(isObject(resp) ? resp.lookup_parts : undefined)
    .filter(isObject)
    .map((p) => ({
      ...compact({ part_number: str(p.part_number), lookup_results: str(p.lookup_results) }),
      offers: summarizeOffers(p.offers, options),
    }));
  return { note: PRICING_DISCLAIMER, parts };
}

/**
 * The price break that applies to `qty`: `from <= qty` and (`to` is open or
 * `qty <= to`). Breaks need not be sorted; if several match, the one with the
 * highest `from` wins. Throws RangeError unless `qty` is a positive integer.
 */
export function priceAt(offer: Offer | null | undefined, qty: number): PriceAtResult {
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new RangeError(`qty must be a positive integer, got ${String(qty)}`);
  }
  const breaks = priceBreaks(isObject(offer) ? offer : undefined);
  if (breaks.length === 0) return { price_break: null, reason: "no_pricing" };
  const lowest = breaks[0]!.from;
  if (qty < lowest) {
    return { price_break: null, reason: "below_minimum", quantity_minimum: lowest };
  }
  let match: PriceBreakSummary | undefined;
  for (const b of breaks) {
    if (b.from <= qty && (b.to === undefined || qty <= b.to)) match = b;
  }
  return match ? { price_break: match } : { price_break: null, reason: "no_matching_break" };
}
