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
import { loadSession, sessionPath, whoami } from "./auth.js";
import { runCli } from "./cli.js";

// Subcommands (login/status/logout) run instead of the server. An MCP client
// launches us with no arguments, so the server remains the default.
const cliExit = await runCli(process.argv.slice(2));
if (cliExit !== null) process.exit(cliExit);

const server = new McpServer({
  name: "screener-mcp",
  version: "0.1.0",
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
  "run_screen",
  "Run a Screener.in screen and return the matching stocks. REQUIRES SIGN-IN (see screener_auth_status). `query` uses Screener's DSL, e.g. \"Return on capital employed > 15 AND Debt to equity < 1 AND Piotroski score >= 7 AND Market Capitalization > 5000\". Returns 50 rows per page; raise maxPages for more. Far cheaper than calling get_ratios per stock across a universe.",
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
  "Check whether this server has a valid signed-in Screener.in session. Call this when a tool reports that it needs sign-in, then relay the returned instruction to the user.",
  {},
  async () => {
    const s = loadSession();
    if (!s) {
      return json({
        signedIn: false,
        sessionFile: sessionPath(),
        instruction:
          "Not signed in. Ask the user to run `npx screener-mcp login` in a terminal, then retry. " +
          "Only anonymous (public) Screener data is available until then.",
      });
    }
    const who = await whoami(s.sessionId);
    if (!who.valid) {
      return json({
        signedIn: false,
        expired: true,
        savedAt: s.savedAt,
        instruction:
          "The stored Screener session has expired. Ask the user to run `npx screener-mcp login` again.",
      });
    }
    return json({ signedIn: true, account: who.username ?? s.username ?? null, savedAt: s.savedAt });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `screener-mcp server running on stdio (${loadSession() ? "signed in" : "anonymous — run `npx screener-mcp login` for account-only data"})`,
);
