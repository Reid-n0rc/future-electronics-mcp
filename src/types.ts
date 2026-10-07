// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj
//
// Zod schemas and inferred types for the Future Electronics Product
// Information API ("pim-future") responses.
//
// Endpoints:
//   GET  /api/v1/pim-future/lookup?part_number=...&lookup_type=...  -> PartLookupResponse
//   POST /api/v1/pim-future/batch/lookup  { "parts": [...] }        -> BatchLookupResponse
//   Errors (4xx)                                                    -> ErrorResponse
//
// Design notes:
// - Schemas are lenient. The docs show nulls and mixed types, so almost every
//   field is `.optional().nullable()`, and every object uses `.passthrough()`
//   so fields the docs do not list survive parsing.
// - The one structural requirement is the `offers` array (and `lookup_parts`
//   for batch). A lookup with no matches returns `offers: []` ("0 Offers
//   found"), so a response without an `offers` array is malformed and is
//   rejected rather than silently treated as "no offers".

import { z } from "zod";

/** Optional and nullable: the field may be missing or `null`. */
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.optional().nullable();

/** `lookup_type` request parameter. Strict: only these values may be sent. */
export const LookupTypeSchema = z.enum(["default", "exact", "contains", "starts_with"]);
export type LookupType = z.infer<typeof LookupTypeSchema>;

/** `_orbweaver_data`: properties internal to Orbweaver (e.g. `datasource_name`). */
export const OrbweaverDataSchema = z
  .object({
    datasource_name: opt(z.string()),
  })
  .passthrough();
export type OrbweaverData = z.infer<typeof OrbweaverDataSchema>;

/** `part_id`: identifies the part for an offer. */
export const PartIdSchema = z
  .object({
    /** Seller part number (SKU). */
    seller_part_number: opt(z.string()),
    /** Customer part number (CPN), only for the requesting contract customer. */
    buyer_part_number: opt(z.string()),
    /** Documented as a string (e.g. "1 oz"); example responses return a number. */
    unit_weight: opt(z.union([z.number(), z.string()])),
    /** Link to the part on futureelectronics.com (docs table spells it `web_ur`). */
    web_url: opt(z.string()),
    /** Manufacturer part number. */
    mpn: opt(z.string()),
  })
  .passthrough();
export type PartId = z.infer<typeof PartIdSchema>;

/**
 * `part_attributes[]`: name/value pairs. Values are strings, numbers,
 * booleans (e.g. `web_view`) or null (e.g. `dateCode`).
 */
