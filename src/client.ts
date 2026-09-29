// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj
//
// HTTP client for the two Future Electronics "pim-future" endpoints. The
// endpoint paths, the `x-orbweaver-licensekey` header, the 300-part batch
// limit, and the status-code meanings below come from the docs.
//
// Security: the license key must never surface. Every error message and
// cause produced here passes through `redact()`, and errors thrown by fetch
// are rebuilt (never passed through as-is) so no unredacted text survives.

import type { z } from "zod";
import { ConfigError, DEFAULT_BASE_URL, validateBaseUrl } from "./config.js";
import {
  BatchLookupResponseSchema,
  ErrorResponseSchema,
  LookupTypeSchema,
  PartLookupResponseSchema,
  type BatchLookupResponse,
  type LookupType,
  type PartLookupResponse,
} from "./types.js";

export const LOOKUP_PATH = "/api/v1/pim-future/lookup";
export const BATCH_LOOKUP_PATH = "/api/v1/pim-future/batch/lookup";
export const MAX_BATCH_PARTS = 300;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Retries after the first attempt, so 3 attempts in total. Only 429 is retried. */
export const DEFAULT_MAX_RETRIES = 2;
/** Upper bound for any single wait before a retry, including `Retry-After`. */
export const MAX_RETRY_DELAY_MS = 30_000;
/** First backoff delay when no usable `Retry-After` is sent; doubles per attempt. */
export const BASE_BACKOFF_MS = 1_000;
const MAX_BODY_MESSAGE_LENGTH = 300;
const REDACTED = "[REDACTED]";

/** Friendly messages for the documented error statuses. */
export const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: "Bad request: the Future API rejected the part number or lookup type.",
  401: "Invalid API key: check the FUTURE_API_KEY environment variable.",
  402: "Purchase required: this API key does not include access to this request.",
  403: "Not authorized: this API key is not allowed to make this request.",
  406: "API key expired: request a new key from Future Electronics.",
  429: "Rate limited: too many requests to the Future API. Try again later.",
};

export type FutureApiErrorCode =
  | "invalid_input"
  | "http"
  | "network"
  | "timeout"
  | "invalid_response";

/** Error raised by {@link FutureClient}. Its message never contains the key. */
export class FutureApiError extends Error {
  readonly code: FutureApiErrorCode;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { code: FutureApiErrorCode; status?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FutureApiError";
    this.code = options.code;
    this.status = options.status;
  }
}

/** Replaces every occurrence of `secret` in `text` with `[REDACTED]`. */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

/**
 * Rebuilds an unknown thrown value as a plain Error whose message (and nested
 * causes, up to a small depth) are redacted. The original object is dropped.
 */
export function redactCause(value: unknown, secret: string, depth = 0): Error {
  const source = value instanceof Error ? value : undefined;
  const message = redact(source ? source.message : String(value), secret);
  const nested =
    source?.cause !== undefined && depth < 3
      ? { cause: redactCause(source.cause, secret, depth + 1) }
      : undefined;
  const error = new Error(message, nested);
  error.name = redact(source?.name ?? "Error", secret);
  return error;
}

function invalidInput(message: string): FutureApiError {
  return new FutureApiError(message, { code: "invalid_input" });
}

/**
 * Trims a part number and checks it has at least 3 alphanumeric characters.
 * Punctuation is allowed but does not count toward the minimum.
 */
export function validatePartNumber(value: unknown): string {
  if (typeof value !== "string") throw invalidInput("Part number must be a string.");
  const trimmed = value.trim();
  const alnum = trimmed.match(/[A-Za-z0-9]/g)?.length ?? 0;
  if (alnum < 3) {
    throw invalidInput("Part number must contain at least 3 alphanumeric characters.");
  }
  return trimmed;
}

/** Checks a `lookup_type` against the documented enum. */
export function validateLookupType(value: unknown): LookupType {
  const parsed = LookupTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput(`lookup_type must be one of: ${LookupTypeSchema.options.join(", ")}.`);
  }
  return parsed.data;
}

/** Validates a batch of 1–300 part numbers and returns them trimmed. */
export function validateBatch(parts: unknown): string[] {
  if (!Array.isArray(parts)) throw invalidInput("Parts must be an array of part numbers.");
  if (parts.length === 0) throw invalidInput("Parts must contain at least 1 part number.");
  if (parts.length > MAX_BATCH_PARTS) {
    throw invalidInput(`Parts must contain at most ${MAX_BATCH_PARTS} part numbers.`);
  }
  return parts.map((part, index) => {
    try {
      return validatePartNumber(part);
    } catch (error) {
      throw invalidInput(`Part at index ${index}: ${(error as Error).message}`);
    }
  });
}

