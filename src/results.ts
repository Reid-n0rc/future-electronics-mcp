// In-memory store for BOM lookup results (issue #42).
//
// `future_lookup_parts` saves its full per-part results and raw batch
// responses here under a random, unguessable `result_id`, so
// `future_query_results` (and later exports) can read any subset without
// calling the Future API again. Nothing is written to disk. An entry expires
// RESULT_TTL_MS after it was last stored or read, and at most
// MAX_STORED_RESULTS entries are kept: storing one more evicts the least
// recently used.

import { randomUUID } from "node:crypto";
import type { LookupTotals, PartResult, RawBatch } from "./tools/lookupParts.js";

/** Entries expire this long after their last access (60 minutes). */
export const RESULT_TTL_MS = 60 * 60 * 1000;
/** Most results kept at once; the least recently used is evicted first. */
export const MAX_STORED_RESULTS = 20;

/** Everything one BOM lookup produced, kept as structured data. */
export interface StoredResult {
  /** Every unique part, in input order (not only the problem parts). */
  parts: PartResult[];
  /** Untouched upstream batch responses (or per-batch errors), in input order. */
  batches: RawBatch[];
  totals: LookupTotals;
  /** Clock time when the result was stored. */
  created_at: number;
}

export interface ResultStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
  /** Id generator; injectable for tests. Defaults to crypto.randomUUID. */
  newId?: () => string;
}

/** Error text for an id that is unknown, expired, or evicted. */
export function unknownResultMessage(id: string): string {
  return (
    `Unknown or expired result_id "${id}". Results are kept in memory for ` +
    `${RESULT_TTL_MS / 60_000} minutes after last use (at most ${MAX_STORED_RESULTS}, least ` +
    "recently used evicted first) and are lost when the server restarts. Run " +
    "future_lookup_parts again to get a new result_id."
  );
}

export class ResultStore {
  private readonly entries = new Map<string, { value: StoredResult; lastAccess: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: ResultStoreOptions = {}) {
    const { ttlMs = RESULT_TTL_MS, maxEntries = MAX_STORED_RESULTS } = options;
    if (!(ttlMs > 0)) throw new RangeError("ttlMs must be positive");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  /** Number of live (unexpired) entries. */
  get size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  /** Store a result and return its new id, evicting the least recently used if full. */
  put(data: Omit<StoredResult, "created_at">): string {
    this.purgeExpired();
    let id = this.newId();
    while (this.entries.has(id)) id = this.newId();
    const t = this.now();
    this.entries.set(id, { value: { ...data, created_at: t }, lastAccess: t });
    while (this.entries.size > this.maxEntries) {
      // Map order is access order, so the first key is the least recently used.
      this.entries.delete(this.entries.keys().next().value!);
    }
    return id;
  }

  /** The stored result, or undefined when unknown or expired. Refreshes its TTL and LRU position. */
  get(id: string): StoredResult | undefined {
    this.purgeExpired();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastAccess = this.now();
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }

  private purgeExpired(): void {
    const t = this.now();
    for (const [id, entry] of this.entries) {
      if (t - entry.lastAccess >= this.ttlMs) this.entries.delete(id);
    }
  }
}

/** The process-wide store shared by the lookup and query tools. */
export const defaultResultStore = new ResultStore();
