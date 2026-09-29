# Future Electronics MCP

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Future Electronics Product Information API](https://documenter.getpostman.com/view/18706946/UzBvFhcj)
to MCP clients such as Claude Code, so an assistant can look up parts, pricing,
inventory, lead times, documents, and images by manufacturer part number.

> **Status:** Pre-release (0.1.0). Work is tracked in GitHub issues.

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

## Install

You need Node.js 22.12 or later and a Future Electronics license key (see
[References](#references)).

### Claude Code (recommended)

Run these two commands inside Claude Code:

```
/plugin marketplace add Reid-n0rc/future-electronics-mcp
/plugin install future-electronics@future-electronics-mcp
```

Claude Code asks for your **Future Electronics API key during the install**
(when the plugin is enabled).
The input is masked, and Claude Code keeps the key in its secure storage (the
OS keychain or credential store), never in a settings file or in this repo.
The plugin passes it to the server as `FUTURE_API_KEY`. No clone, build, or
`npm install` is needed: the plugin runs the self-contained bundle
`server/future-electronics-mcp.mjs` with your `node`.

The marketplace installs from the `master` branch, so you get released code
only. To pick up a new release, run
`/plugin marketplace update future-electronics-mcp`.

### Developer install (from a clone)

For development, or for MCP clients other than Claude Code, build from a
clone:

```bash
git clone https://github.com/Reid-n0rc/future-electronics-mcp.git
cd future-electronics-mcp
npm ci
npm run build          # produces dist/index.js
```

To load your working copy as a plugin, run
`claude --plugin-dir /path/to/future-electronics-mcp`. Claude Code then asks
for the key the same way as a marketplace install. The plugin runs the
committed bundle, so run `npm run bundle` after changing `src/`.

Or register the built server directly with `claude mcp add`:

```bash
claude mcp add future-electronics --scope user \
  -e FUTURE_API_KEY="$FUTURE_API_KEY" \
  -- node /path/to/future-electronics-mcp/dist/index.js
```

Your shell expands `$FUTURE_API_KEY`, so this copies the key's value into your
Claude Code user config (`~/.claude.json`, outside this repo). If you would
rather not store it there, use the plugin install. For other MCP clients, run
`node /path/to/future-electronics-mcp/dist/index.js` over stdio with
`FUTURE_API_KEY` in its environment.

Check the connection with `claude mcp list`, or `/mcp` inside Claude Code.

## Claude Desktop

Claude Desktop installs the server in one click from an MCP Bundle
(`.mcpb`). It needs no clone, no build, and no separate Node.js install,
because Claude Desktop ships its own Node.js runtime.

1. Download `future-electronics-mcp.mcpb` from the latest
   [release](https://github.com/Reid-n0rc/future-electronics-mcp/releases).
2. Double-click the file, or drag it onto Claude Desktop (you can also use
   **Settings → Extensions**). Claude Desktop shows an install dialog.
3. Click **Install**, then enter your Future Electronics API key when asked.
   Claude Desktop stores the key in its secure storage and passes it to the
   server as `FUTURE_API_KEY`. The key is never written to the bundle or to
   this repo.

To change the key later, open **Settings → Extensions → Future Electronics
Part Lookup**. To build the bundle yourself, run `npm ci && npm run pack:mcpb`.
That writes `build/future-electronics-mcp.mcpb`.

## Configuration

| Variable              | Required         | Purpose                                                                        |
|-----------------------|------------------|--------------------------------------------------------------------------------|
| `FUTURE_API_KEY`      | Yes, for lookups | License key, sent as the `x-orbweaver-licensekey` header. Never logged or returned. |
| `FUTURE_API_BASE_URL` | No               | Override the API origin (default `https://api.futureelectronics.com`). Must be `https`. |

The server **starts without a key**. The key is read the first time a tool is
called, and a missing key fails only that call, with a clear error. With the
plugin install, Claude Code sets `FUTURE_API_KEY` from the key you entered at
install. Otherwise, keep the key in your environment or a secret manager (for
example 1Password); never put it in a committed file.

## MCP tools

Both tools are read-only. Every summary carries a `note` saying that pricing is
not an official quote.

### `future_lookup_part`

Look up one part by manufacturer part number (GET `/lookup`).

| Input         | Type    | Default   | Limits and notes                                                                 |
|---------------|---------|-----------|----------------------------------------------------------------------------------|
| `part_number` | string  | required  | At least 3 alphanumeric characters (punctuation allowed but not counted).       |
| `lookup_type` | enum    | `exact`   | `exact`, `starts_with`, `contains`, or `default` (the API's own default).        |
| `quantity`    | integer | none      | Positive. Adds `price_at_quantity` to each offer.                                |
| `max_offers`  | integer | `10`      | 1 to 50. Offers beyond this are dropped; `total_offers` gives the full count.    |
| `raw`         | boolean | `false`   | Return the untouched upstream response (offers still truncated to `max_offers`). Ignores `quantity`. |

**Output:** `lookup_value`, `lookup_results`, `note`, `total_offers`,
`quantity` (when given), and `offers[]`. Each offer can have `mpn`,
`seller_part_number`, `web_url`, `quantity_available`, `quantity_on_order`,
`quantity_minimum`, `order_mult_qty`, `lead_time` (for example `"12 Weeks"`,
or `"CALL"`), `currency_code`, `pricing_type`, `price_breaks[]`
(`{from, to?, unit_price}`, sorted by `from`), `package_type`, `mpq`, `rohs`,
`date_code`, `datasheet_url`, and `price_at_quantity`. Fields missing upstream
are omitted. `price_at_quantity` is either `{price_break: {...}}` or
`{price_break: null, reason}`, where `reason` is `below_minimum` (with
`quantity_minimum`), `no_pricing`, or `no_matching_break`.

Example, from the synthetic test fixture (`part_number: "TEST-1234"`,
`quantity: 5000`, `max_offers: 1`):

```json
{
  "lookup_value": "TEST-1234",
  "lookup_results": "2 Offers found",
  "note": "Pricing is not an official quote. Confirm price and availability with Future Electronics before ordering.",
  "total_offers": 2,
  "offers": [
    {
      "mpn": "TEST-1234",
      "seller_part_number": "9999999",
      "web_url": "https://example.com/p/9999999",
      "quantity_available": 12000,
      "quantity_on_order": 5000,
      "quantity_minimum": 1000,
      "order_mult_qty": 1000,
      "lead_time": "12 Weeks",
      "currency_code": "USD",
      "pricing_type": "Preferred",
      "price_breaks": [
        { "from": 1000, "to": 4999, "unit_price": 0.42 },
        { "from": 5000, "unit_price": 0.37 }
      ],
      "package_type": "REEL",
      "mpq": "1000",
      "rohs": "Y",
      "datasheet_url": "https://example.com/docs/test-1234.pdf",
      "price_at_quantity": { "price_break": { "from": 5000, "unit_price": 0.37 } }
    }
  ],
  "quantity": 5000
}
```

### `future_lookup_parts`

Look up many parts at once, for example a BOM (POST `/batch/lookup`, exact
match).

| Input   | Type    | Default  | Limits and notes                                                                                   |
|---------|---------|----------|----------------------------------------------------------------------------------------------------|
| `parts` | array   | required | 1 to 2000 items. Each is a string (`"LM317T"`) or `{"part_number": "LM317T", "quantity": 500}`. Part numbers must not be blank; `quantity` is an optional positive integer up to 1,000,000,000. |
| `raw`   | boolean | `false`  | Return the untouched upstream batch responses instead of per-part summaries. Much larger.         |

Behavior:

- Part numbers are trimmed and deduplicated case-insensitively. The first
  spelling wins, and the quantities of duplicates are summed. Parts with no
  quantity are priced at quantity 1.
- Parts with fewer than 3 alphanumeric characters are reported as `error` and
  never sent.
- The rest are sent sequentially in batches of up to 300. A failed batch marks
  only its own parts as `error`; the other batches still run.
- The call is flagged as an error only when nothing succeeded (every batch
  failed, or every part was invalid).

**Output:** `note`, `totals` (`requested`, `unique`, `found`, `not_found`,
`errors`, `batches`), and `parts[]`, one per unique part, in input order. Each
has `part_number`, `quantity`, and `status` (`found`, `not_found`, or
`error`). Found parts add `offer_count` and details from the best offer (the
one with the most stock): `mpn`, `quantity_available`, `lead_time`,
`currency_code`, and `price` (the same shape as `price_at_quantity` above).
Error parts add `error`. With `raw: true` the output is `note`, `totals`,
`batches[]` (each `{part_numbers, response}` or `{part_numbers, error}`), and
`invalid_parts[]` when any were rejected.

Example, from the synthetic batch fixture (`parts: ["TEST-0000", "TEST-5678"]`):

```json
{
  "note": "Pricing is not an official quote. Confirm price and availability with Future Electronics before ordering.",
  "totals": { "requested": 2, "unique": 2, "found": 1, "not_found": 1, "errors": 0, "batches": 1 },
  "parts": [
    { "part_number": "TEST-0000", "quantity": 1, "status": "not_found" },
    {
      "part_number": "TEST-5678",
      "quantity": 1,
      "status": "found",
      "offer_count": 1,
      "mpn": "TEST-5678",
      "quantity_available": 250,
      "lead_time": "8 Weeks",
      "currency_code": "EUR",
      "price": { "price_break": { "from": 1, "to": 99, "unit_price": 0.15 } }
    }
  ]
}
```

## Errors

Tool errors come back as MCP results with `isError: true` and a message that
never contains the key. For HTTP errors, the API's own message is appended
when it sends one.

| Cause                       | Message starts with                                              |
|-----------------------------|------------------------------------------------------------------|
| `FUTURE_API_KEY` not set    | `FUTURE_API_KEY is not set.`                                     |
| Part number too short       | `Part number must contain at least 3 alphanumeric characters.`   |
| Bad `lookup_type`           | `lookup_type must be one of: …`                                  |
| HTTP 400                    | `Bad request: the Future API rejected the part number or lookup type.` |
| HTTP 401                    | `Invalid API key: check the FUTURE_API_KEY environment variable.` |
| HTTP 402                    | `Purchase required: this API key does not include access to this request.` |
| HTTP 403                    | `Not authorized: this API key is not allowed to make this request.` |
| HTTP 406                    | `API key expired: request a new key from Future Electronics.`    |
| HTTP 429                    | `Rate limited: too many requests to the Future API. Try again later.` |
| Other HTTP status           | `Future API request failed with HTTP <status>.`                  |
| No response in 30 s         | `Timed out after 30000 ms waiting for the Future API.`           |
| Connection failure          | `Network error contacting the Future API: …`                     |
| Unexpected response body    | `Unexpected response shape from the Future API …`                |

## Troubleshooting

- **`FUTURE_API_KEY is not set`.** The server started, but the key did not
  reach it. For the plugin, make sure you entered a key at the install
  prompt, then restart Claude Code. For `claude mcp add`, remove and re-add the
  server with `-e FUTURE_API_KEY=…` (`claude mcp get future-electronics` shows
  what is configured).
- **401 (invalid key) or 406 (expired key).** Check for a typo, stray quotes,
  or whitespace in the key. An expired key has to be replaced: request a new
  one from Future Electronics, update your environment or secret manager, and
  restart Claude Code.
- **402 (purchase required) or 403 (not authorized).** The key is valid but
  your account does not include this request. Contact Future Electronics about
  your API access; changing the key's format won't help.
- **429 (rate limited).** The client already retries twice, honoring
  `Retry-After` (capped at 30 s) or backing off exponentially. If you still get
  429, wait before retrying and send fewer calls. `future_lookup_parts` sends
  its batches one after another for this reason, so prefer one large call over
  many small ones.
- **The server doesn't start, or `dist/index.js` is not found.** Run
  `npm ci && npm run build` in the clone, and check `node --version` is 22.12
  or later.

## Live check (opt-in)

`npm run live-check` makes one real `exact` lookup of part `292230-6` and prints
the summarized result. It reads `FUTURE_API_KEY` from the environment, never
prints it, and exits non-zero with a clear message when the key is missing or
the call fails. It is not part of `npm test` or CI.

```bash
FUTURE_API_KEY="…" npm run live-check
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
