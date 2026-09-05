# screener-mcp

An [MCP](https://modelcontextprotocol.io) server exposing **Screener.in** data for
Indian stocks (NSE/BSE) — fundamentals, financial statements, peers, price/EPS
time-series, and **stock screening that works without an account** — as tools any
MCP client (Claude, etc.) can call.

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
| `screen_stocks` | `query`, `limit?`, `sort?`, `order?`, `minMarketCapCr?`, `refresh?` | Screens **~5,400 companies with no sign-in**. Nine metrics; see [Screening](#screening) |
| `get_public_screen` | `screen`, `maxPages?`, `sort?`, `order?` | Reads a **saved** screen by id or URL, no sign-in. Also returns the screen's own DSL |
| `build_screen_link` | `query` | A link the *user* clicks to run any query in their own signed-in browser, plus the words to send with it |
| `list_public_screens` | `page?`, `maxPages?` | Screener's directory of public screens, for finding one that already exists |
| `run_screen` | `query`, `maxPages?`, `sort?`, `order?` | Screener's own DSL endpoint — the full ratio vocabulary. **Needs sign-in** |
| `screener_auth_status` | — | Four-state sign-in report with an instruction to relay. See [Signing in](#signing-in-optional) |

`get_fundamentals` returns what Screener displays (`"₹ 17,60,650 Cr."`); `get_ratios` returns
what you can compute with (`marketCapCr: 1760650`). Reach for `get_ratios` when comparing or
grading stocks, `get_fundamentals` when showing a human the page as-is.

Banks and NBFCs get `null` for `debtEquity` and `salesGrowth3yPct` on purpose — their
"Borrowings" are customer deposits and their "Sales" is interest income, so those ratios
don't mean what they mean elsewhere. `isFinancialCompany` and `caveats` say when this applied.

## Screening

Screener gates its DSL endpoint (`/screen/raw/`) behind a login, so there are three routes
to a screen. **Start with `screen_stocks`** — it needs no account at all.

### `screen_stocks` — no account, whole market

Screener publishes the same table a screen renders on its public industry pages under
`/market/`. `screen_stocks` sweeps them into a local cache — **5,438 companies** as of
2026-09-04, from Bharti Airtel down to sub-crore microcaps — and evaluates your query
against all of it. That's the whole listed universe, not 50 rows a page.

```
Return on capital employed > 15 AND Market Capitalization > 10000
  AND YOY Quarterly profit growth > 20
```

The trade is vocabulary. Only these nine metrics exist anonymously:

`Current price` · `Price to Earning` · `Market Capitalization` · `Dividend yield` ·
`Net Profit latest quarter` · `YOY Quarterly profit growth` · `Sales latest quarter` ·
`YOY Quarterly sales growth` · `Return on capital employed`

A clause on anything else — ROE, debt/equity, Piotroski, promoter holding, 3-year growth —
is **not silently dropped**. It comes back in `unappliedClauses`, the rows are labelled a
*superset* of your query, and `note` says so in plain language. The intended workflow is
"narrow here, then call `get_ratios` per shortlisted symbol to check the rest". A query
where *nothing* applies throws rather than handing back 5,438 rows dressed up as a result.

Only `AND` is supported; `OR` and parentheses land in `unappliedClauses` too.

#### Cold-call cost, and how to cut it

The first call builds the cache by sweeping Screener at a deliberately slow ~0.77 req/s, so
its cost is essentially the number of pages fetched. **A market-cap floor in the query cuts
that by 7×**, because two properties of these pages compound:

- `/market/`'s four-level taxonomy **aggregates**. Only the 188 leaves are linked, but the
  1-, 2- and 3-level prefixes are live URLs serving the union of their children —
  `/market/IN02/` reports 1,402 companies, matching what its 12 leaves held. So the same
  universe is reachable from **12 sector pages instead of 188 leaves**.
- Every page is strictly **market-cap descending** (verified across all 188 leaves and 5,438
  rows, zero inversions). So a query with a market-cap floor can stop paging a sector the
  moment its rows drop below the floor.

Coarse buckets are what make the floor pay: the fixed one-page-per-bucket cost is 12 requests
rather than 188, leaving early termination something to save. Measured:

| Sweep | Pages | Time |
|---|---|---|
| 188 leaves, no floor (the old default) | 334 | 449 s |
| 12 sectors, no floor | 223 | ~300 s |
| 12 sectors, `Market Capitalization > 1000` | 70 | ~94 s |
| 12 sectors, `Market Capitalization > 10000` | **32** | **36 s** |

That last row is measured end-to-end and returns the *identical* 152 matches the 449 s sweep
did. So put a market-cap clause in the query when you can, or set `minMarketCapCr` when the
DSL has no such clause but the user doesn't care about microcaps — it's reported back as an
applied clause, since it narrows the answer.

The pacing constants are untouched; the speed-up is entirely fewer requests. Results are
cached 12 h. Progress goes to stderr, which most MCP clients surface as server logs.

Two things a floored sweep gives up, both reported rather than hidden. `universeSize` counts
only companies at or above the floor, so it is **not** the size of the market — the result
carries `universeMinMarketCapCr` and says so in `note`. And a cache swept to floor F is only
reused for queries whose own floor is ≥ F; widen the query below F and it re-sweeps rather
than answer from a universe that is missing exactly the companies you just asked for.

Sector-level sweeping also makes each row's `industryName` a sector ("Consumer Discretionary")
rather than a specific industry ("Commodity Chemicals"). `industryLevel` on every row says
which you got, and `note` mentions it.

### `build_screen_link` + `get_public_screen` — any query, still no credential

When a query needs a metric `screen_stocks` lacks, don't ask the user for a cookie — hand
them a link. `build_screen_link` mints a `/screen/new/?query=…` URL and the words to send
with it. Their browser is already signed in to Screener, so the screen runs *there*.

Once they save it, the screen lives at `/screens/<id>/<slug>/`, which is **readable
anonymously, with pagination, and doesn't expire**. They paste that address back and
`get_public_screen` can read it forever. One click converts a login-gated query into a
permanent public read.

`get_public_screen` is liberal about what it accepts — a bare id, a full URL, a URL with a
`?page=2` tail, a missing scheme — because that's where a non-technical user's copy-paste
lands. It also returns the screen's own DSL in `query`, so you can see what a saved screen
actually filters on.

One limit, measured rather than assumed: **`?sort=` is login-gated**, and the gate is on the
parameter rather than its value (`?sort=name` redirects too), while `?page=` passes and
`?order=` passes but is then ignored. So there is no anonymous ordering lever. `sort` raises
an auth error instead of sorting whichever 25 rows happened to be fetched and calling them
the top. To get "the biggest in this screen" anonymously, raise `maxPages` to cover the
screen and order the rows yourself.

### `run_screen` — the full vocabulary, with sign-in

Screener's own DSL endpoint, 50 rows per page, every ratio it supports:

```
Return on capital employed > 15 AND Debt to equity < 1
  AND Piotroski score >= 7 AND Market Capitalization > 5000
```

This is the one tool that **requires sign-in** — Screener redirects anonymous callers to
`/register/`. Use it when `screen_stocks` can't express the query.

`symbol` is the NSE/BSE trading symbol, e.g. `TCS`, `RELIANCE`, `MTARTECH`. Every screening
tool returns a `slug` per row that works as `symbol` for the others.

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

That's the whole setup. Fundamentals, financials, peers, charts and `screen_stocks` all
work immediately, with no account.

To pin a version, use `screener-mcp@0.2.0`. To run straight from git without npm:
`npx -y github:ashu017/screener-mcp` (builds on install via the `prepare` script).

## Signing in (optional)

Sign-in buys exactly one thing: `run_screen`'s full ratio vocabulary. Everything else,
screening included, works anonymously — so treat this as optional.

Screener has no OAuth or API keys. It's a Django app, so being "signed in" means holding a
`sessionid` cookie. Three ways to get one:

```bash
npx screener-mcp login --chrome     # opens the Chrome you already have (easiest)
npx screener-mcp login --browser    # same, via a browser Playwright downloads
npx screener-mcp login              # email + password, prompted with no echo
npx screener-mcp status             # is my session still valid?
npx screener-mcp logout             # delete it
```

Only the returned cookie is kept, in `~/.config/screener-mcp/session.json` at mode `0600` —
never a password, never anything in an MCP config file. The session outlives the server
process, so you log in once, not per MCP session.

When the cookie expires, tools return an instruction to re-run `login` instead of failing
obscurely, and agents can call `screener_auth_status` deliberately. That tool reports **four**
states, not two: `active`, `anonymous`, `expired`, and `unknown` — the last meaning Screener
couldn't be reached, so it is *not* a sign-in problem and the user shouldn't be sent to log
in again over a dropped connection. Each state carries an `instruction` written to be relayed
verbatim, including the case where `SCREENER_SESSION_ID` is the thing that expired and running
`login` therefore won't help.

### `login --chrome` (recommended)

Drives the Chrome, Chromium, Edge or Brave **already installed on your machine** over the
DevTools Protocol. Nothing to download, and no new dependency in this package — it uses
Node's built-in WebSocket.

It opens Screener's login page in a browser profile of its own, kept at
`~/.config/screener-mcp/browser-profile` (mode `0700`), so your everyday tabs, bookmarks and
history are untouched. You sign in however you normally do; it watches for `sessionid`,
verifies it, saves it, and closes the browser. Nothing you type passes through the CLI.

Two requirements: **Node 22+** (older versions have no built-in WebSocket) and a display.
The server itself still runs on Node 18 — this limit applies only to `--chrome`.

It reads `sessionid` even though the cookie is `HttpOnly`, which a browser console could not
do, and captures `csrftoken` alongside it. It never touches your default Chrome profile:
Chrome 136+ refuses remote debugging there outright, and the consent-gated path Chrome 144
added needs a checkbox in `chrome://inspect` plus an Allow dialog on *every* run — a harder
and scarier ask than signing in once in a fresh window.

### `login --browser`

The same flow through Playwright, which downloads its own Chromium. Use it if `--chrome`
can't find a browser. Needs **Playwright** — not a dependency of this package, since it
pulls a several-hundred-megabyte browser and most installs only ever run the server:

```bash
npm install playwright && npx playwright install chromium
```

It's looked up in your working directory and the global npm root; `SCREENER_PLAYWRIGHT_PATH`
points at it anywhere else. Needs **Node 20+**.

### `login` (email + password)

Posts once to Screener's own `/login/` form and keeps the `sessionid` it returns. Your
password is used for that single request and is never stored or logged.

Screener also offers `/login/google/` and `/login/apple/`. **If you signed up with Google or
Apple there is no password to post, so this path cannot work for you** — use `--chrome`.

### Cookie by hand

If none of those fit (headless host, or Screener puts a captcha in front of login), sign in
with a browser, take the `sessionid` value from DevTools → Application → Cookies, and pass
it as an env var (this takes precedence over the stored file):

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
| `SCREENER_SESSION_ID` | Use this cookie instead of the stored session. Overrides the file, so `login` can't replace an expired value here |
| `SCREENER_MCP_CONFIG_DIR` | Override where the session, browser profile and universe cache are stored |
| `SCREENER_UNIVERSE_TTL_HOURS` | How long `screen_stocks` reuses its cached sweep (default 12) |
| `SCREENER_USERNAME` / `SCREENER_PASSWORD` | Non-interactive `login`, for CI/headless |
| `SCREENER_BROWSER_EXECUTABLE` | Path to the browser to use for `--chrome` or `--browser` |
| `SCREENER_PLAYWRIGHT_PATH` | Path to a `playwright` module dir, if it isn't in cwd or the global npm root |
| `SCREENER_BROWSER_HEADLESS` | Run browser login headless. Only refreshes an already signed-in profile — it cannot complete a first-time sign-in |
| `SCREENER_USER_AGENT` | Override the User-Agent sent to Screener |

Use your own account only, and note that automated access to account-gated pages is subject
to [Screener's terms](https://www.screener.in/guides/terms/), which license the site's
material "for personal, non-commercial transitory viewing only".

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
- **Screener will IP-block you at the TCP level**, with no 429 first — connections simply
  stop being accepted. Measured: 4 concurrent requests at 200 ms spacing got a host blocked
  for ~57 minutes after roughly 30 requests. `screen_stocks` therefore defaults to 2
  concurrent with 2000 ms spacing, which swept every industry page untouched, and caches the
  result for 12 h. Don't raise those without re-measuring — `screen_stocks` got 12× faster by
  fetching fewer pages, not by pacing them harder, which is the only safe lever here.
- `screener.in/robots.txt` disallows the `?page=`, `?sort=`, `?limit=` and `?q=` query
  parameters. Paginating a screen or an industry page necessarily requests `?page=N`, so
  `screen_stocks`, `get_public_screen` and `run_screen` do send disallowed query strings.
  Page 1 is always fetched as the bare, allowed URL.
- Selectors target Screener's current DOM; if Screener changes markup, the parsers
  (`src/screener.ts`, `src/market.ts`, `src/public-screens.ts`) may need updating. The
  fixture test will catch regressions in the company-page parsers.

## License

MIT