export const PartAttributeSchema = z
  .object({
    name: opt(z.string()),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .passthrough();
export type PartAttribute = z.infer<typeof PartAttributeSchema>;

/** `categories[]`. */
export const CategorySchema = z
  .object({
    id: opt(z.string()),
    name: opt(z.string()),
    subcategory_name: opt(z.string()),
  })
  .passthrough();
export type Category = z.infer<typeof CategorySchema>;

/** `documents[]`: every field is documented as optional. */
export const DocumentSchema = z
  .object({
    type: opt(z.string()),
    subtype: opt(z.string()),
    title: opt(z.string()),
    file_name: opt(z.string()),
    revision: opt(z.string()),
    format: opt(z.string()),
    language: opt(z.string()),
    url: opt(z.string()),
    publish_date: opt(z.string()),
    last_update: opt(z.string()),
  })
  .passthrough();
export type Document = z.infer<typeof DocumentSchema>;

/** `images[]`. */
export const ImageSchema = z
  .object({
    url: opt(z.string()),
    type: opt(z.string()),
  })
  .passthrough();
export type Image = z.infer<typeof ImageSchema>;

/** `quantities`: inventory and ordering constraints for an offer. */
export const QuantitiesSchema = z
  .object({
    quantity_available: opt(z.number()),
    quantity_factory: opt(z.number()),
    /** Minimum order quantity. */
    quantity_minimum: opt(z.number()),
    /** Pieces on bond allocation to the customer. */
    quantity_committed: opt(z.number()),
    quantity_on_order: opt(z.number()),
    /** Lead time in units, or "CALL" when lead time is extended. */
    factory_leadtime: opt(z.string()),
    /** e.g. "Weeks". */
    factory_leadtime_units: opt(z.string()),
    /** Order multiple. */
    order_mult_qty: opt(z.number()),
  })
  .passthrough();
export type Quantities = z.infer<typeof QuantitiesSchema>;

/** `pricing[]`: one price break. `quantity_to` is null when there is no maximum. */
export const PriceBreakSchema = z
  .object({
    unit_price: opt(z.number()),
    quantity_from: opt(z.number()),
    quantity_to: opt(z.number()),
  })
  .passthrough();
export type PriceBreak = z.infer<typeof PriceBreakSchema>;

/** `people_and_places`: the API user's billTo id (contract only) and site region. */
export const PeopleAndPlacesSchema = z
  .object({
    buyer_address_id: opt(z.string()),
    /** "NA", "EU" or "Asia". */
    site: opt(z.string()),
  })
  .passthrough();
export type PeopleAndPlaces = z.infer<typeof PeopleAndPlacesSchema>;

/** `currency`. */
export const CurrencySchema = z
  .object({
    /** 3-character currency code, e.g. "USD". */
    currency_code: opt(z.string()),
  })
  .passthrough();
export type Currency = z.infer<typeof CurrencySchema>;

/** One offer for a part. */
export const OfferSchema = z
  .object({
    _orbweaver_data: opt(OrbweaverDataSchema),
    part_id: opt(PartIdSchema),
    part_attributes: opt(z.array(PartAttributeSchema)),
    categories: opt(z.array(CategorySchema)),
    documents: opt(z.array(DocumentSchema)),
    images: opt(z.array(ImageSchema)),
    quantities: opt(QuantitiesSchema),
    pricing: opt(z.array(PriceBreakSchema)),
    people_and_places: opt(PeopleAndPlacesSchema),
    /** "Web", "Preferred" or "Contract" (kept as a string; the docs disagree on the set). */
    pricing_type: opt(z.string()),
    currency: opt(CurrencySchema),
    /** Bonded inventory marker: "FUTA", "FUTI", "FUTE", "FUTC", or null. */
    internal1: opt(z.string()),
  })
  .passthrough();
export type Offer = z.infer<typeof OfferSchema>;

/** Response of the single-part lookup (GET /lookup). */
export const PartLookupResponseSchema = z
  .object({
    /** Echo of the requested part number. */
    lookup_value: opt(z.string()),
    /** Echo of the requested lookup type. */
    // Response echo is lenient: an unexpected value/casing must not break parsing.
    lookup_type: opt(z.string()),
    /** Summary message, e.g. "1 Offer found". */
    lookup_results: opt(z.string()),
    /** Required. Empty when nothing matched. */
    offers: z.array(OfferSchema),
  })
  .passthrough();
export type PartLookupResponse = z.infer<typeof PartLookupResponseSchema>;

/** One entry of a batch lookup. */
export const BatchLookupPartSchema = z
  .object({
    part_number: opt(z.string()),
    lookup_results: opt(z.string()),
    /** Required. Empty when nothing matched. */
    offers: z.array(OfferSchema),
  })
  .passthrough();
export type BatchLookupPart = z.infer<typeof BatchLookupPartSchema>;

/** Response of the batch lookup (POST /batch/lookup). */
export const BatchLookupResponseSchema = z
  .object({
    lookup_parts: z.array(BatchLookupPartSchema),
  })
  .passthrough();
export type BatchLookupResponse = z.infer<typeof BatchLookupResponseSchema>;

/**
 * Error body. The docs show `status` as a string ("bad_request") and as a
 * number (401), and one 400 example has `error` instead of `message`, so
 * only `status` is required.
 */
export const ErrorResponseSchema = z
  .object({
    message: opt(z.string()),
    status: z.union([z.string(), z.number()]),
    error: opt(z.string()),
  })
  .passthrough();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
