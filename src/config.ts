// Runtime configuration for the Future Electronics API client.
//
// The license key comes only from the environment (see SECURITY.md). Errors
// raised here never include the key or the configured base URL, so a
// misconfiguration cannot leak a secret into logs.

/** Default origin of the Future Electronics API. */
export const DEFAULT_BASE_URL = "https://api.futureelectronics.com";

/** Resolved client configuration. */
export interface FutureConfig {
  apiKey: string;
  baseUrl: string;
}

/** Raised for missing or invalid configuration. Never contains the key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validates a base URL and returns it without a trailing slash. Only https is
 * accepted so the license key is never sent over plain http. URLs with
 * embedded credentials, a query, or a fragment are rejected.
 */
export function validateBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("Future API base URL must be a non-empty string.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError("Future API base URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("Future API base URL must use https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      "Future API base URL must not contain credentials, a query, or a fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Reads `FUTURE_API_KEY` (required) and `FUTURE_API_BASE_URL` (optional,
 * defaults to {@link DEFAULT_BASE_URL}) from `env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FutureConfig {
  const apiKey = env.FUTURE_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "FUTURE_API_KEY is not set. Export your Future Electronics license key " +
        "in the environment (see SECURITY.md).",
    );
  }
  const rawBase = env.FUTURE_API_BASE_URL?.trim();
  const baseUrl = validateBaseUrl(rawBase ? rawBase : DEFAULT_BASE_URL);
  return { apiKey, baseUrl };
}
