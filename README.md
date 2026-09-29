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

The stack is TypeScript, Node.js 18 or later, `@modelcontextprotocol/sdk`, `zod`, and `vitest`.

```bash
npm install
npm run build
npm test
```

### Workflow

- `master` holds releases only. It changes **only** through pull requests from `dev`.
- `dev` is the integration branch. It changes only through pull requests.
- Every piece of work has a GitHub issue that includes a software plan. The
  maintainer must approve the plan before anyone starts work on it.
- Every issue gets its own branch cut from `dev`, named
  `issue-<number>-<short-slug>`.

See [AGENTS.md](AGENTS.md) for the full process and [SECURITY.md](SECURITY.md)
for key handling.
