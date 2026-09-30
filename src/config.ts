// Runtime configuration for the Future Electronics API client.
//
// The license key comes only from the environment (see SECURITY.md). Errors
// raised here never include the key or the configured base URL, so a
// misconfiguration cannot leak a secret into logs.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Default origin of the Future Electronics API. */
export const DEFAULT_BASE_URL = "https://api.futureelectronics.com";

/** Resolved client configuration. */
export interface FutureConfig {
  apiKey: string;
  baseUrl: string;
  /** Most requests in flight to the Future API at once (`FUTURE_MAX_CONCURRENCY`). */
  maxConcurrency: number;
  /** Minimum gap between request starts in ms (`FUTURE_MIN_REQUEST_INTERVAL_MS`). */
  minRequestIntervalMs: number;
}

/** `FUTURE_MAX_CONCURRENCY` default and allowed range. */
export const MAX_CONCURRENCY_DEFAULT = 4;
export const MAX_CONCURRENCY_MIN = 1;
export const MAX_CONCURRENCY_MAX = 32;
/** `FUTURE_MIN_REQUEST_INTERVAL_MS` default (no pacing) and allowed range. */
export const MIN_REQUEST_INTERVAL_DEFAULT_MS = 0;
export const MIN_REQUEST_INTERVAL_MAX_MS = 60_000;

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
  const maxConcurrency = parseIntSetting(
    env.FUTURE_MAX_CONCURRENCY,
    "FUTURE_MAX_CONCURRENCY",
    MAX_CONCURRENCY_DEFAULT,
    MAX_CONCURRENCY_MIN,
    MAX_CONCURRENCY_MAX,
  );
  const minRequestIntervalMs = parseIntSetting(
    env.FUTURE_MIN_REQUEST_INTERVAL_MS,
    "FUTURE_MIN_REQUEST_INTERVAL_MS",
    MIN_REQUEST_INTERVAL_DEFAULT_MS,
    0,
    MIN_REQUEST_INTERVAL_MAX_MS,
  );
  return { apiKey, baseUrl, maxConcurrency, minRequestIntervalMs };
}

/**
 * Parses an optional integer setting. Unset or blank means `fallback`. The
 * error names the variable and range but never echoes the raw value.
 */
export function parseIntSetting(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

/** Folder name of the default workspace (issue #40). */
export const WORKSPACE_FOLDER_NAME = "Future Electronics MCP";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The default workspace folder: `~/Documents/Future Electronics MCP`, or
 * `~/Future Electronics MCP` when there is no Documents folder. It only
 * computes the path; nothing is created here.
 */
export function defaultWorkspaceDir(home: string = homedir()): string {
  const documents = join(home, "Documents");
  return join(isDirectory(documents) ? documents : home, WORKSPACE_FOLDER_NAME);
}

/**
 * Reads `FUTURE_WORKSPACE_DIR` (optional, must be an absolute path) and
 * returns the workspace folder, or {@link defaultWorkspaceDir} when unset.
 * An empty value, or an installer placeholder left unsubstituted such as
 * `${user_config.workspace_dir}`, counts as unset. Errors never echo the value.
 */
export function loadWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const raw = env.FUTURE_WORKSPACE_DIR?.trim();
  if (!raw || /^\$\{[^}]*\}$/.test(raw)) return defaultWorkspaceDir(home);
  if (raw.includes("\0")) {
    throw new ConfigError("FUTURE_WORKSPACE_DIR must not contain a NUL byte.");
  }
  if (!isAbsolute(raw)) {
    throw new ConfigError("FUTURE_WORKSPACE_DIR must be an absolute path.");
  }
  return resolve(raw);
}
