#!/usr/bin/env node
// One reviewed entry point for acting as the GitHub App (issue #57).
//
//   node scripts/agent-gh.mjs push <branch>   git push -u origin <branch> as the App
//   node scripts/agent-gh.mjs gh <args...>    an allowlisted gh command as the App
//
// The installation token is minted in-process with scripts/agent-token.mjs
// (env first, then the macOS Keychain). It is placed only in the child
// process's environment: never in argv, git config, a remote URL, a file, or
// our own output. Any child output or error text that contains it is redacted.
//
// Guard rails: pushes are limited to issue-<n>-<slug> branches (never dev or
// master), and gh is limited to pr create/view/checks/comment and issue
// view/edit on this repository. pr merge and pr review are never allowed, so an
// agent can't approve or merge its own work.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AgentTokenError, buildJwt, exchangeToken, loadConfig } from "./agent-token.mjs";

export const REPO = "Reid-n0rc/future-electronics-mcp";
export const BRANCH_PATTERN = /^issue-[0-9]+-[a-z0-9-]+$/;
export const ALLOWED_GH = Object.freeze([
  ["pr", "create"],
  ["pr", "view"],
  ["pr", "checks"],
  ["pr", "comment"],
  ["issue", "view"],
  ["issue", "edit"],
]);
export const REDACTED = "[REDACTED]";
// origin must push over HTTPS to this repo; with an SSH remote the credential
// helper is ignored and the push would silently use the maintainer's SSH key.
export const ORIGIN_PATTERN = /^https:\/\/github\.com\/Reid-n0rc\/future-electronics-mcp(?:\.git)?$/i;

// Echoes the credentials git asks for, reading GH_TOKEN from the helper's own
// environment at run time. Why this is safe:
// - The token is never part of this string, so it can't leak through argv,
//   `ps`, git config, or GIT_TRACE output (which print the helper command).
// - git runs a `!` helper with `sh -c`, which inherits git's env (our child
//   env). "$GH_TOKEN" is expanded inside double quotes, so its contents are
//   never split or evaluated as shell code.
// - The password goes only to git over the helper's stdout pipe. The helper
//   answers `get` only and ignores `store`/`erase`, so nothing is saved.
// - GH_TOKEN exists only in the git child's env (and its helpers and the
//   repo's pre-push hook); our own process never exports it.
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

const USAGE = "usage: agent-gh.mjs push <branch> | agent-gh.mjs gh <args...>";

export class AgentGhError extends Error {}

/** Throws unless `branch` is an issue branch (issue-<n>-<slug>). Anchored, so no refs, options or injection. */
export function validateBranch(branch) {
  if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch)) {
    throw new AgentGhError(
      "Refusing to push: the branch must match issue-<number>-<slug> (lowercase letters, digits, hyphens).",
    );
  }
  return branch;
}

function isOtherRepo(value) {
  return value.toLowerCase() !== REPO.toLowerCase();
}

// Values of -R/--repo, in every form the gh flag parser accepts: `--repo x`,
// `--repo=x`, `-R x`, `-Rx`, `-R=x`, and combined shorthands such as `-wR x`.
function repoFlagValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") {
      values.push(args[i + 1] ?? "");
    } else if (arg.startsWith("--repo=")) {
      values.push(arg.slice("--repo=".length));
    } else if (/^-[A-Za-z]*R/.test(arg)) {
      const rest = arg.slice(arg.indexOf("R") + 1).replace(/^=/, "");
      values.push(rest === "" ? (args[i + 1] ?? "") : rest);
    }
  }
  return values;
}

// A bare issue/PR reference to another repository (a URL or OWNER/REPO#N)
// would make gh act outside this repo even without -R.
function referencesOtherRepo(arg) {
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)/i.exec(arg);
  if (url) return isOtherRepo(url[1]);
  if (/^https?:\/\//i.test(arg)) return true;
  const shorthand = /^([\w.-]+\/[\w.-]+)#[0-9]+$/.exec(arg);
  return shorthand ? isOtherRepo(shorthand[1]) : false;
}

