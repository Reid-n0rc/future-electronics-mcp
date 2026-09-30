// Tests for scripts/agent-gh.mjs. Token minting and process execution are
// always injected; nothing here pushes, calls gh, or touches the network. The
// credential helper is exercised locally with `sh` and `git credential fill`,
// which only print credentials and never contact a remote.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_GH,
  AgentGhError,
  BRANCH_PATTERN,
  CREDENTIAL_HELPER,
  ORIGIN_PATTERN,
  REDACTED,
  REPO,
  checkOrigin,
  ghEnv,
  gitPushEnv,
  mintToken,
  plan,
  redact,
  run,
  spawnExec,
  validateBranch,
  validateGhArgs,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/agent-gh.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import { AgentTokenError } from "../../scripts/agent-token.mjs";

const TOKEN = "ghs_secretInstallationTokenValue123";
const ORIGIN = "https://github.com/Reid-n0rc/future-electronics-mcp.git\n";
const BASE_ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp/nowhere" };

type Io = { env: Record<string, string>; stdout: (s: string) => void; stderr: (s: string) => void };
type Call = { file: string; args: string[]; env: Record<string, string> };

/** A fake exec: answers the origin lookup, records every call, and returns `code` for the real command. */
function fakeExec({ origin = ORIGIN, code = 0, originCode = 0, emit }: {
  origin?: string;
  code?: number;
  originCode?: number;
  emit?: (io: Io) => void;
} = {}) {
  const calls: Call[] = [];
  const exec = vi.fn(async (file: string, args: string[], io: Io) => {
    calls.push({ file, args: [...args], env: { ...io.env } });
    if (file === "git" && args[0] === "remote") {
      io.stdout(origin);
      return originCode;
    }
    emit?.(io);
    return code;
  });
  return { exec, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

async function runWith(argv: string[], opts: { mint?: () => unknown; exec?: ReturnType<typeof fakeExec> } = {}) {
  const fake = opts.exec ?? fakeExec();
  const mint = vi.fn(opts.mint ?? (async () => TOKEN));
  const cap = capture();
  const code = await run({ argv, env: BASE_ENV, platform: "darwin", mint, exec: fake.exec, ...cap.io });
  return { code, mint, calls: fake.calls, out: cap.out.join(""), err: cap.err.join("") };
}

describe("validateBranch", () => {
  it.each(["issue-57-agent-gh-helper", "issue-0-agent-gh-smoke", "issue-1-a", "issue-123-x9-y"])("accepts %s", (b) => {
    expect(validateBranch(b)).toBe(b);
  });

  it.each([
    "dev",
    "master",
    "main",
    "issue-1",
    "issue-1-",
    "issue--x",
    "issue-x-y",
    "Issue-1-x",
    "issue-1-Upper",
    "issue-1-a_b",
    "issue-1-a/b",
    "issue-1-a..b",
    "feature/issue-1-x",
    "refs/heads/issue-1-x",
    "issue-1-x:dev",
    "issue-1-x:refs/heads/master",
    "+issue-1-x",
    "--force",
    "-f",
    "--mirror",
    "issue-1-x --force",
    "issue-1-x;rm -rf ~",
    "issue-1-x$(id)",
    "issue-1-x`id`",
    "issue-1-x\n",
    "issue-1-x\nmaster",
    " issue-1-x",
    "",
  ])("rejects %j", (b) => {
    expect(() => validateBranch(b)).toThrow(AgentGhError);
  });

  it.each([undefined, null, 1, ["issue-1-x"]])("rejects non-string %j", (b) => {
    expect(() => validateBranch(b)).toThrow(AgentGhError);
  });

  it("uses an anchored pattern", () => {
    expect(BRANCH_PATTERN.source.startsWith("^")).toBe(true);
    expect(BRANCH_PATTERN.source.endsWith("$")).toBe(true);
    expect(BRANCH_PATTERN.flags).not.toContain("m");
  });
});

describe("validateGhArgs", () => {
  it.each(ALLOWED_GH.map((pair: string[]) => [pair.join(" "), pair]))("allows %s", (_name, pair) => {
    expect(validateGhArgs([...pair, "57"])).toEqual([...pair, "57"]);
  });

  it("allows a full pr create with this repo", () => {
    const args = ["pr", "create", "-R", REPO, "-B", "dev", "--head", "issue-57-x", "--reviewer", "Reid-n0rc",
      "--title", "Add helper", "--body-file", "/tmp/body.md"];
    expect(validateGhArgs(args)).toEqual(args);
  });

  it.each([
    [["pr", "merge", "57"]],
    [["pr", "merge", "57", "--admin"]],
    [["pr", "review", "57", "--approve"]],
    [["pr", "close", "57"]],
    [["pr", "edit", "57"]],
    [["pr", "ready", "57"]],
    [["pr", "checkout", "57"]],
    [["api", "repos/Reid-n0rc/future-electronics-mcp/pulls/57/merge", "-X", "PUT"]],
    [["api", "graphql"]],
    [["auth", "token"]],
    [["auth", "status"]],
    [["auth", "login"]],
    [["repo", "edit"]],
    [["repo", "delete"]],
    [["issue", "close", "57"]],
    [["issue", "delete", "57"]],
    [["issue", "transfer", "57", "other/repo"]],
    [["release", "create", "v1"]],
    [["secret", "set", "X"]],
    [["workflow", "run", "ci"]],
    [["alias", "set", "x", "pr merge"]],
    [["extension", "install", "x"]],
    [["pr"]],
    [["issue"]],
    [[]],
    [["PR", "create"]],
    [["pr", "Create"]],
    [["pr", "create-x"]],
    [[" pr", "create"]],
    [["-R", REPO, "pr", "create"]],
    [["--repo", REPO, "pr", "view"]],
    [["pr", "--repo", REPO, "merge"]],
    [["pr", "-R", REPO, "view"]],
  ])("refuses %j", (args) => {
    expect(() => validateGhArgs(args)).toThrow(AgentGhError);
  });

  it.each([
    [["pr", "create", "--repo", "other/repo"]],
    [["pr", "create", "--repo=other/repo"]],
    [["pr", "create", "-R", "other/repo"]],
    [["pr", "create", "-Rother/repo"]],
    [["pr", "create", "-R=other/repo"]],
    [["pr", "view", "-wR", "other/repo"]],
    [["pr", "create", "--repo", "Reid-n0rc/other"]],
    [["pr", "create", "--repo", "evil.example/Reid-n0rc/future-electronics-mcp"]],
    [["pr", "create", "--repo", "github.com/Reid-n0rc/future-electronics-mcp"]],
    [["pr", "create", "--repo"]],
    [["pr", "create", "-R"]],
    [["pr", "create", "--repo", REPO, "--repo", "other/repo"]],
    [["issue", "edit", "1", "-R", "other/repo"]],
  ])("refuses another repo via %j", (args) => {
    expect(() => validateGhArgs(args)).toThrow(/--repo must be/);
  });

  it.each([
    [["pr", "view", "https://github.com/other/repo/pull/1"]],
    [["pr", "comment", "https://github.com/other/repo/pull/1", "--body", "hi"]],
    [["issue", "edit", "http://github.com/other/repo/issues/1"]],
    [["issue", "view", "https://evil.example/Reid-n0rc/future-electronics-mcp/issues/1"]],
    [["issue", "view", "other/repo#1"]],
  ])("refuses a reference to another repo in %j", (args) => {
    expect(() => validateGhArgs(args)).toThrow(/may only reference/);
  });

  it.each([
    [["pr", "create", "--repo", REPO]],
    [["pr", "create", "--repo", REPO.toLowerCase()]],
    [["pr", "create", `--repo=${REPO}`]],
    [["pr", "create", `-R${REPO}`]],
    [["pr", "view", `https://github.com/${REPO}/pull/1`]],
    [["issue", "view", `${REPO}#57`]],
    [["pr", "comment", "57", "--body", "See the Readme and -R notes"]],
    [["pr", "checks", "57", "--watch"]],
    [["issue", "edit", "57", "--add-assignee", "Reid-n0rc"]],
  ])("allows this repo in %j", (args) => {
    expect(validateGhArgs(args)).toEqual(args);
  });

  it.each([[null], ["pr create"], [["pr", "create", 1]]])("refuses non-string-array %j", (args) => {
    expect(() => validateGhArgs(args)).toThrow(AgentGhError);
  });

  it("never allows merge or review", () => {
    for (const [group, command] of ALLOWED_GH) {
      expect(`${group} ${command}`).not.toMatch(/merge|review|api|auth|repo/);
    }
    expect(Object.isFrozen(ALLOWED_GH)).toBe(true);
  });
});

describe("gitPushEnv", () => {
  it("builds the credential block and keeps the base env", () => {
    const env = gitPushEnv(BASE_ENV, TOKEN);
    expect(env).toEqual({
      ...BASE_ENV,
      GH_TOKEN: TOKEN,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
    });
  });

  it("never inlines the token into the helper or any config value", () => {
    const env = gitPushEnv(BASE_ENV, TOKEN);
    expect(CREDENTIAL_HELPER).not.toContain(TOKEN);
    expect(CREDENTIAL_HELPER).toContain("$GH_TOKEN");
    for (const [key, value] of Object.entries(env)) {
      if (key !== "GH_TOKEN") expect(value).not.toContain(TOKEN);
    }
  });

  it("drops inherited per-command git config and does not mutate the input", () => {
    const base = {
      ...BASE_ENV,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "osxkeychain",
      GIT_CONFIG_PARAMETERS: "'credential.helper'='osxkeychain'",
    };
    const snapshot = { ...base };
    const env = gitPushEnv(base, TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env).not.toHaveProperty("GIT_CONFIG_KEY_2");
    expect(env).not.toHaveProperty("GIT_CONFIG_VALUE_2");
    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    expect(base).toEqual(snapshot);
  });

  it("the helper prints credentials for get, reading GH_TOKEN from its own env", () => {
    const run = (op: string) =>
      execFileSync("sh", ["-c", `${CREDENTIAL_HELPER.slice(1)} "$@"`, "helper", op], {
        env: { PATH: process.env.PATH, GH_TOKEN: "dummy-value" },
        encoding: "utf8",
      });
    expect(run("get")).toBe("username=x-access-token\npassword=dummy-value\n");
    expect(run("store")).toBe("");
    expect(run("erase")).toBe("");
  });

  it("git uses only this helper (the empty value resets configured helpers)", () => {
    const output = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      env: gitPushEnv({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, "dummy-value"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(output).toContain("username=x-access-token\n");
    expect(output).toContain("password=dummy-value\n");
  });
});

describe("ghEnv", () => {
  it("sets GH_TOKEN and pins GH_REPO without mutating the input", () => {
    const base = { ...BASE_ENV, GH_REPO: "other/repo" };
    expect(ghEnv(base, TOKEN)).toEqual({ ...BASE_ENV, GH_TOKEN: TOKEN, GH_REPO: REPO });
    expect(base.GH_REPO).toBe("other/repo");
  });
});

describe("redact", () => {
  it("replaces every occurrence", () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("is a no-op without a token", () => {
    expect(redact("plain", "")).toBe("plain");
    expect(redact(42, TOKEN)).toBe("42");
  });
});

describe("checkOrigin", () => {
  it.each([ORIGIN, "https://github.com/Reid-n0rc/future-electronics-mcp", "https://github.com/reid-n0rc/future-electronics-mcp.git"])(
    "accepts %j",
    async (origin) => {
      const { exec, calls } = fakeExec({ origin });
      await expect(checkOrigin(exec, BASE_ENV)).resolves.toBeUndefined();
      expect(calls[0]).toMatchObject({ file: "git", args: ["remote", "get-url", "--push", "origin"] });
    },
  );

  it.each([
    "git@github.com:Reid-n0rc/future-electronics-mcp.git",
    "ssh://git@github.com/Reid-n0rc/future-electronics-mcp.git",
    "https://github.com/other/repo.git",
    "https://github.com/Reid-n0rc/future-electronics-mcp.git.evil",
    "https://x:y@github.com/Reid-n0rc/future-electronics-mcp.git",
    "http://github.com/Reid-n0rc/future-electronics-mcp.git",
    "",
  ])("rejects %j", async (origin) => {
    const { exec } = fakeExec({ origin });
    await expect(checkOrigin(exec, BASE_ENV)).rejects.toThrow(/origin must be/);
  });

  it("rejects when git fails or throws", async () => {
    await expect(checkOrigin(fakeExec({ originCode: 2 }).exec, BASE_ENV)).rejects.toThrow(AgentGhError);
    await expect(checkOrigin(vi.fn(async () => { throw new Error("boom"); }), BASE_ENV)).rejects.toThrow(AgentGhError);
  });

  it("anchors the pattern", () => {
    expect(ORIGIN_PATTERN.test(`x${ORIGIN.trim()}`)).toBe(false);
  });
});

describe("plan", () => {
  it("plans a push", () => {
    const p = plan(["push", "issue-57-x"]);
    expect(p.file).toBe("git");
    expect(p.args).toEqual(["push", "-u", "origin", "issue-57-x"]);
    expect(p.envFor).toBe(gitPushEnv);
    expect(p.preflight).toBe(checkOrigin);
  });

  it("plans a gh call", () => {
    const p = plan(["gh", "pr", "view", "57"]);
    expect(p).toMatchObject({ file: "gh", args: ["pr", "view", "57"] });
    expect(p.envFor).toBe(ghEnv);
    expect(p.preflight).toBeUndefined();
  });

  it.each([[[]], [["push"]], [["push", "issue-1-a", "issue-2-b"]], [["pull", "x"]], [["git", "push"]]])(
    "refuses %j with usage",
    (argv) => {
      expect(() => plan(argv)).toThrow(/usage/);
    },
  );
});

describe("run: push", () => {
  it("checks origin, mints, then pushes with the token only in the child env", async () => {
    const r = await runWith(["push", "issue-57-agent-gh-helper"]);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].env).not.toHaveProperty("GH_TOKEN");
    const push = r.calls[1];
    expect(push.file).toBe("git");
    expect(push.args).toEqual(["push", "-u", "origin", "issue-57-agent-gh-helper"]);
    expect(push.env).toEqual(gitPushEnv(BASE_ENV, TOKEN));
    expect(r.mint).toHaveBeenCalledOnce();
  });

  it.each(["dev", "master", "issue-1", "issue-1-x;id"])("refuses %j before minting or running anything", async (b) => {
    const r = await runWith(["push", b]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^agent-gh: Refusing to push/);
    expect(r.mint).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
  });

  it("refuses an SSH origin before minting", async () => {
    const r = await runWith(["push", "issue-1-x"], { exec: fakeExec({ origin: "git@github.com:Reid-n0rc/future-electronics-mcp.git" }) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/origin must be/);
    expect(r.mint).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(1);
  });

  it("propagates git's exit code", async () => {
    const r = await runWith(["push", "issue-1-x"], { exec: fakeExec({ code: 128 }) });
    expect(r.code).toBe(128);
  });
});

describe("run: gh", () => {
  it("runs an allowed command with GH_TOKEN only in the child env", async () => {
    const args = ["pr", "create", "-R", REPO, "-B", "dev", "--head", "issue-57-x", "--reviewer", "Reid-n0rc"];
    const r = await runWith(["gh", ...args]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ file: "gh", args, env: ghEnv(BASE_ENV, TOKEN) }]);
  });

  it.each([
    ["pr", "merge", "57"],
    ["pr", "review", "57", "--approve"],
    ["api", "user"],
    ["auth", "token"],
    ["repo", "view"],
    ["pr", "create", "--repo", "other/repo"],
  ])("refuses gh %s ... before minting", async (...args) => {
    const r = await runWith(["gh", ...args]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^agent-gh: Refusing gh/);
    expect(r.mint).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
  });

  it("propagates gh's exit code", async () => {
    const r = await runWith(["gh", "pr", "checks", "57"], { exec: fakeExec({ code: 8 }) });
    expect(r.code).toBe(8);
  });
});

describe("run: token handling", () => {
  it.each([[""], ["   \n"], [undefined], [null]])("refuses an empty token %j", async (value) => {
    const r = await runWith(["gh", "pr", "view", "57"], { mint: async () => value });
    expect(r.code).toBe(1);
    expect(r.err).toBe("agent-gh: Refusing: the minted App token is empty.\n");
    expect(r.calls).toHaveLength(0);
  });

  it("trims the minted token", async () => {
    const r = await runWith(["gh", "pr", "view", "57"], { mint: async () => `${TOKEN}\n` });
    expect(r.calls[0].env.GH_TOKEN).toBe(TOKEN);
  });

  it("reports mint failures without running anything", async () => {
    const r = await runWith(["gh", "pr", "view", "57"], {
      mint: async () => {
        throw new AgentTokenError("Missing FUTURE_AGENT_APP_ID.");
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("agent-gh: Missing FUTURE_AGENT_APP_ID.\n");
    expect(r.calls).toHaveLength(0);
  });

  it("hides unexpected error details", async () => {
    const r = await runWith(["gh", "pr", "view", "57"], {
      mint: async () => {
        throw new Error(`internal detail ${TOKEN}`);
      },
    });
    expect(r.err).toBe("agent-gh: Unexpected error.\n");
  });

  it("never exposes the token in argv, stdout, stderr or error messages", async () => {
    const leaky = fakeExec({
      emit: (io) => {
        io.stdout(`out ${TOKEN}\n`);
        io.stderr(`err ${TOKEN}\n`);
      },
    });
    for (const argv of [["push", "issue-1-x"], ["gh", "pr", "view", "57"]]) {
      const r = await runWith(argv, { exec: leaky });
      expect(r.out).toBe(`out ${REDACTED}\n`);
      expect(r.err).toBe(`err ${REDACTED}\n`);
    }
    for (const call of leaky.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      for (const [key, value] of Object.entries(call.env)) {
        if (key !== "GH_TOKEN") expect(value).not.toContain(TOKEN);
      }
    }

    const throwing = vi.fn(async (_f: string, args: string[]) => {
      if (args[0] === "remote") return 0;
      throw new AgentGhError(`failed with ${TOKEN}`);
    });
    const cap = capture();
    const code = await run({ argv: ["gh", "pr", "view", "1"], env: BASE_ENV, mint: async () => TOKEN, exec: throwing, ...cap.io });
    expect(code).toBe(1);
    expect(cap.err.join("")).toBe(`agent-gh: failed with ${REDACTED}\n`);
    expect(cap.out).toEqual([]);
  });
});

describe("mintToken", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = { FUTURE_AGENT_APP_ID: "123", FUTURE_AGENT_INSTALLATION_ID: "456", FUTURE_AGENT_PRIVATE_KEY: privateKey };

  it("exchanges a JWT through agent-token.mjs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: TOKEN }), { status: 201 }));
    const exec = vi.fn();
    await expect(mintToken({ env, platform: "darwin", exec, fetchImpl })).resolves.toBe(TOKEN);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/app/installations/456/access_tokens");
    expect(exec).not.toHaveBeenCalled(); // env wins over the Keychain
  });

  it("falls back to the Keychain on macOS only", async () => {
    const exec = vi.fn(() => {
      throw new Error("not found");
    });
    await expect(mintToken({ env: {}, platform: "darwin", exec, fetchImpl: vi.fn() })).rejects.toThrow(/Keychain item not found/);
    await expect(mintToken({ env: {}, platform: "linux", exec, fetchImpl: vi.fn() })).rejects.toThrow(/Missing FUTURE_AGENT_APP_ID/);
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe("spawnExec", () => {
  it("runs without a shell and streams output", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await spawnExec(process.execPath, ["-e", "process.stdout.write('a;$(id)'); process.stderr.write('b'); process.exit(3)"], {
      env: { PATH: process.env.PATH },
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    });
    expect(code).toBe(3);
    expect(out.join("")).toBe("a;$(id)");
    expect(err.join("")).toBe("b");
  });

  it("passes the env to the child", async () => {
    const out: string[] = [];
    await spawnExec(process.execPath, ["-e", "process.stdout.write(process.env.GH_TOKEN)"], {
      env: { GH_TOKEN: "child-only" },
      stdout: (s: string) => out.push(s),
      stderr: () => {},
    });
    expect(out.join("")).toBe("child-only");
  });

  it("rejects with a clean error when the binary is missing", async () => {
    await expect(
      spawnExec("definitely-not-a-real-binary-xyz", [], { env: { PATH: "/nonexistent" }, stdout: () => {}, stderr: () => {} }),
    ).rejects.toThrow("Could not run definitely-not-a-real-binary-xyz.");
  });
});
