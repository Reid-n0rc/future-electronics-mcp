#!/usr/bin/env node
// Mints a GitHub App installation token so agent pushes and PRs are authored
// by the private App (issue #49). Prints ONLY the token to stdout; errors go to
// stderr and never include key material or tokens.
//
// Inputs (env): FUTURE_AGENT_APP_ID, FUTURE_AGENT_INSTALLATION_ID, and
// FUTURE_AGENT_PRIVATE_KEY (PEM) or FUTURE_AGENT_PRIVATE_KEY_B64 (base64 PEM).
// With --from-keychain (macOS), missing values are read from the login
// Keychain, service "future-electronics-mcp-agent".
//
// Usage: export GH_TOKEN=$(node scripts/agent-token.mjs --from-keychain)

import { execFileSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

export const KEYCHAIN_SERVICE = "future-electronics-mcp-agent";
export const GITHUB_API = "https://api.github.com";
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export class AgentTokenError extends Error {}

export function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Builds an RS256 App JWT: iat backdated 60 s for clock skew, exp 9 min ahead (10 min window). */
export function buildJwt({ appId, privateKey, now = Date.now() }) {
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new AgentTokenError("The App private key is not a valid PEM private key.");
  }
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

/** Reads one secret from the macOS Keychain; the error names the item, never its value. */
export function readKeychain(account, exec = execFileSync) {
  try {
    const value = exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(value).trim();
  } catch {
    throw new AgentTokenError(`Keychain item not found: service "${KEYCHAIN_SERVICE}", account "${account}".`);
  }
}

function decodeB64Key(b64) {
  const pem = Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
  if (!pem.includes("PRIVATE KEY-----")) {
    throw new AgentTokenError("The base64 App private key does not decode to a PEM private key.");
  }
  return pem;
}

/** Resolves App ID, installation ID and PEM key from env, then (optionally) the Keychain. */
export function loadConfig({ env = process.env, argv = [], platform = process.platform, exec = execFileSync } = {}) {
  const fromKeychain = argv.includes("--from-keychain");
  if (fromKeychain && platform !== "darwin") {
    throw new AgentTokenError("--from-keychain is only supported on macOS.");
  }
  const unknown = argv.filter((a) => a !== "--from-keychain");
  if (unknown.length > 0) throw new AgentTokenError(`Unknown argument: ${unknown[0]}`);

  const get = (name, account) => {
    const value = env[name]?.trim();
    if (value) return value;
    return fromKeychain && account ? readKeychain(account, exec) : "";
  };
  const appId = get("FUTURE_AGENT_APP_ID", "app-id");
  const installationId = get("FUTURE_AGENT_INSTALLATION_ID", "installation-id");
  let privateKey = env.FUTURE_AGENT_PRIVATE_KEY?.trim().replace(/\\n/g, "\n") ?? "";
  if (!privateKey) {
    const b64 = get("FUTURE_AGENT_PRIVATE_KEY_B64", "private-key-b64"); // gitleaks:allow -- env var name, not a secret
    if (b64) privateKey = decodeB64Key(b64);
  }

  const missing = [];
  if (!appId) missing.push("FUTURE_AGENT_APP_ID");
  if (!installationId) missing.push("FUTURE_AGENT_INSTALLATION_ID");
  if (!privateKey) missing.push("FUTURE_AGENT_PRIVATE_KEY or FUTURE_AGENT_PRIVATE_KEY_B64");
  if (missing.length > 0) {
    throw new AgentTokenError(`Missing ${missing.join(", ")} (set them, or pass --from-keychain on macOS).`);
  }
  if (!ID_PATTERN.test(appId)) throw new AgentTokenError("FUTURE_AGENT_APP_ID must be a positive integer.");
  if (!ID_PATTERN.test(installationId)) {
    throw new AgentTokenError("FUTURE_AGENT_INSTALLATION_ID must be a positive integer.");
  }
  return { appId, installationId, privateKey };
}

/** Exchanges an App JWT for an installation access token (valid about 1 hour). */
export async function exchangeToken({ jwt, installationId, fetchImpl = fetch }) {
  const url = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "future-electronics-mcp-agent-token",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new AgentTokenError("Could not reach the GitHub API.");
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Fall through with an empty body.
  }
  if (!response.ok) {
    const detail = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    throw new AgentTokenError(`GitHub token exchange failed (HTTP ${response.status})${detail}`);
  }
  if (typeof body?.token !== "string" || body.token === "") {
    throw new AgentTokenError("GitHub token exchange returned no token.");
  }
  return body.token;
}

/** CLI entry point. Returns the exit code. */
export async function run({ argv = [], env, platform, exec, fetchImpl, now, out, err } = {}) {
  const write = out ?? ((s) => process.stdout.write(s));
  const fail = err ?? ((s) => process.stderr.write(s));
  try {
    const { appId, installationId, privateKey } = loadConfig({ env, argv, platform, exec });
    const jwt = buildJwt({ appId, privateKey, now });
    const token = await exchangeToken({ jwt, installationId, fetchImpl });
    write(`${token}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof AgentTokenError ? error.message : "Unexpected error while minting the token.";
    fail(`agent-token: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