/** Throws unless `args` is an allowlisted gh command aimed at this repository. */
export function validateGhArgs(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new AgentGhError("Refusing gh: arguments must be strings.");
  }
  const [group, command] = args;
  if (!ALLOWED_GH.some(([g, c]) => g === group && c === command)) {
    const allowed = ALLOWED_GH.map((pair) => pair.join(" ")).join(", ");
    throw new AgentGhError(`Refusing gh: only these subcommands are allowed: ${allowed}.`);
  }
  if (repoFlagValues(args).some(isOtherRepo)) {
    throw new AgentGhError(`Refusing gh: --repo must be ${REPO}.`);
  }
  if (args.slice(2).some(referencesOtherRepo)) {
    throw new AgentGhError(`Refusing gh: arguments may only reference ${REPO}.`);
  }
  return args;
}

/**
 * The child env for `git push`. GIT_CONFIG_COUNT/KEY/VALUE apply config to this
 * one command only (nothing is written to any git config file). The empty
 * first value resets every credential helper configured elsewhere (osxkeychain,
 * gh, a manager), so the maintainer's stored login can't be used by mistake;
 * the second adds CREDENTIAL_HELPER, which reads GH_TOKEN from its env.
 */
export function gitPushEnv(baseEnv, token) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    // Drop inherited per-command config (`git -c` travels as GIT_CONFIG_PARAMETERS
    // and is applied after ours) so nothing can add another helper.
    if (/^GIT_CONFIG_(?:KEY_[0-9]+|VALUE_[0-9]+|PARAMETERS)$/.test(key)) delete env[key];
  }
  return {
    ...env,
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
  };
}

/** The child env for `gh`: GH_TOKEN makes gh act as the App; GH_REPO pins the repository. */
export function ghEnv(baseEnv, token) {
  return { ...baseEnv, GH_TOKEN: token, GH_REPO: REPO };
}

/** Replaces every occurrence of `token` in `text`. */
export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join(REDACTED) : s;
}

/** Mints an installation token with agent-token.mjs (Keychain fallback on macOS). */
export async function mintToken({ env = process.env, platform = process.platform, exec, fetchImpl, now } = {}) {
  const argv = platform === "darwin" ? ["--from-keychain"] : [];
  const { appId, installationId, privateKey } = loadConfig({ env, argv, platform, exec });
  const jwt = buildJwt({ appId, privateKey, now });
  return exchangeToken({ jwt, installationId, fetchImpl });
}

/**
 * Runs `file` with an argv array (no shell). stdout/stderr are piped through
 * the given writers so they can be redacted. Resolves to the exit code.
 */
export function spawnExec(file, args, { env, stdout, stderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => stdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr(chunk.toString("utf8")));
    child.on("error", () => reject(new AgentGhError(`Could not run ${file}.`)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Throws unless origin's push URL is this repository over HTTPS. Runs before any token is minted. */
export async function checkOrigin(exec, env) {
  let url = "";
  let code;
  try {
    code = await exec("git", ["remote", "get-url", "--push", "origin"], {
      env,
      stdout: (s) => {
        url += s;
      },
      stderr: () => {},
    });
  } catch {
    code = 1;
  }
  if (code !== 0 || !ORIGIN_PATTERN.test(url.trim())) {
    throw new AgentGhError(`Refusing to push: origin must be https://github.com/${REPO}.git.`);
  }
}

/** Parses argv into the command to run, before any token is minted. */
export function plan(argv) {
  const [mode, ...rest] = argv;
  if (mode === "push") {
    if (rest.length !== 1) throw new AgentGhError(USAGE);
    const args = ["push", "-u", "origin", validateBranch(rest[0])];
    return { file: "git", args, envFor: gitPushEnv, preflight: checkOrigin };
  }
  if (mode === "gh") {
    return { file: "gh", args: validateGhArgs(rest), envFor: ghEnv };
  }
  throw new AgentGhError(USAGE);
}

/** CLI entry point. Returns the exit code. */
export async function run({ argv = [], env = process.env, platform, mint = mintToken, exec = spawnExec, out, err } = {}) {
  const write = out ?? ((s) => process.stdout.write(s));
  const fail = err ?? ((s) => process.stderr.write(s));
  let token = "";
  try {
    const command = plan(argv);
    if (command.preflight) await command.preflight(exec, env);
    token = String((await mint({ env, platform })) ?? "").trim();
    if (!token) throw new AgentGhError("Refusing: the minted App token is empty.");
    return await exec(command.file, command.args, {
      env: command.envFor(env, token),
      stdout: (s) => write(redact(s, token)),
      stderr: (s) => fail(redact(s, token)),
    });
  } catch (error) {
    const known = error instanceof AgentGhError || error instanceof AgentTokenError;
    const message = known ? error.message : "Unexpected error.";
    fail(`agent-gh: ${redact(message, token)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
