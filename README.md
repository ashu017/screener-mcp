# screener-mcp

An [MCP](https://modelcontextprotocol.io) server exposing **Screener.in** data for
Indian stocks (NSE/BSE) — fundamentals, financial statements, peers, and price/EPS
time-series — as tools any MCP client (Claude, etc.) can call.

Screener.in is server-rendered (Django), so most data comes from a single HTML GET;
the chart tool uses Screener's JSON chart API.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `get_fundamentals` | `symbol` | Key ratio cards (P/E, P/B, ROE, ROCE, Market Cap, Book Value, Dividend Yield, etc.), pros/cons, about |
| `get_financials` | `symbol` | Statement tables: Quarterly Results, P&L, Balance Sheet, Cash Flow, Ratios, Shareholding |
| `get_peers` | `symbol` | Sector peer comparison table (CMP, P/E, Market Cap, Div Yield, NP, ROCE, sales growth) + sector median |
| `get_chart` | `symbol`, `metric?`, `days?` | Time-series from the chart API. `metric` e.g. `Price-DMA50-Volume`, `Price`, `Quarter Sales`, `EPS` |
| `get_ratios` | `symbol` | The same fundamentals as **typed numbers** (`pe`, `pb`, `roe`, `roce`, `debtEquity`, `salesGrowth3yPct`, `promoterHoldingPct`, …) rather than display strings |
| `get_quarterly_results` | `symbol` | Per-quarter Sales / Net Profit / EPS / OPM keyed by ISO quarter-end date |
| `run_screen` | `query`, `maxPages?`, `sort?`, `order?` | Stocks matching a Screener DSL query. **Needs sign-in** |
| `screener_auth_status` | — | Whether a signed-in Screener session is present and still valid (see [Signing in](#signing-in-optional)) |

`get_fundamentals` returns what Screener displays (`"₹ 17,60,650 Cr."`); `get_ratios` returns
what you can compute with (`marketCapCr: 1760650`). Reach for `get_ratios` when comparing or
grading stocks, `get_fundamentals` when showing a human the page as-is.

Banks and NBFCs get `null` for `debtEquity` and `salesGrowth3yPct` on purpose — their
"Borrowings" are customer deposits and their "Sales" is interest income, so those ratios
don't mean what they mean elsewhere. `isFinancialCompany` and `caveats` say when this applied.

### Screens

`run_screen` takes Screener's own filter DSL and pages through the results (50 per page):

```
Return on capital employed > 15 AND Debt to equity < 1
  AND Piotroski score >= 7 AND Market Capitalization > 5000
```

This is the one tool that **requires sign-in** — Screener redirects anonymous callers to
`/register/`. It's dramatically cheaper than calling `get_ratios` over a whole universe: one
paged request replaces hundreds of per-stock fetches.

`symbol` is the NSE/BSE trading symbol, e.g. `TCS`, `RELIANCE`, `MTARTECH`.

## Use it (no setup)

Requires Node 18+. Nothing to clone or build — add this to your MCP config
(`.mcp.json` in a project, or `~/.claude.json` globally):

```json
{
  "mcpServers": {
    "screener": {
      "command": "npx",
      "args": ["-y", "screener-mcp"]
    }
  }
}
```

Or, from Claude Code:

```bash
claude mcp add screener -- npx -y screener-mcp
```

Then an agent can call `get_fundamentals`, `get_financials`, `get_peers`, `get_chart`.

To pin a version, use `screener-mcp@0.1.0`. To run straight from git without npm:
`npx -y github:ashu017/screener-mcp` (builds on install via the `prepare` script).

## Signing in (optional)

Screener serves more to logged-in accounts. Screener has no OAuth or API keys — it's a
Django app, so being "signed in" means holding a `sessionid` cookie. To get one:

```bash
npx screener-mcp login     # prompts for email + password, no echo
npx screener-mcp status    # is my session still valid?
npx screener-mcp logout    # delete it
```

`login` posts once to Screener's own login form and keeps **only the returned cookie**, in
`~/.config/screener-mcp/session.json` at mode `0600`. Your password is never written to
disk, never logged, and never placed in an MCP config file. All four data tools work
anonymously; sign-in only adds account-gated data.

The session outlives the server process, so you log in once, not per MCP session. When the
cookie expires, tools return an instruction to re-run `login` instead of failing obscurely —
and agents can call `screener_auth_status` to check deliberately.

If Screener ever puts a captcha in front of login, fall back to copying the cookie by hand:
sign in with a browser, take the `sessionid` value from DevTools → Application → Cookies,
and pass it as an env var (this takes precedence over the stored file):

```json
{
  "mcpServers": {
    "screener": {
      "command": "npx",
      "args": ["-y", "screener-mcp"],
      "env": { "SCREENER_SESSION_ID": "your-sessionid-cookie" }
    }
  }
}
```

| Env var | Purpose |
|---|---|
| `SCREENER_SESSION_ID` | Use this cookie instead of the stored session |
| `SCREENER_MCP_CONFIG_DIR` | Override where the session is stored |
| `SCREENER_USERNAME` / `SCREENER_PASSWORD` | Non-interactive `login`, for CI/headless |

Use your own account only, and note that automated access to account-gated pages is subject
to [Screener's terms](https://www.screener.in/terms/).

## Local development

```bash
npm install        # runs tsc via the prepare script
npm run build      # tsc
npm start          # node dist/index.js  (stdio transport)
npm run dev        # tsx src/index.ts
npm test           # vitest (needs Node 20+)
```

Point an MCP client at a local checkout with:

```json
{
  "mcpServers": {
    "screener": {
      "command": "node",
      "args": ["/absolute/path/to/screener-mcp/dist/index.js"]
    }
  }
}
```

## How peers works

Screener lazy-loads the peer table from `GET /api/company/{warehouseId}/peers/` — note
this uses a separate **warehouse id** (from `data-warehouse-id` on the page), *not* the
company id, and requires the `X-Requested-With: XMLHttpRequest` header. `get_peers`
resolves the warehouse id from the company page, fetches that fragment, and parses the
comparison table plus the sector-median row.

## Testing

```bash
npm test
```

Tests run the parsers against a captured Screener HTML fixture (`test/tcs.fixture.html`),
so they are deterministic and don't hit the network.

## Notes / etiquette

- Data is scraped from Screener.in for personal use. Respect their terms and don't hammer
  the site; cache results and rate-limit in your client.
- Selectors target Screener's current DOM; if Screener changes markup, the parsers
  (`src/screener.ts`) may need updating. The fixture test will catch regressions.

## License

MIT
