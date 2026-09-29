# Security Policy

## API keys and secrets

**Keys shall never be stored in this repository.** This rule is absolute and
covers every branch, tag, commit, issue, pull request, test fixture, log, and
documentation example.

- The Future Electronics license key (`x-orbweaver-licensekey`) is supplied
  **only** at runtime through the `FUTURE_API_KEY` environment variable. It can
  also come from a secret manager that populates that variable, such as
  1Password.
- `.env` and `.env.*` files are git-ignored. The only committed env file is
  `.env.example`, and it contains placeholder values only.
- Tests must use mocked HTTP responses and dummy keys such as `test-key`. Live
  API tests are opt-in, and they read the key from the environment.
- The server must never log, echo, or return the key in tool output, error
  messages, or stack traces. Error handling must redact it.
- Do not paste real keys into issues, pull requests, or agent prompts.

### If a key is committed or exposed

1. Treat the key as compromised. Contact Future Electronics to revoke or
   rotate it immediately.
2. Remove the key from history (`git filter-repo` or BFG) and force-push. This
   is the one allowed exception to the PR-only rule, and it requires the
   maintainer's action.
3. Open an issue that records the incident without including the key itself.

## Reporting a vulnerability

This repository is private. Report vulnerabilities directly to the maintainer
(@Reid-n0rc) through a private channel or a GitHub security advisory on this
repository. Do not report them in a public issue.

## Supported versions

Only the latest release on `master` receives security fixes.
