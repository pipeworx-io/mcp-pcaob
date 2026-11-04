# @pipeworx/pcaob

PCAOB Form AP auditor↔issuer engagements and firm inspection reports — hosted, keyless to the
caller. Fleet #624: "who audits Company X and which engagement partner signed", "every issuer
audited by Firm Y", and "has PCAOB found deficiencies at Firm Y" had no surface before this pack.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1867+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `pcaob_auditor_of(company)` — which firm audits a company and who the engagement partner is.
  Resolves a ticker/company name to SEC CIK first (`resolveSecEntity`, the same universe `edgar`
  and `sec` key on); falls back to an issuer-name search across Form AP filings for issuers without a
  clean SEC ticker (funds, broker-dealers).
- `pcaob_firm_engagements(firm, fiscal_year?, limit?)` — every issuer a firm reported auditing,
  optionally scoped to one fiscal year. `firm` matches a numeric PCAOB Firm ID exactly, otherwise
  an ILIKE name search.
- `pcaob_partner_engagements(partner, limit?)` — every issuer one named engagement partner signed
  for.
- `pcaob_auditor_changes(days?, limit?)` — issuers whose most recent Form AP filing names a
  different firm than their prior filing, where the change landed in the last N days. Scans up to
  1,500 issuers with a filing in the window (response says so if capped).
- `pcaob_inspection_reports(firm, limit?)` — PCAOB inspection history for a firm: report year,
  Part I.A deficiency rate, audits reviewed, PDF link.

## Data

Two tables, mirrored by `workers/data-pipeline` (`workers/data-pipeline/src/datasets/pcaob.ts`),
migration `supabase/migrations/107_pcaob_form_ap_inspections.sql`:

- `pcaob_form_ap` — PCAOB's own bulk download of the entire AuditorSearch dataset
  (`assets.pcaobus.org/firm-filings/FirmFilings.zip`), ~156k rows as of 2026-08. Refreshed weekly;
  quoted CSV with embedded commas in issuer names, so ingest rides the slow parser and drains over
  several cron ticks via the resume-offset protocol (same pattern as USAspending).
- `pcaob_inspection_reports` — the Firm Inspection Reports downloadable dataset PCAOB publishes at
  `pcaobus.org/oversight/inspections/firm-inspection-reports`, ~4.3k rows (one per firm per
  inspection report). **Uses the JSON variant of the dataset, not the CSV** — PCAOB's CSV file is
  UTF-16LE encoded and this pipeline's parser is fixed at UTF-8; the JSON export of the identical
  data is plain UTF-8 and small enough to parse whole-body (`format: 'json'` in the data-pipeline
  runner, added for this pack — see the runner's comment for why).

## Identity notes

- **Issuer CIK** can be blank for non-SEC registrants (some broker-dealers) — those rows are kept
  under `issuer_name` only, never dropped.
- **Firm names vary by country affiliate** ("PwC LLP" vs "PricewaterhouseCoopers LLP"). Search
  matches on the numeric PCAOB Firm ID when the input is all-digits, ILIKE name otherwise, and
  every response echoes the firm_id(s)/firm_name(s) it actually matched.
- **`pcaob_auditor_changes` compares each issuer's own filing history**, not a table-wide diff —
  PostgREST has no window functions, so this pulls a bounded recent history per issuer batch and
  picks the two most recent filings client-side. It is a real scan (not an aggregate query), hence
  the 1,500-issuer cap per call.

## Caveat carried on every response

Form AP covers US issuer audits only, self-reported by the audit firm. Firm inspection findings are
Part I.A **summary counts** from PCAOB's published dataset, not the full report text — the PDF link
is provided for that.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pcaob": {
      "url": "https://gateway.pipeworx.io/pcaob/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pcaob/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1867+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pcaob_auditor_of \
  -H 'Content-Type: application/json' \
  -d '{"company":"Tesla"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pcaob_auditor_of`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-pcaob` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/pcaob/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "pcaob": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pcaob"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pcaob data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
