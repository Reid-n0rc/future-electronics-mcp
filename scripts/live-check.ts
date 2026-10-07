// Opt-in live smoke test against the real Future Electronics API.
//
//   FUTURE_API_KEY=… npm run live-check
//
// It looks up LIVE_CHECK_PART once and prints the summarized result, exactly
// as `future_lookup_part` would return it. It is never run by `npm test` or
// CI (vitest only collects tests/**/*.test.ts, and tsconfig only compiles
// src/). The key is read from the environment and never printed.

import { pathToFileURL } from "node:url";
import { FutureClient, redact } from "../src/client.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { errorResult } from "../src/tools/common.js";
import { DEFAULT_MAX_OFFERS, buildLookupPartResult } from "../src/tools/lookupPart.js";

/** Part number used for the live check. */
export const LIVE_CHECK_PART = "292230-6";

export interface LiveCheckOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Run the live check and return the process exit code: 0 on success, 1 on a
 * missing key or any failure. A missing key fails before any network call.
 */
export async function runLiveCheck(options: LiveCheckOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : "Invalid configuration.";
    err(`live-check: ${reason}`);
    err("live-check: set FUTURE_API_KEY in your environment and re-run `npm run live-check`.");
    return 1;
  }

  try {
    const client = new FutureClient({ ...config, fetch: options.fetch });
    const resp = await client.lookup(LIVE_CHECK_PART, "exact");
    const result = buildLookupPartResult(resp, { max_offers: DEFAULT_MAX_OFFERS, raw: false });
    out(`live-check: ${LIVE_CHECK_PART} OK`);
    out(redact(JSON.stringify(result, null, 2), config.apiKey));
    return 0;
  } catch (error) {
    const first = errorResult(error).content[0];
    const message = first?.type === "text" ? first.text : "Unexpected error.";
    err(`live-check: ${LIVE_CHECK_PART} FAILED: ${redact(message, config.apiKey)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runLiveCheck();
}
