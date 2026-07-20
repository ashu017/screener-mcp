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
| `get_peers` | `symbol` | Peer comparison (see limitation below) + sector |
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

## Known limitation: peers

Screener **lazy-loads the peer comparison table via JavaScript**, so it is not present
in the server-rendered HTML. `get_peers` therefore returns the company's sector plus a
note, and an empty `peers` array, rather than the full table. Recommended fallback: use
the sector to identify peer symbols and call `get_fundamentals` on each. (A future
version can capture the live peers endpoint via browser devtools and query it directly.)

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
