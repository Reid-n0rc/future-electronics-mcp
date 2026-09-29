# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, and others) and for
human contributors working in this repository. `CLAUDE.md` points here, so this
file is the single source of truth.

## Project

This is an MCP server, written in TypeScript, that wraps the Future Electronics
Product Information API. For the API summary and planned tools, see README.md.

- API docs: <https://documenter.getpostman.com/view/18706946/UzBvFhcj>
- Stack: Node.js 18 or later, TypeScript (ESM), `@modelcontextprotocol/sdk`,
  `zod`, and `vitest`
- Commands: `npm run build`, `npm test`, and `npm run typecheck`

## Non-negotiable rules

1. **Never store keys in the repo.** Read [SECURITY.md](SECURITY.md). The key
   comes only from `FUTURE_API_KEY` at runtime. Never write a real key into
   code, tests, fixtures, docs, commits, issues, or PRs, and never log one.
2. **No work without an approved issue.** Every change must be tracked by a
   GitHub issue that contains a software plan. Do not start implementation
   until the maintainer (@Reid-n0rc) has approved the plan. Approval means the issue has the `plan-approved` label. Issues
   labeled `plan-needs-approval` are **not** ready to work.
3. **One branch per issue, based on `dev`.**
   ```bash
   git fetch origin
   git switch -c issue-<number>-<short-slug> origin/dev
   ```
4. **Open pull requests against `dev`.** Never push directly to `dev` or
   `master`.
5. **Only the maintainer promotes `dev` to `master`**, through a pull request.
   Releases and tags come only from `master`.
6. **Do not push, tag, release, or bump versions** unless the maintainer
   explicitly asks.
7. **Sign commits when possible** (SSH or GPG signing). Signing is encouraged
   but not required by branch protection.

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
3. Work happens on `issue-<n>-<slug>`, branched from `dev`.
4. Open a PR into `dev` whose body contains `Closes #<n>`. CI and tests must
   pass.
5. The maintainer merges the PR.

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

## Code conventions

- Put source in `src/` and tests in `tests/`, and mirror module names between
  them.
- Validate every tool input with `zod`, and map every upstream error code to a
  clear message (see README.md).
- Mock HTTP in unit tests. Tests must never require a real key or network
  access.
- Keep the upstream response shape documented in `src/types.ts`. Tools should
  return compact, LLM-friendly summaries with an option to include the raw
  data.
