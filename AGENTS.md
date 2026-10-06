# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, and others) and for
human contributors working in this repository. `CLAUDE.md` points here, so this
file is the single source of truth.

## Project

This is an MCP server, written in TypeScript, that wraps the Future Electronics
Product Information API. For the API summary and planned tools, see README.md.

- API docs: <https://documenter.getpostman.com/view/18706946/UzBvFhcj>
- Stack: Node.js 22.12 or later, TypeScript (ESM), `@modelcontextprotocol/sdk`,
  `zod`, and `vitest`
- Commands: `npm run build`, `npm test`, and `npm run typecheck`

## Non-negotiable rules

1. **Never store keys in the repo.** Read [SECURITY.md](SECURITY.md). The key
   comes only from `FUTURE_API_KEY` at runtime. Never write a real key into
   code, tests, fixtures, docs, commits, issues, or PRs, and never log one.
2. **No work without an approved issue.** Every change must be tracked by a
   GitHub issue that contains a software plan. Do not start implementation
   until the maintainer (@Reid-n0rc) has approved the plan. Approval means the issue has the `plan-approved` label. Issues
   labeled `plan-needs-approval` are **not** ready to work. Before work starts,
   the issue must also be **assigned to whoever is working it**.
3. **One branch per issue, based on `dev`.**
   ```bash
   git fetch origin
   git switch -c issue-<number>-<short-slug> origin/dev
   ```
4. **Open pull requests against `dev`.** Never push directly to `dev` or
   `master`.
   - **Review rules:** a ruleset protects `master` and `dev`. A PR from a
     non-admin needs approval from a code owner (see `.github/CODEOWNERS`)
     before it can merge, and new pushes dismiss the approval. Admins also
     must use a PR, but they may merge their own without approval
     (`gh pr merge --admin`). To make someone an approver, add them to
     CODEOWNERS through a PR.
5. **Only the maintainer promotes `dev` to `master`**, through a pull request.
   Releases and tags come only from `master`.
6. **Do not push, tag, release, or bump versions** unless the maintainer
   explicitly asks.
7. **Sign commits when possible** (SSH or GPG signing). Signing is encouraged
   but not required by branch protection.
8. **Test everything, and regress before merging or releasing.** See the
   Testing policy below.

## Local setup

Enable the repo's git hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`npm install` also sets this automatically through the `prepare` script.

- `pre-commit` blocks commits on `master` or `dev`, staged `.env` files
  (except `.env.example`), and added lines that set `FUTURE_API_KEY` or
  `x-orbweaver-licensekey` to a real-looking value.
- `pre-push` blocks pushes to `master` or `dev`. Server-side protection
  enforces this too. The maintainer-only emergency bypass is
  `ALLOW_PROTECTED_PUSH=1`.
- `.claude/settings.json` adds a Claude Code hook
  (`.claude/hooks/guard-git-push.sh`, needs `jq`). It denies agent pushes to
  `master` or `dev` and force pushes, except `--force-with-lease` on
  `issue-*` branches.
- Hook tests: `sh tests/hooks/run.sh`.

## Issue lifecycle

Anyone can file a **Bug report** or **Feature request** without a plan. Those
templates are intake only, and filing one does not authorize work.

1. Before anyone works an issue, it needs a software plan: the goal, the plan
   steps, the files it touches, a test plan, acceptance criteria, and an
   out-of-scope section. New implementation work uses the **Implementation
   task** template. For an existing bug or feature request, add the plan to
   that issue (or open a linked Implementation task). Then apply the
   `plan-needs-approval` label.
2. The maintainer reviews the plan. They approve it by swapping the label to
   `plan-approved`, or they request changes in the comments.
3. Before creating the branch, assign the issue to the person working it:
   `gh issue edit <n> --add-assignee <login>` (or `@me`). Agents work under the
   maintainer's GitHub account, so agent work is assigned to that account.
   **Enforced:** the `Issue policy` check fails any PR into `dev` whose
   `Closes #<n>` issue lacks `plan-approved` or an assignee
   (`.github/workflows/issue-policy.yml`).
4. Work happens on `issue-<n>-<slug>`, branched from `dev`.
5. Open a PR into `dev` whose body contains `Closes #<n>`. CI and tests must
   pass.
6. The maintainer merges the PR.

## Task sizing (context-window budget)

Break every task up so that one agent session can finish it **without
exceeding the context window**. Rules of thumb:

- One issue covers one concern, such as one module, one tool, or one doc.
- Aim for a diff of **300 lines or fewer** (tests excluded). An issue should
  touch 5 files or fewer.
- A plan must list every file the issue reads or changes. If that list
  requires reading more than about 10 files, or any very large file, split the
  issue.
- Do not load large generated artifacts or full API dumps into context. Use
  small, trimmed fixtures.
- If a task grows mid-flight, stop. Commit what is coherent, then open a
  follow-up issue with its own plan for approval instead of expanding scope.

## Testing policy

1. **Every implemented function has thorough tests.** Unit tests cover the
   happy path, boundary and edge cases, invalid input, and every error path.
   Tests use mocked HTTP and dummy keys, and they never require a real key or
   network access. A PR that adds a function without tests is incomplete.
2. **Every code change runs regression tests.** Before opening or updating a
   PR, run the tests for the changed modules and everything that depends on
   them, plus `npm run typecheck`. The PR must list the commands run and their
   results. Fix regressions; never skip or delete a failing test to get
   green.
3. **Every release runs full regression, and it must pass.** Before a release,
   run the complete suite from a clean install:
   ```bash
   npm ci && npm run typecheck && npm run build && npm test
   ```
   The live API check (`npm run live-check`) must also pass. CI runs it as the
   required `live-check` job on release PRs and again on the published release
   (see README.md, "Live check"). The maintainer approves each run in the
   `live-api` environment. If any part fails or is skipped, there is no
   release.

## Release process

1. Open a PR from `dev` to `master`, titled `Release vX.Y.Z`.
   The `mcpb/manifest.json` version must match `package.json` (and the tag),
   or the release workflow fails and no `.mcpb` is attached. The `.mcpb` is
   also withheld if the release workflow's `live-check` job fails.
2. Paste the full regression output (see the Testing policy) into the PR. CI
   must also be green, including `live-check`, which waits for the
   maintainer's approval of the `live-api` environment.
3. The maintainer reviews and merges the PR.
4. Only the maintainer creates the tag and GitHub release, from `master`.
   Agents never tag or release.

## Code conventions

- Put source in `src/` and tests in `tests/`, and mirror module names between
  them.
- Any change under `src/` must be followed by `npm run bundle`, with the
  updated `server/future-electronics-mcp.mjs` committed in the same PR. CI fails
  if the committed bundle is out of date.
- Validate every tool input with `zod`, and map every upstream error code to a
  clear message (see README.md).
- Mock HTTP in unit tests. Tests must never require a real key or network
  access.
- Any code derived from the Future API documentation must cite it in a header
  comment, for example `src/types.ts` and the error mapping in
  `src/client.ts`. Use:
  `// Source: Future Electronics API docs, https://documenter.getpostman.com/view/18706946/UzBvFhcj`
- Keep the upstream response shape documented in `src/types.ts`. Tools should
  return compact, LLM-friendly summaries with an option to include the raw
  data.
