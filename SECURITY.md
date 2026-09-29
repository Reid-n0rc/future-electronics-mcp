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
3. Record the incident in a private security advisory, or in an issue if
   nothing sensitive remains. Never include the key itself.

## Reporting a vulnerability

This repository uses **GitHub private vulnerability reporting**. To report a
vulnerability:

1. Open the repository's **Security** tab and click **Report a vulnerability**,
   or go directly to
   <https://github.com/Reid-n0rc/future-electronics-mcp/security/advisories/new>.
2. Include the affected version or commit, reproduction steps, and the
   impact. **Never include a real API key.** Use placeholders instead.

**Do not** report vulnerabilities in public issues, pull requests, or
discussions.

The maintainer aims to acknowledge reports within 7 days. Fixes are
coordinated privately and disclosed through a GitHub Security Advisory once a
fixed release is available. Reporters are credited unless they ask not to be.

## Supported versions

Only the latest release on `master` receives security fixes.
