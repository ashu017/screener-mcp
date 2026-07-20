#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchCompanyHtml,
  parseFundamentals,
  parseFinancials,
  parsePeers,
  fetchChart,
  parseCompanyId,
} from "./screener.js";
import { parse } from "node-html-parser";

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
      return json(parsePeers(html));
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("screener-mcp server running on stdio");
