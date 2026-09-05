#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchCompanyHtml,
  parseFundamentals,
  parseFinancials,
  fetchPeers,
  fetchChart,
  parseCompanyId,
  parseWarehouseId,
  parseQuarterlyResults,
  parseRatios,
  runScreen,
} from "./screener.js";
import { parse } from "node-html-parser";
import { loadSession, sessionState } from "./auth.js";
import { runCli } from "./cli.js";
import { SUPPORTED_METRICS, screenAnonymously } from "./market.js";
import { buildScreenLink, fetchPublicScreen, listPublicScreens } from "./public-screens.js";

// Subcommands (login/status/logout) run instead of the server. An MCP client
// launches us with no arguments, so the server remains the default.
const cliExit = await runCli(process.argv.slice(2));
if (cliExit !== null) process.exit(cliExit);

const server = new McpServer({
  name: "screener-mcp",
  // Kept in step with package.json by hand: importing JSON needs an import
  // attribute, which is Node 20+, and the server still supports 18.
  version: "0.2.0",
});

const symbolArg = { symbol: z.string().describe("NSE/BSE trading symbol, e.g. TCS, RELIANCE, MTARTECH") };

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

server.tool(
  "get_fundamentals",
  "Key ratios scorecard for an Indian stock (P/E, P/B, ROE, ROCE, market cap, dividend yield, etc.), plus pros/cons and a short about, from Screener.in.",
  symbolArg,
  async ({ symbol }) => {
    try {
      const { html, url } = await fetchCompanyHtml(symbol);
      return json(parseFundamentals(symbol, html, url));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "get_financials",
  "Financial statement tables (quarterly results, P&L, balance sheet, cash flow, ratios, shareholding) for an Indian stock, from Screener.in.",
  symbolArg,
  async ({ symbol }) => {
    try {
      const { html } = await fetchCompanyHtml(symbol);
      return json(parseFinancials(html));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "get_peers",
  "Sector peer comparison table for an Indian stock (peers with P/E, ROE, market cap, etc.), from Screener.in.",
  symbolArg,
  async ({ symbol }) => {
    try {
      const { html } = await fetchCompanyHtml(symbol);
      const warehouseId = parseWarehouseId(parse(html));
      if (!warehouseId) return err(`Could not resolve warehouse id for '${symbol}'`);
      return json({ symbol: symbol.toUpperCase(), ...(await fetchPeers(warehouseId)) });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "get_chart",
  "Time-series for an Indian stock from Screener.in's chart API. Metric examples: 'Price-DMA50-Volume', 'Price', 'Quarter Sales', 'EPS'. days: lookback window.",
  {
    ...symbolArg,
    metric: z.string().default("Price-DMA50-Volume").describe("Chart metric key"),
    days: z.number().int().positive().default(365).describe("Lookback in days"),
  },
  async ({ symbol, metric, days }) => {
    try {
      const { html } = await fetchCompanyHtml(symbol);
      const companyId = parseCompanyId(parse(html));
      if (!companyId) return err(`Could not resolve company id for '${symbol}'`);
      return json({ symbol: symbol.toUpperCase(), companyId, series: await fetchChart(companyId, metric, days) });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "get_ratios",
  "Typed NUMERIC fundamentals for an Indian stock (pe, pb, roe, roce, debtEquity, salesGrowth3yPct, profitGrowth3yPct, promoterHoldingPct, opmPctTtm, ...). Prefer this over get_fundamentals when you need to compare or compute — get_fundamentals returns display strings like '₹ 17,60,650 Cr.'. Banks/NBFCs get null debtEquity and salesGrowth3yPct by design; see the returned `caveats`.",
  symbolArg,
  async ({ symbol }) => {
    try {
      const { html } = await fetchCompanyHtml(symbol);
      return json(parseRatios(symbol, html));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "get_quarterly_results",
  "Per-quarter Sales, Net Profit, EPS, Operating Profit and OPM for an Indian stock, keyed by the real quarter END date (ISO YYYY-MM-DD) rather than a display label like 'Jun 2026'. Use this instead of get_financials when you need to sort or join quarters by date. Anonymous access returns roughly the last 13 quarters.",
  symbolArg,
  async ({ symbol }) => {
    try {
      const { html } = await fetchCompanyHtml(symbol);
      const quarters = parseQuarterlyResults(html);
      if (quarters.length === 0) return err(`No quarterly results table found for '${symbol}'`);
      return json({ symbol: symbol.toUpperCase(), quarters });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "screen_stocks",
  "Screen every listed Indian company with NO SIGN-IN REQUIRED. Prefer this over run_screen. " +
    "Takes the same Screener DSL as run_screen but evaluates it locally against ~5,400 companies swept " +
    "from Screener's public industry pages, so it sees the whole market rather than 50 rows a page. " +
    `Only these nine metrics exist anonymously: ${SUPPORTED_METRICS.map((m) => m.dslName).join(", ")}. ` +
    "Clauses on anything else (ROE, debt/equity, Piotroski, promoter holding, 3-year growth) are NOT " +
    "applied — they come back in `unappliedClauses`, which means `rows` is a SUPERSET of the real answer. " +
    "When that happens, call get_ratios on each shortlisted symbol to check the remaining conditions, and " +
    "relay `note` to the user rather than presenting the rows as an exact match. Only AND is supported; " +
    "OR and parentheses land in unappliedClauses. `slug` on each row works as `symbol` for the other tools. " +
    "The first call of the day builds a cache and takes several minutes; later calls are instant for 12h.",
  {
    query: z
      .string()
      .describe("Screener DSL filter, e.g. 'Return on capital employed > 15 AND Market Capitalization > 10000'"),
    limit: z.number().int().min(1).max(500).default(25).describe("Rows to return; totalResults still counts every match"),
    sort: z.string().optional().describe("Metric to sort by, e.g. 'Market Capitalization'. Defaults to market cap"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc"),
    refresh: z.boolean().default(false).describe("Ignore the cache and re-sweep. Slow — only when data must be fresh"),
  },
  async ({ query, limit, sort, order, refresh }) => {
    try {
      // The first sweep is minutes long, so report progress on stderr where MCP
      // clients surface server logs; otherwise the call just looks hung.
      return json(
        await screenAnonymously(query, {
          limit,
          sort,
          order,
          force: refresh,
          onProgress: (p) =>
            console.error(`[screen_stocks] ${p.industriesDone}/${p.industriesTotal} industries, ${p.rows} companies`),
        }),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "run_screen",
  "Run a screen through Screener's own DSL endpoint. REQUIRES SIGN-IN (see screener_auth_status). " +
    "TRY screen_stocks FIRST — it needs no account and covers the whole listed universe. Reach for this " +
    "one only when the query needs a metric screen_stocks does not have (ROE, debt/equity, Piotroski, " +
    "promoter holding, 3-year growth, ...), or an OR / parenthesised expression. `query` uses Screener's " +
    "DSL, e.g. \"Return on capital employed > 15 AND Debt to equity < 1 AND Piotroski score >= 7 AND " +
    "Market Capitalization > 5000\". Returns 50 rows per page; raise maxPages for more.",
  {
    query: z.string().describe("Screener DSL filter, e.g. 'Return on equity > 15 AND Debt to equity < 1'"),
    maxPages: z.number().int().min(1).max(20).default(4).describe("Pages to fetch, 50 rows each"),
    sort: z.string().optional().describe("Column name to sort by, e.g. 'Market Capitalization'"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
  },
  async ({ query, maxPages, sort, order }) => {
    try {
      return json(await runScreen(query, { maxPages, sort, order }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "screener_auth_status",
  "Check whether this server has a valid signed-in Screener.in session. Call this when a tool reports " +
    "that it needs sign-in, then relay the returned `instruction` to the user verbatim. `state` is one of " +
    "'active', 'anonymous', 'expired' or 'unknown' — 'unknown' means Screener could not be reached, so " +
    "it is NOT a sign-in problem and the user should not be told to log in again.",
  {},
  async () => {
    const s = await sessionState();
    // signedIn is kept for callers written against the older two-state shape.
    return json({ signedIn: s.state === "active", ...s });
  },
);

server.tool(
  "get_public_screen",
  "Read a SAVED Screener screen by id or URL, with NO SIGN-IN REQUIRED — including a screen the user " +
    "created themselves, once it is saved. Accepts anything they paste: a bare id (2), a full URL, a URL " +
    "with a '?page=2' tail, a missing scheme. Returns the screen's own DSL in `query` plus its title, " +
    "author and paged rows at 25 per page. Use this when the user has a screen they already trust, or " +
    "after build_screen_link had them save one. NOTE: `sort` is login-gated by Screener — to get 'the " +
    "biggest in this screen' anonymously, raise maxPages to cover the whole screen and order the rows " +
    "yourself; sorting one page of 25 would just relabel an arbitrary slice.",
  {
    screen: z.string().describe("Screen id or URL, e.g. '2' or 'https://www.screener.in/screens/2/piotroski-scan/'"),
    maxPages: z.number().int().min(1).max(40).default(4).describe("Pages to fetch, 25 rows each"),
    sort: z.string().optional().describe("Ratio name from sortableColumns. Needs a session — see above"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
  },
  async ({ screen, maxPages, sort, order }) => {
    try {
      return json(await fetchPublicScreen(screen, { maxPages, sort, order }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "build_screen_link",
  "Turn a Screener DSL query into a link the USER clicks, for when a query needs metrics screen_stocks " +
    "lacks and nobody is signed in. Their browser is already signed in to Screener, so the screen runs " +
    "there and no credential is ever handed over. Returns `url` plus `instructions` — relay both verbatim. " +
    "The instructions ask them to save the screen and paste its address back, which get_public_screen can " +
    "then read anonymously forever. Prefer screen_stocks when it can answer the question outright, since " +
    "this one needs the user to do something.",
  { query: z.string().describe("Screener DSL filter, e.g. 'Return on equity > 15 AND Debt to equity < 1'") },
  async ({ query }) => {
    try {
      return json(buildScreenLink(query));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.tool(
  "list_public_screens",
  "Browse Screener's directory of public screens (title, description, id, URL), 25 per page, no sign-in. " +
    "A discovery aid: often a screen someone already built beats writing a new one. Feed an id straight " +
    "into get_public_screen. `resultCount` is always null — the directory does not print counts.",
  {
    page: z.number().int().min(1).default(1).describe("First directory page to read"),
    maxPages: z.number().int().min(1).max(5).default(1).describe("Pages to read from `page` onward"),
  },
  async ({ page, maxPages }) => {
    try {
      return json(await listPublicScreens({ page, maxPages }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `screener-mcp server running on stdio (${
    loadSession()
      ? "signed in"
      : "anonymous — screening works without an account via screen_stocks; `npx screener-mcp login --chrome` adds run_screen"
  })`,
);
