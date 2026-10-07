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
| `FUTURE_MAX_CONCURRENCY` | No            | Most requests in flight to the Future API at once, across all tool calls. Integer 1–32, default `4`. |
| `FUTURE_MIN_REQUEST_INTERVAL_MS` | No    | Minimum gap between request starts, in ms. Integer 0–60000, default `0` (no pacing). |
| `FUTURE_WORKSPACE_DIR` | No              | Absolute path of the [workspace folder](#workspace-folder) for BOM files and exports. |
| `FUTURE_MAX_OUTPUT_TOKENS` | No          | Most tokens one tool result may use, estimated as characters / 4. Integer 1000–100000, default `8000`. See [Output budget](#output-budget). |

The server **starts without a key**. The key is read the first time a tool is
called, and a missing key fails only that call, with a clear error. With the
plugin install, Claude Code sets `FUTURE_API_KEY` from the key you entered at
install. Otherwise, keep the key in your environment or a secret manager (for
example 1Password); never put it in a committed file.

Future Electronics publishes no numeric rate limit; its docs only say that a
`429 Too Many Requests` means "please wait and try again". The server therefore
caps parallel requests (`FUTURE_MAX_CONCURRENCY`) and does not pace them by
default. After a 429, it pauses every new request, server-wide, for the
`Retry-After` period (seconds or an HTTP date) or the backoff delay. Requests
already in flight finish normally. Invalid values for either setting fail the
first tool call with a clear error.

### Workspace folder

The server reads BOM files from, and writes exports to, **one workspace
folder**. That lets file-based BOM workflows run in Claude Desktop without a
separate filesystem connector.

- **Default:** `~/Documents/Future Electronics MCP`, or
  `~/Future Electronics MCP` if you have no Documents folder.
- **Change it:** in Claude Desktop, open **Settings → Extensions → Future
  Electronics Part Lookup** and pick a folder. With the Claude Code plugin,
  set the optional **Workspace folder** option (leave it blank for the
  default). Anywhere else, set `FUTURE_WORKSPACE_DIR` to an absolute path.
- The folder is created, readable only by you (mode `0700`), the first time
  something is saved there. The server never creates it at startup.
- **The server only reads and writes inside this folder.** It rejects `..`
  paths, absolute paths elsewhere, and symlinks that lead outside it.

## MCP tools

All tools are read-only. `future_list_bom_files` is described under
[BOM files](#bom-files). Every summary carries a `note` saying that pricing is
not an official quote.

### Output budget

Tool results are compact JSON (no whitespace), and no result is longer than
`FUTURE_MAX_OUTPUT_TOKENS` (default 8000 tokens, estimated as characters / 4).
When a result would be longer, rows are dropped from the end of its lists
(`offers`, the `issues` or `parts` table rows, or raw `batches`) and a
`truncated: {omitted, hint}` field says how many were dropped. Nothing is ever
cut silently. If even the result without those lists is too long, the tool
returns `{error: "output_budget_exceeded", message}` with `isError: true`
instead of partial JSON.

### `future_lookup_part`

Look up one part by manufacturer part number (GET `/lookup`).

| Input         | Type    | Default   | Limits and notes                                                                 |
|---------------|---------|-----------|----------------------------------------------------------------------------------|
| `part_number` | string  | required  | At least 3 alphanumeric characters (punctuation allowed but not counted).       |
| `lookup_type` | enum    | `exact`   | `exact`, `starts_with`, `contains`, or `default` (the API's own default).        |
| `quantity`    | integer | none      | Positive. Adds `price_at_quantity` to each offer.                                |
| `max_offers`  | integer | `10`      | 1 to 50. Offers beyond this are dropped; `total_offers` gives the full count.    |
| `raw`         | boolean | `false`   | Return the untouched upstream response (offers still truncated to `max_offers`). Ignores `quantity`. |

**Output** (subject to the [output budget](#output-budget), which drops
offers from the end): `lookup_value`, `lookup_results`, `note`, `total_offers`,
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
`quantity: 5000`, `max_offers: 1`), pretty-printed here:

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
| `parts` | array   | one of `parts`/`bom_file` | 1 to 2000 items. Each is a string (`"LM317T"`) or `{"part_number": "LM317T", "quantity": 500}`. Part numbers must not be blank; `quantity` is an optional positive integer up to 1,000,000,000. |
| `bom_file` | object | one of `parts`/`bom_file` | Read the parts from a CSV/TSV file in the [workspace folder](#workspace-folder) instead. See [BOM files](#bom-files). |
| `detail` | enum   | `summary` | `summary`: totals plus an `issues` table of problem parts only. `all`: a `parts` table row for every part. |
| `raw`   | boolean | `false`  | Return the untouched upstream batch responses instead of the summary. Far larger, so the budget usually drops whole batches. |

Behavior:

- Part numbers are trimmed and deduplicated case-insensitively. The first
  spelling wins, and the quantities of duplicates are summed. Parts with no
  quantity are priced at quantity 1.
- Parts with fewer than 3 alphanumeric characters are reported as `error` and
  never sent.
- The rest are sent in batches of up to 300. Up to `FUTURE_MAX_CONCURRENCY`
  batches (default 4) run in parallel, started in input order; the output
  order never depends on which batch finishes first. A failed batch marks only
  its own parts as `error`; the other batches still run.
- If a batch still gets HTTP 429 after the client's retries, the lookup stops
  early: no new batch starts, batches already running finish and are reported
  normally, and the parts of batches never started get status
  `not_attempted`. `totals.rate_limited` is then `true`, and
  `not_attempted_note` says to retry those parts later.
- The call is flagged as an error only when nothing succeeded (every batch
  failed or was not attempted, or every part was invalid).

**Output** is problems-first, so its size grows with the number of problems,
not with the size of the BOM. Each part is judged on its best offer (the one
with the most stock) at its quantity (1 when none was given):

- `result_id`: the id of the full stored result. Pass it to
  [`future_query_results`](#future_query_results) to read any other rows or
  columns without calling the API again.
- `note` and `totals`: `requested`, `unique`, `found`, `not_found`, `errors`,
  `not_attempted`, `short_stock`, `below_moq`, `call_for_leadtime`, `batches`,
  and `rate_limited`.
- `extended_cost`: quantity × the unit price of the applicable price break,
  summed over found parts, per currency code (for example
  `{"USD": 1234.5, "EUR": 80}`), rounded to cents.
- `unpriced`: found parts with no applicable price break (for example below
  the first break), left out of `extended_cost`.
- `max_lead_time`: the longest lead time among found parts, as reported
  (`"CALL"` lead times are counted in `call_for_leadtime` instead).
- `issues`: a table, `{columns, rows}`, of **only the parts with problems**,
  in input order. Columns: `part_number`, `status`, `reason`, `quantity`,
  `available`, `lead_time`. Parts with no problem appear only in the counts.

Problem reasons (a part can have several, joined by `;` in `reason`):

| Reason              | When                                                                         |
|---------------------|------------------------------------------------------------------------------|
| `short_stock`       | `quantity_available` < the quantity (unknown stock is not flagged).          |
| `below_moq`         | A given quantity < the offer's `quantity_minimum`. Not checked for parts with no quantity. |
| `call_for_leadtime` | The factory lead time is `"CALL"`.                                           |
| `not_found`         | No offer for the part.                                                       |
| `error: <message>`  | The part was invalid, or its batch failed.                                   |
| `not_attempted`     | Its batch never started because of the rate limit.                           |

With `detail: "all"` the `issues` table is replaced by a `parts` table with a
row for every part: `part_number`, `mpn`, `status`, `reason` (empty when
none), `quantity`, `available`, `moq`, `lead_time`, `currency`, and
`unit_price` (null when no price break applies). Long tables are cut by the
[output budget](#output-budget), with a `truncated` note.

With `raw: true` the output is `result_id`, `note`, `totals`, `batches[]` in input order
(each `{part_numbers, response}`, `{part_numbers, error}`, or
`{part_numbers, not_attempted: true, error}` for a batch skipped after a rate
limit), and `invalid_parts[]` when any were rejected. A 300-part raw batch is
far larger than the default budget, so raw output is only practical for a
small batch.

Example, from the synthetic batch fixture (`parts: ["TEST-0000",
{"part_number": "TEST-5678", "quantity": 500}]`), pretty-printed here:

```json
{
  "result_id": "3f0c2a9e-5b7d-4c1e-9a8f-2d6b1e4c7a90",
  "note": "Pricing is not an official quote. Confirm price and availability with Future Electronics before ordering.",
  "totals": {
    "requested": 2, "unique": 2, "found": 1, "not_found": 1, "errors": 0,
    "not_attempted": 0, "short_stock": 1, "below_moq": 0, "call_for_leadtime": 0,
    "batches": 1, "rate_limited": false
  },
  "extended_cost": { "EUR": 45 },
  "unpriced": 0,
  "max_lead_time": "8 Weeks",
  "issues": {
    "columns": ["part_number", "status", "reason", "quantity", "available", "lead_time"],
    "rows": [
      ["TEST-0000", "not_found", "not_found", 1, null, null],
      ["TEST-5678", "found", "short_stock", 500, 250, "8 Weeks"]
    ]
  }
}
```

### BOM files

Instead of listing thousands of part numbers in the tool call, save the BOM
as a `.csv` or `.tsv` file in the [workspace folder](#workspace-folder) and
name it:

- **Claude Desktop:** save `bom.csv` in the workspace folder (by default
  `Documents/Future Electronics MCP`), then ask "look up bom.csv". No
  filesystem connector is needed.
- **Claude Code:** copy the file into the workspace folder the same way, then
  ask "look up bom.csv".

The model can call `future_list_bom_files` to see the files there. It takes no
input and returns a `files` table with `name`, `size_bytes` and `modified`
(ISO 8601).

`bom_file` fields:

| Field             | Default     | Notes                                                                        |
|-------------------|-------------|------------------------------------------------------------------------------|
| `path`            | required    | File name in the workspace folder (a subfolder path is fine). `.csv` or `.tsv`, any case. |
| `part_column`     | auto-detect | Header name (case-insensitive) or 1-based column number.                    |
| `quantity_column` | auto-detect | Header name or 1-based column number.                                       |
| `has_header`      | `true`      | Without a header, the part number is column 1 and there is no quantity unless `quantity_column` is given. |
| `delimiter`       | auto-detect | `,`, `;` or tab. Detected as the most frequent of the three in the first line. |

Column detection compares headers ignoring case and extra spaces:

- Part number: `mpn`, `manufacturer part number`, `part number`,
  `part_number`, `mfr part`, `pn`
- Quantity: `qty`, `quantity`, `quantity per`, `count`

If no part column matches, or more than one header matches either list, the
call fails with a message listing the headers it found; name the column with
`part_column` or `quantity_column`. With no quantity column, parts are priced
at quantity 1.

Reading rules: files must be UTF-8 (a byte-order mark is fine) and at most
5 MB. Quoted fields, `""` escapes, delimiters and line breaks inside quotes,
and CRLF line ends are all handled (RFC 4180). Blank rows are ignored. Rows
with an empty part number are skipped and counted. A quantity must be empty or
a whole number from 1 to 1,000,000,000 (`100.00` is fine); any other value
fails the call, naming the rows. The 2000-part limit applies after
duplicates are merged. Errors name the file only as you gave it, never the
workspace path.

The result also carries `source: {file, rows_read, rows_skipped,
part_column, quantity_column}` so you can check how the file was read.

### `future_query_results`

Read any part of a stored `future_lookup_parts` result by its `result_id`,
**without calling the Future API**. Use it to page through every part, pull
extra columns, or filter a BOM instead of re-running the lookup.

| Input                 | Type     | Default  | Limits and notes                                                        |
|-----------------------|----------|----------|-------------------------------------------------------------------------|
| `result_id`           | string   | required | From a `future_lookup_parts` result.                                     |
| `status`              | string[] | none     | Keep parts with any of: `found`, `not_found`, `error`, `not_attempted`.  |
| `min_lead_time_weeks` | number   | none     | Keep parts whose lead time is at least this many weeks. `"CALL"` and unknown lead times are excluded. |
| `short_stock`         | boolean  | none     | `true`: only short-stock parts. `false`: only parts without that problem. |
| `below_moq`           | boolean  | none     | `true`: only below-MOQ parts. `false`: only parts without that problem.  |
| `part_numbers`        | string[] | none     | Keep these part numbers (case-insensitive).                              |
| `fields`              | string[] | all      | Columns to return, in order: `part_number`, `mpn`, `status`, `reason`, `quantity`, `available`, `moq`, `lead_time`, `currency`, `unit_price`. An unknown name is rejected with the list of valid ones. |
| `offset`              | integer  | `0`      | Matching rows to skip.                                                   |
| `limit`               | integer  | `50`     | 1 to 500 rows.                                                           |

Filters combine with AND. The output is `result_id`, `note`,
`total_matching` (after filters, before paging), `offset`, `next_offset`
(`null` on the last page), and a `{columns, rows}` table in input order. It is
capped by the [output budget](#output-budget); when rows are dropped,
`truncated` says so and `next_offset` points at the first dropped row.

Results live **in memory only**, never on disk. Each expires 60 minutes after
it was last stored or queried, at most 20 are kept (the least recently used is
evicted first), and all are lost when the server restarts. An unknown or
expired `result_id` returns an `isError` result saying to run
`future_lookup_parts` again. The id is a random UUID.

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
  429, wait before retrying and send fewer calls. `future_lookup_parts` stops
  starting new batches after such a 429 and marks the rest `not_attempted`;
  retry just those parts later. Prefer one large call over many small ones. If 429s keep happening, lower `FUTURE_MAX_CONCURRENCY` (for
  example to `1` or `2`) or set `FUTURE_MIN_REQUEST_INTERVAL_MS` (for example
  `500`) to space requests out, then restart the server.
- **The server doesn't start, or `dist/index.js` is not found.** Run
  `npm ci && npm run build` in the clone, and check `node --version` is 22.12
  or later.

## Live check (opt-in)

`npm run live-check` makes one real `exact` lookup of part `292230-6` and prints
the summarized result. It reads `FUTURE_API_KEY` from the environment, never
prints it, and exits non-zero with a clear message when the key is missing or
the call fails. It is not part of `npm test`.

```bash
FUTURE_API_KEY="…" npm run live-check
```

GitHub Actions also runs it as the `live-check` job, but only for releases:

- **Release PRs** (`dev` → `master`) from this repo, in `ci.yml`. It is a
  required check, so a release PR cannot merge until it passes. PRs into `dev`
  and fork PRs skip it.
- **Published releases**, in `release.yml`. The `.mcpb` is attached only after
  the check passes against the tagged commit.
- **Manual runs**, by dispatching the `CI` workflow.

The key comes from the `FUTURE_API_KEY` secret of the `live-api` GitHub
Environment, which requires the maintainer's approval for each run. It is not a
repository secret, so no other job can read it.

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
