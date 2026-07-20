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

`symbol` is the NSE/BSE trading symbol, e.g. `TCS`, `RELIANCE`, `MTARTECH`.

## Install & build

```bash
npm install
npm run build
```

## Run

```bash
npm start          # node dist/index.js  (stdio transport)
# or during development:
npm run dev        # tsx src/index.ts
```

## Use from Claude Code

Add to your MCP config (`.mcp.json` or global), pointing at the built entry:

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

Then an agent can call `get_fundamentals`, `get_financials`, `get_peers`, `get_chart`.

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
