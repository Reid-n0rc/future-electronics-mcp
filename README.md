# Future Electronics MCP

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Future Electronics Product Information API](https://documenter.getpostman.com/view/18706946/UzBvFhcj)
to MCP clients such as Claude Code, so an assistant can look up parts, pricing,
inventory, lead times, documents, and images by manufacturer part number.

> **Status:** Pre-release. The implementation is tracked in GitHub issues; see
> the roadmap below.

> Pricing returned by the Future API matches the website and is **not an
> official quote**.

## Upstream API

The details in this section are summarized from the official Future Electronics
API documentation [[1]](#references).

| Search   | Method | Endpoint                                                        |
|----------|--------|-----------------------------------------------------------------|
| Single   | GET    | `https://api.futureelectronics.com/api/v1/pim-future/lookup`    |
| Multiple | POST   | `https://api.futureelectronics.com/api/v1/pim-future/batch/lookup` |

- **Auth:** `x-orbweaver-licensekey` header. You request a key at
  <https://www.futureelectronics.com/api-solutions>.
- **Single lookup** takes `part_number` (3 or more alphanumeric characters) and
  `lookup_type` (`default`, `exact`, `contains`, or `starts_with`).
- **Batch lookup** takes `{"parts": [...]}` and runs an exact match on each
  part. The API allows up to 300 parts per request.
- **Errors:** 400 (bad part number or lookup type), 401 (invalid key),
  402 (purchase required), 403 (not authorized), 406 (key expired), and
  429 (rate limited).

## Planned MCP tools

| Tool                  | Purpose                                                   |
|-----------------------|-----------------------------------------------------------|
| `future_lookup_part`  | Look up one part with a selectable `lookup_type`          |
| `future_lookup_parts` | Look up many parts (chunked into batches of 300 or fewer) |

The final tool names and shapes are defined in the implementation issues.

## Configuration

The server reads its license key **only** from the environment:

```bash
export FUTURE_API_KEY="…"   # never commit this, see SECURITY.md
```

Set up with Claude Code (once implemented):

```bash
claude mcp add future-electronics -e FUTURE_API_KEY="$FUTURE_API_KEY" -- node /path/to/future-electronics-mcp/dist/index.js
```

## Development

The stack is TypeScript, Node.js 22.12 or later, `@modelcontextprotocol/sdk`, `zod`, and `vitest`.

```bash
npm install
npm run build
npm test
```

### Workflow

- `master` holds releases only. It changes **only** through pull requests from `dev`.
- `dev` is the integration branch. It changes only through pull requests.
- PRs from anyone other than an admin need approval from the maintainer or another
  admin (a code owner) before they merge.
- Every piece of work has a GitHub issue. Anyone can file a bug report or
  feature request without a plan, but before work starts the issue needs a
  software plan, and the maintainer must approve it.
- Every issue gets its own branch cut from `dev`, named
  `issue-<number>-<short-slug>`.
- Every function has thorough tests. Every code change runs regression tests,
  and a release ships only after the full regression suite passes.

See [AGENTS.md](AGENTS.md) for the full process and [SECURITY.md](SECURITY.md)
for key handling.

## References

1. Future Electronics. *Future Electronics API's* (Postman API documentation).
   <https://documenter.getpostman.com/view/18706946/UzBvFhcj>. Accessed
   2026-09-29.
2. Future Electronics. *API Solutions* (API key requests).
   <https://www.futureelectronics.com/api-solutions>.

## Disclaimer

This is an unofficial, community project. It is **not affiliated with,
endorsed by, or supported by Future Electronics**. "Future Electronics" is used
only to identify the API this server connects to, and any trademarks belong to
their owners. API behavior, endpoints, and field definitions are summarized
from the documentation cited above. If anything here conflicts with that
documentation, the documentation is authoritative. Pricing returned by the API
is not an official quote.

## License

Copyright (C) 2026 Reid Crowe

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE)
(`AGPL-3.0-or-later`). If you run a modified version of this server and let
users interact with it over a network, you must make your modified source
available to those users.