/**
 * Delay before the next attempt: `Retry-After` in seconds when it is a valid
 * number, otherwise exponential backoff. Always capped at MAX_RETRY_DELAY_MS.
 */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
  const delay =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

export interface FutureClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt on HTTP 429. Default 2 (3 attempts total). */
  maxRetries?: number;
}

interface RawResponse {
  status: number;
  ok: boolean;
  retryAfter: string | null;
  text: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FutureClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(options: FutureClientOptions) {
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
    if (!apiKey) throw new ConfigError("FutureClient requires a non-empty apiKey.");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ConfigError("timeoutMs must be a positive number.");
    }
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new ConfigError("maxRetries must be a non-negative integer.");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#maxRetries = maxRetries;
  }

  /** GET /lookup. `lookup_type` is sent only when provided. */
  async lookup(partNumber: string, lookupType?: LookupType): Promise<PartLookupResponse> {
    const url = new URL(this.#baseUrl + LOOKUP_PATH);
    url.searchParams.set("part_number", validatePartNumber(partNumber));
    if (lookupType !== undefined) {
      url.searchParams.set("lookup_type", validateLookupType(lookupType));
    }
    return this.#request(url, { method: "GET" }, PartLookupResponseSchema, "lookup");
  }

  /** POST /batch/lookup with `{ parts }`. Validated before any network call. */
  async batchLookup(parts: string[]): Promise<BatchLookupResponse> {
    const body = JSON.stringify({ parts: validateBatch(parts) });
    const url = new URL(this.#baseUrl + BATCH_LOOKUP_PATH);
    return this.#request(url, { method: "POST", body }, BatchLookupResponseSchema, "batch lookup");
  }

  async #request<S extends z.ZodTypeAny>(
    url: URL,
    init: { method: string; body?: string },
    schema: S,
    label: string,
  ): Promise<z.infer<S>> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.#send(url, init);
      if (res.ok) return this.#parseSuccess(res.text, schema, label);
      if (res.status === 429 && attempt <= this.#maxRetries) {
        await this.#sleep(retryDelayMs(res.retryAfter, attempt));
        continue;
      }
      throw this.#httpError(res);
    }
  }

  async #send(url: URL, init: { method: string; body?: string }): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(url, {
        method: init.method,
        body: init.body,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-orbweaver-licensekey": this.#apiKey,
        },
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, retryAfter: res.headers.get("retry-after"), text };
    } catch (error) {
      const cause = redactCause(error, this.#apiKey);
      if (controller.signal.aborted) {
        throw new FutureApiError(
          `Timed out after ${this.#timeoutMs} ms waiting for the Future API.`,
          { code: "timeout", cause },
        );
      }
      throw new FutureApiError(`Network error contacting the Future API: ${cause.message}`, {
        code: "network",
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #parseSuccess<S extends z.ZodTypeAny>(text: string, schema: S, label: string): z.infer<S> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FutureApiError(
        `Unexpected response shape from the Future API (${label}): body is not valid JSON.`,
        { code: "invalid_response" },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "(root)";
      const detail = redact(`${where}: ${issue?.message ?? "invalid"}`, this.#apiKey);
      throw new FutureApiError(
        `Unexpected response shape from the Future API (${label}): ${detail}.`,
        { code: "invalid_response" },
      );
    }
    return parsed.data;
  }

  #httpError(res: RawResponse): FutureApiError {
    const base =
      STATUS_MESSAGES[res.status] ?? `Future API request failed with HTTP ${res.status}.`;
    let detail: string | undefined;
    try {
      const parsed = ErrorResponseSchema.safeParse(JSON.parse(res.text));
      if (parsed.success) detail = parsed.data.message ?? parsed.data.error ?? undefined;
    } catch {
      // Non-JSON error body: fall back to the status message alone.
    }
    // Redact before truncating so a key cut in half cannot slip through.
    if (detail) detail = redact(detail, this.#apiKey);
    if (detail && detail.length > MAX_BODY_MESSAGE_LENGTH) {
      detail = `${detail.slice(0, MAX_BODY_MESSAGE_LENGTH)}…`;
    }
    const message = detail ? `${base} API message: ${detail}` : base;
    return new FutureApiError(message, {
      code: "http",
      status: res.status,
    });
  }
}
