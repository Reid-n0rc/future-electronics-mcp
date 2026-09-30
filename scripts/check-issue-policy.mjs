// Enforces the AGENTS.md issue policy on pull requests:
// every PR into `dev` must close at least one issue, and each linked issue
// must carry the `plan-approved` label and be assigned to someone.
// Release PRs (head `dev` -> base `master`) are exempt.
//
// Run in CI with GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH set.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Issue numbers the PR body closes, deduplicated, in order of appearance. */
export function linkedIssues(body) {
  const seen = new Set();
  for (const match of String(body ?? "").matchAll(CLOSING)) seen.add(Number(match[1]));
  return [...seen];
}

/** True for release PRs, which promote `dev` to `master` and close no issue. */
export function isReleasePr(pr) {
  return pr?.base?.ref === "master" && pr?.head?.ref === "dev";
}

/**
 * Policy problems for a PR, given its linked issues' data.
 * `issues` maps issue number -> { labels: string[], assignees: string[], isPullRequest?: boolean } or null if missing.
 */
export function policyProblems(numbers, issues) {
  if (numbers.length === 0) {
    return ["PR body must link its issue with `Closes #<n>` (AGENTS.md: no work without an approved issue)."];
  }
  const problems = [];
  for (const n of numbers) {
    const issue = issues.get(n);
    if (!issue || issue.isPullRequest) {
      problems.push(`#${n} is not an issue in this repository.`);
      continue;
    }
    if (!issue.labels.includes("plan-approved")) {
      problems.push(`#${n} does not have the \`plan-approved\` label.`);
    }
    if (issue.assignees.length === 0) {
      problems.push(`#${n} is not assigned. Assign it to the person working it before work starts.`);
    }
  }
  return problems;
}

async function fetchIssue(repo, n, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for issue #${n}`);
  const data = await res.json();
  return {
    labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    assignees: (data.assignees ?? []).map((a) => a.login),
    isPullRequest: Boolean(data.pull_request),
  };
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (isReleasePr(pr)) {
    console.log("Release PR (dev -> master): issue policy not applicable.");
    return;
  }
  const numbers = linkedIssues(pr?.body);
  const issues = new Map();
  for (const n of numbers) issues.set(n, await fetchIssue(GITHUB_REPOSITORY, n, GITHUB_TOKEN));
  const problems = policyProblems(numbers, issues);
  if (problems.length > 0) {
    for (const p of problems) console.log(`::error::${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Issue policy OK for ${numbers.map((n) => `#${n}`).join(", ")}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
