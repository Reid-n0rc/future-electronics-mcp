// Tests for scripts/agent-token.mjs. A throwaway RSA key is generated at test
// time; fetch and execFileSync are always mocked. No network, no real Keychain.

import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentTokenError,
  KEYCHAIN_SERVICE,
  base64url,
  buildJwt,
  exchangeToken,
  loadConfig,
  readKeychain,
  run,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/agent-token.mjs";

const { privateKey: PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_B64 = Buffer.from(PEM).toString("base64");
const KEY_BODY = PEM.split("\n")[1]; // a line of real key material
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const NOW_S = NOW / 1000;
const TOKEN = "ghs_testInstallationToken";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const baseEnv = { FUTURE_AGENT_APP_ID: "123", FUTURE_AGENT_INSTALLATION_ID: "456", FUTURE_AGENT_PRIVATE_KEY: PEM };

function okFetch(body: unknown = { token: TOKEN, expires_at: "2026-09-30T13:00:00Z" }, status = 201) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

function expectNoSecrets(text: string) {
  expect(text).not.toContain(KEY_BODY);
  expect(text).not.toContain("PRIVATE KEY");
  expect(text).not.toContain(PEM_B64.slice(0, 40));
  expect(text).not.toContain(TOKEN);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64url", () => {
  it("encodes without padding or +/ characters", () => {
    expect(base64url("\xfb\xff")).toBe(Buffer.from("\xfb\xff").toString("base64url"));
    expect(base64url("a")).toBe("YQ");
    expect(base64url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe("-__-");
  });
});

describe("buildJwt", () => {
  it("produces an RS256 JWT verifiable with the public key", () => {
    const jwt = buildJwt({ appId: "123", privateKey: PEM, now: NOW });
    const [h, c, s] = jwt.split(".");
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const verified = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(PUBLIC_PEM, Buffer.from(s, "base64url"));
    expect(verified).toBe(true);
  });

  it("backdates iat 60 s, keeps exp within 10 min, and sets iss to the App ID string", () => {
    const claims = decode(buildJwt({ appId: 123, privateKey: PEM, now: NOW + 999 }).split(".")[1]);
    expect(claims.iat).toBe(NOW_S - 60);
    expect(claims.exp).toBeGreaterThan(NOW_S);
    expect(claims.exp - NOW_S).toBeLessThanOrEqual(600);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iss).toBe("123");
  });

  it("defaults now to the current time", () => {
    const claims = decode(buildJwt({ appId: "1", privateKey: PEM }).split(".")[1]);
    expect(Math.abs(claims.iat + 60 - Date.now() / 1000)).toBeLessThan(5);
  });

  it("rejects a tampered signature", () => {
    const [h, , s] = buildJwt({ appId: "123", privateKey: PEM, now: NOW }).split(".");
    const other = base64url(JSON.stringify({ iss: "999" }));
    expect(createVerify("RSA-SHA256").update(`${h}.${other}`).verify(PUBLIC_PEM, Buffer.from(s, "base64url"))).toBe(
      false,
    );
  });

  it("throws a key-free error for an invalid key", () => {
    const bad = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----`; // gitleaks:allow -- key generated at test runtime
    for (const privateKey of [bad, "not a key", ""]) {
      let error: unknown;
      try {
        buildJwt({ appId: "1", privateKey, now: NOW });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AgentTokenError);
      expectNoSecrets(String((error as Error).message));
    }
  });
});

describe("readKeychain", () => {
  it("calls security find-generic-password with the service and account, trimming output", () => {
    const exec = vi.fn(() => "  42\n");
    expect(readKeychain("app-id", exec)).toBe("42");
    expect(exec).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "app-id", "-w"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("wraps failures without leaking the underlying error", () => {
    const exec = vi.fn(() => {
      throw new Error(`security failed ${KEY_BODY}`);
    });
    expect(() => readKeychain("private-key-b64", exec)).toThrow(AgentTokenError);
    try {
      readKeychain("private-key-b64", exec);
    } catch (e) {
      expect((e as Error).message).toContain('account "private-key-b64"');
      expectNoSecrets((e as Error).message);
    }
  });
});

describe("loadConfig", () => {
  it("reads PEM from env", () => {
    expect(loadConfig({ env: baseEnv, argv: [] })).toEqual({ appId: "123", installationId: "456", privateKey: PEM.trim() });
  });

  it("accepts a base64 PEM and escaped newlines", () => {
    const b64 = { ...baseEnv, FUTURE_AGENT_PRIVATE_KEY: undefined, FUTURE_AGENT_PRIVATE_KEY_B64: `\n${PEM_B64}\n` };
    expect(loadConfig({ env: b64 }).privateKey).toBe(PEM);
    const escaped = { ...baseEnv, FUTURE_AGENT_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") };
    expect(loadConfig({ env: escaped }).privateKey).toBe(PEM);
  });

  it("prefers the PEM over the base64 form", () => {
    const env = { ...baseEnv, FUTURE_AGENT_PRIVATE_KEY_B64: "garbage" };
    expect(loadConfig({ env }).privateKey).toBe(PEM.trim());
  });

  it("rejects base64 that is not a PEM, without echoing it", () => {
    const env = { ...baseEnv, FUTURE_AGENT_PRIVATE_KEY: "", FUTURE_AGENT_PRIVATE_KEY_B64: "c2VjcmV0LXN0dWZm" };
    expect(() => loadConfig({ env })).toThrow(/does not decode to a PEM/);
    try {
      loadConfig({ env });
    } catch (e) {
      expect((e as Error).message).not.toContain("c2VjcmV0LXN0dWZm");
      expect((e as Error).message).not.toContain("secret-stuff");
    }
  });

  it("lists every missing value and never touches the Keychain without the flag", () => {
    const exec = vi.fn();
    expect(() => loadConfig({ env: {}, exec, platform: "darwin" })).toThrow(
      /FUTURE_AGENT_APP_ID, FUTURE_AGENT_INSTALLATION_ID, FUTURE_AGENT_PRIVATE_KEY or FUTURE_AGENT_PRIVATE_KEY_B64/,
    );
    expect(() => loadConfig({ env: { ...baseEnv, FUTURE_AGENT_APP_ID: "  " } })).toThrow(/Missing FUTURE_AGENT_APP_ID/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "12a", "1.5", "123456789012345678901"])("rejects non-integer IDs (%s)", (id) => {
    expect(() => loadConfig({ env: { ...baseEnv, FUTURE_AGENT_APP_ID: id } })).toThrow(/APP_ID must be/);
    expect(() => loadConfig({ env: { ...baseEnv, FUTURE_AGENT_INSTALLATION_ID: id } })).toThrow(
      /INSTALLATION_ID must be/,
    );
  });

  it("reads every value from the Keychain with --from-keychain on macOS", () => {
    const values: Record<string, string> = { "app-id": "123\n", "installation-id": "456\n", "private-key-b64": PEM_B64 };
    const exec = vi.fn((_cmd: string, args: string[]) => values[args[4]]);
    expect(loadConfig({ env: {}, argv: ["--from-keychain"], platform: "darwin", exec })).toEqual({
      appId: "123",
      installationId: "456",
      privateKey: PEM,
    });
    expect(exec.mock.calls.map((c) => c[1][4])).toEqual(["app-id", "installation-id", "private-key-b64"]);
    expect(exec.mock.calls.every((c) => c[0] === "security" && c[1][2] === KEYCHAIN_SERVICE)).toBe(true);
  });

  it("lets env override Keychain values", () => {
    const exec = vi.fn(() => "999");
    const cfg = loadConfig({ env: baseEnv, argv: ["--from-keychain"], platform: "darwin", exec });
    expect(cfg.appId).toBe("123");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses --from-keychain off macOS and unknown arguments", () => {
    const exec = vi.fn();
    expect(() => loadConfig({ env: {}, argv: ["--from-keychain"], platform: "linux", exec })).toThrow(/only supported on macOS/);
    expect(() => loadConfig({ env: baseEnv, argv: ["--key", "x"] })).toThrow(/Unknown argument: --key/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("exchangeToken", () => {
  it("POSTs to the installation access_tokens endpoint with the JWT and GitHub headers", async () => {
    const fetchImpl = okFetch();
    await expect(exchangeToken({ jwt: "j.w.t", installationId: "456", fetchImpl })).resolves.toBe(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer j.w.t",
      "User-Agent": "future-electronics-mcp-agent-token",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("reports HTTP errors with GitHub's message but not the JWT", async () => {
    const fetchImpl = okFetch({ message: "A JSON web token could not be decoded" }, 401);
    const p = exchangeToken({ jwt: "SECRETJWT", installationId: "1", fetchImpl });
    await expect(p).rejects.toThrow("GitHub token exchange failed (HTTP 401): A JSON web token could not be decoded");
    await expect(exchangeToken({ jwt: "SECRETJWT", installationId: "1", fetchImpl })).rejects.not.toThrow(/SECRETJWT/);
  });

  it("handles non-JSON error bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 502 }));
    await expect(exchangeToken({ jwt: "j", installationId: "1", fetchImpl })).rejects.toThrow(/HTTP 502\)$/);
  });

  it.each([{}, { token: "" }, { token: 5 }])("rejects a success body without a token (%j)", async (body) => {
    await expect(exchangeToken({ jwt: "j", installationId: "1", fetchImpl: okFetch(body) })).rejects.toThrow(
      /returned no token/,
    );
  });

  it("wraps network failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(exchangeToken({ jwt: "j", installationId: "1", fetchImpl })).rejects.toThrow(
      "Could not reach the GitHub API.",
    );
  });

  it("uses the global fetch by default", async () => {
    const globalFetch = okFetch();
    vi.stubGlobal("fetch", globalFetch);
    await expect(exchangeToken({ jwt: "j", installationId: "1" })).resolves.toBe(TOKEN);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("run", () => {
  it("prints only the token to stdout and exits 0", async () => {
    const fetchImpl = okFetch();
    const { out, err, io } = capture();
    await expect(run({ env: baseEnv, fetchImpl, now: NOW, ...io })).resolves.toBe(0);
    expect(out).toEqual([`${TOKEN}\n`]);
    expect(err).toEqual([]);
    const auth = (fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization;
    const [h, c, s] = auth.replace("Bearer ", "").split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(PUBLIC_PEM, Buffer.from(s, "base64url"))).toBe(true);
    expect(decode(c)).toEqual({ iat: NOW_S - 60, exp: NOW_S + 540, iss: "123" });
  });

  it("works end to end from the (mocked) Keychain", async () => {
    const values: Record<string, string> = { "app-id": "7", "installation-id": "8", "private-key-b64": PEM_B64 };
    const exec = vi.fn((_c: string, args: string[]) => values[args[4]]);
    const fetchImpl = okFetch();
    const { out, io } = capture();
    const code = await run({ argv: ["--from-keychain"], env: {}, platform: "darwin", exec, fetchImpl, ...io });
    expect(code).toBe(0);
    expect(out).toEqual([`${TOKEN}\n`]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/app/installations/8/access_tokens");
  });

  it.each([
    ["missing config", { env: {} }],
    ["bad key", { env: { ...baseEnv, FUTURE_AGENT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----` } }],
    ["keychain failure", { env: {}, argv: ["--from-keychain"], platform: "darwin", exec: () => { throw new Error(PEM); } }],
    ["http error", { env: baseEnv, fetchImpl: okFetch({ message: "Bad credentials" }, 401) }],
  ])("writes a key-free error to stderr and exits 1 (%s)", async (_name, opts) => {
    const { out, err, io } = capture();
    await expect(run({ fetchImpl: okFetch(), ...opts, ...io } as never)).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^agent-token: /);
    expectNoSecrets(err[0]);
  });

  it("handles a null body and hides unexpected (non-AgentTokenError) details", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, json: () => Promise.resolve(null) }) as Response);
    const { err, io } = capture();
    await expect(run({ env: baseEnv, fetchImpl, ...io })).resolves.toBe(1);
    expect(err[0]).toMatch(/returned no token/);

    const boom = vi.fn<typeof fetch>(async () => ({
      get ok(): boolean {
        throw new Error(`boom ${PEM}`);
      },
      json: () => Promise.resolve({}),
    }) as unknown as Response);
    const second = capture();
    await expect(run({ env: baseEnv, fetchImpl: boom, ...second.io })).resolves.toBe(1);
    expect(second.err).toEqual(["agent-token: Unexpected error while minting the token.\n"]);
  });

  it("defaults to process stdout/stderr", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await run({ env: baseEnv, fetchImpl: okFetch() });
      await run({ env: {} });
      expect(stdout).toHaveBeenCalledWith(`${TOKEN}\n`);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^agent-token: Missing/));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
