import { parse, type HTMLElement } from "node-html-parser";
import { cookieHeader, userAgent } from "./auth.js";
import { cagrPct, highLow, normalizeLabel, num, ratio, round2 } from "./numbers.js";

const BASE = "https://www.screener.in";

/** Raised when a request needs a signed-in session that we don't have (or whose
 * cookie has expired). Carries a message the agent can relay verbatim. */
export class AuthRequiredError extends Error {
  constructor(what: string) {
    super(
      `${what} requires a signed-in Screener account. ` +
        `Run \`npx screener-mcp login\` in a terminal (or set SCREENER_SESSION_ID), then retry.`,
    );
  }
}

export function isSignedIn(): boolean {
  return cookieHeader() !== undefined;
}

/** Common headers. The session cookie rides along whenever we have one — Screener
 * serves richer data to logged-in users on the same URLs. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": userAgent(), ...extra };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  return h;
}

/** Screener answers an expired/absent session with a redirect rather than a 401,
 * so detect that and surface a re-auth instruction. Note it sends anonymous users
 * to /register/ (not /login/) for gated pages like /screen/raw/ — match both. */
function assertNotLoginRedirect(res: Response, what: string): void {
  const location = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && /\/(login|register)\//.test(location)) {
    throw new AuthRequiredError(what);
  }
}

export interface Ratio {
  name: string;
  value: string;
}

export interface Fundamentals {
  symbol: string;
  name: string;
  companyId: number | null;
  about: string | null;
  ratios: Ratio[];
  pros: string[];
  cons: string[];
  url: string;
}

export interface StatementTable {
  section: string;
  columns: string[]; // period headers (years / quarters)
  rows: { label: string; values: string[] }[];
}

export interface Peer {
  name: string;
  values: Record<string, string>;
}

export interface ChartSeries {
  metric: string;
  label: string;
  points: { date: string; value: number }[];
}

async function fetchHtml(path: string, what = path): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), redirect: "manual" });
  assertNotLoginRedirect(res, what);
  if (!res.ok) throw new Error(`Screener ${path} -> HTTP ${res.status}`);
  return res.text();
}

/** Screener is server-rendered (Django). One GET returns the full page. Prefer
 * the consolidated view; fall back to standalone if consolidated 404s. */
export async function fetchCompanyHtml(
  symbol: string,
): Promise<{ html: string; url: string }> {
  const sym = symbol.trim().toUpperCase();
  for (const view of ["consolidated/", ""]) {
    const path = `/company/${encodeURIComponent(sym)}/${view}`;
    const res = await fetch(`${BASE}${path}`, { headers: headers() });
    if (res.ok) return { html: await res.text(), url: `${BASE}${path}` };
  }
  throw new Error(`Screener: company '${sym}' not found (tried consolidated + standalone)`);
}

function txt(el: HTMLElement | null | undefined): string {
  return (el?.text ?? "").replace(/\s+/g, " ").trim();
}

export function parseCompanyId(root: HTMLElement): number | null {
  // Company id appears in data-url attributes like "/company/actions/3365/".
  const el = root.querySelector("[data-url*='/company/']");
  const m = el?.getAttribute("data-url")?.match(/\/company\/(?:[a-z]+\/)?(\d+)\//);
  if (m) return Number(m[1]);
  const warehouse = root.querySelector("[data-company-id]");
  const id = warehouse?.getAttribute("data-company-id");
  return id ? Number(id) : null;
}

/** The peers/alerts endpoints key off a separate "warehouse id" (data-warehouse-id),
 * NOT the company id. e.g. TCS company id 3365 but warehouse id 6599230. */
export function parseWarehouseId(root: HTMLElement): number | null {
  const el = root.querySelector("[data-warehouse-id]");
  const id = el?.getAttribute("data-warehouse-id");
  if (id) return Number(id);
  // Fallback: alerts data-url carries the same id, "/alerts/stock-6599230/".
  const alert = root.querySelector("[data-url*='/alerts/stock-']");
  const m = alert?.getAttribute("data-url")?.match(/\/alerts\/stock-(\d+)\//);
  return m ? Number(m[1]) : null;
}

export function parseFundamentals(symbol: string, html: string, url: string): Fundamentals {
  const root = parse(html);
  const name = txt(root.querySelector("h1")) || symbol.toUpperCase();

  // Top ratio cards: <li><span class="name">..</span><span class="value">..</span></li>
  const ratios: Ratio[] = [];
  for (const li of root.querySelectorAll("#top-ratios li")) {
    const n = txt(li.querySelector(".name"));
    const v = txt(li.querySelector(".value")).replace(/\s+/g, " ");
    if (n && v) ratios.push({ name: n, value: v });
  }
  // Fallback: some layouts use ul.company-ratios
  if (ratios.length === 0) {
    for (const li of root.querySelectorAll("ul.company-ratios li")) {
      const n = txt(li.querySelector(".name"));
      const v = txt(li.querySelector(".value"));
      if (n && v) ratios.push({ name: n, value: v });
    }
  }

  const pros = root.querySelectorAll(".pros li").map((li) => txt(li)).filter(Boolean);
  const cons = root.querySelectorAll(".cons li").map((li) => txt(li)).filter(Boolean);
  const about = txt(root.querySelector(".company-profile .about, .about p")) || null;

  return {
    symbol: symbol.toUpperCase(),
    name,
    companyId: parseCompanyId(root),
    about,
    ratios,
    pros,
    cons,
    url,
  };
}

function parseSection(root: HTMLElement, id: string, section: string): StatementTable | null {
  const el = root.querySelector(`#${id} table`);
  if (!el) return null;
  const headerCells = el.querySelectorAll("thead th");
  const columns = headerCells.slice(1).map((th) => txt(th));
  const rows: { label: string; values: string[] }[] = [];
  for (const tr of el.querySelectorAll("tbody tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;
    const label = txt(cells[0]);
    const values = cells.slice(1).map((td) => txt(td));
    if (label) rows.push({ label, values });
  }
  return { section, columns, rows };
}

export function parseFinancials(html: string): StatementTable[] {
  const root = parse(html);
  const out: StatementTable[] = [];
  const map: [string, string][] = [
    ["quarters", "Quarterly Results"],
    ["profit-loss", "Profit & Loss"],
    ["balance-sheet", "Balance Sheet"],
    ["cash-flow", "Cash Flow"],
    ["ratios", "Ratios"],
    ["shareholding", "Shareholding Pattern"],
  ];
  for (const [id, section] of map) {
    const t = parseSection(root, id, section);
    if (t) out.push(t);
  }
  return out;
}

export interface PeersResult {
  peers: Peer[];
  median: Record<string, string> | null;
}

/** Parse the peers HTML fragment returned by /api/company/{warehouseId}/peers/. */
export function parsePeersFragment(fragmentHtml: string): PeersResult {
  const root = parse(fragmentHtml);
  const table = root.querySelector("table");
  if (!table) return { peers: [], median: null };

  const headers = table.querySelectorAll("thead th, tr:first-child th").map((th) => txt(th));
  const peers: Peer[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 3) continue;
    // Column 0 is S.No, column 1 is the name (a link), rest are metrics.
    const name = txt(cells[1]);
    if (!name) continue;
    const symbol = cells[1].querySelector("a")?.getAttribute("href")?.match(/\/company\/([^/]+)\//)?.[1];
    const values: Record<string, string> = {};
    cells.forEach((td, i) => {
      const key = headers[i] || `col${i}`;
      if (i >= 2) values[key] = txt(td);
    });
    peers.push({ name: symbol ? `${symbol} (${name})` : name, values });
  }

  // The median row lives in tfoot.
  let median: Record<string, string> | null = null;
  const foot = table.querySelector("tfoot tr");
  if (foot) {
    const cells = foot.querySelectorAll("td");
    median = {};
    cells.forEach((td, i) => {
      const key = headers[i] || `col${i}`;
      if (i >= 2) median![key] = txt(td);
    });
  }

  return { peers, median };
}

/** Fetch + parse the peer comparison. Needs the warehouse id (see parseWarehouseId)
 * and the X-Requested-With header, else Screener 404s the fragment. */
export async function fetchPeers(warehouseId: number): Promise<PeersResult> {
  const res = await fetch(`${BASE}/api/company/${warehouseId}/peers/`, {
    headers: headers({ "X-Requested-With": "XMLHttpRequest" }),
  });
  if (!res.ok) throw new Error(`Screener peers -> HTTP ${res.status}`);
  return parsePeersFragment(await res.text());
}

export interface QuarterlyResult {
  quarterEndDate: string; // ISO YYYY-MM-DD
  label: string; // Screener's column header, e.g. "Jun 2026"
  salesCr: number | null;
  netProfitCr: number | null;
  eps: number | null;
  operatingProfitCr: number | null;
  opmPct: number | null;
}

/** Row values for a statement table, keyed by normalized label. */
function tableRows(root: HTMLElement, sectionId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const table = root.querySelector(`#${sectionId} table`);
  if (!table) return out;
  for (const tr of table.querySelectorAll("tbody tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;
    const label = normalizeLabel(cells[0].text);
    if (label) out.set(label, cells.slice(1).map((td) => td.text));
  }
  return out;
}

function columnLabels(root: HTMLElement, sectionId: string): string[] {
  const ths = root.querySelectorAll(`#${sectionId} table thead th`);
  return ths.slice(1).map((th) => th.text.replace(/\s+/g, " ").trim());
}

/**
 * Per-quarter Sales / Net Profit / EPS keyed by the real quarter END date.
 *
 * `get_financials` returns the same table with display headers ("Jun 2026"),
 * which are ambiguous to sort and join on. Screener carries the ISO date in a
 * `data-date-key` attribute on the header cells, so we read that instead.
 *
 * Anonymous pages expose ~13 quarters; a signed-in session may return more.
 */
export function parseQuarterlyResults(html: string): QuarterlyResult[] {
  const root = parse(html);
  // The ISO dates live on the header cells of the quarters table.
  const dateKeys = root
    .querySelectorAll("#quarters table thead th[data-date-key]")
    .map((th) => th.getAttribute("data-date-key")!)
    .filter(Boolean);
  const labels = columnLabels(root, "quarters");
  const rows = tableRows(root, "quarters");

  const sales = rows.get("Sales") ?? rows.get("Revenue") ?? [];
  const netProfit = rows.get("Net Profit") ?? [];
  const eps = rows.get("EPS in Rs") ?? [];
  const opProfit = rows.get("Operating Profit") ?? [];
  const opm = rows.get("OPM %") ?? [];

  // Fall back to the display labels if the data-date-key attributes ever vanish,
  // so this degrades to "less precise" rather than "empty".
  const count = dateKeys.length || labels.length;
  const out: QuarterlyResult[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      quarterEndDate: dateKeys[i] ?? "",
      label: labels[i] ?? "",
      salesCr: num(sales[i]),
      netProfitCr: num(netProfit[i]),
      eps: num(eps[i]),
      operatingProfitCr: num(opProfit[i]),
      opmPct: num(opm[i]),
    });
  }
  return out;
}

export interface Ratios {
  symbol: string;
  marketCapCr: number | null;
  currentPrice: number | null;
  high52w: number | null;
  low52w: number | null;
  pe: number | null;
  pb: number | null;
  bookValue: number | null;
  divYieldPct: number | null;
  roePct: number | null;
  rocePct: number | null;
  faceValue: number | null;
  debtEquity: number | null;
  salesGrowth3yPct: number | null;
  profitGrowth3yPct: number | null;
  promoterHoldingPct: number | null;
  promoterChange4qPct: number | null;
  opmPctTtm: number | null;
  /** True when the statements look like a bank/NBFC's. See `caveats`. */
  isFinancialCompany: boolean;
  /** Human-readable notes about metrics deliberately left null. */
  caveats: string[];
  /** Any top-ratio card we didn't map to a typed field, as raw display strings. */
  unmapped: Record<string, string>;
}

/**
 * Typed numeric fundamentals, parsed from the same single company-page fetch as
 * `get_fundamentals` (which returns display strings like "₹ 17,60,650 Cr.").
 *
 * Some fields are derived rather than displayed: Screener shows no P/B card, so
 * it comes from price / book value, and the 3-year growth figures are CAGRs over
 * the P&L columns.
 *
 * Banks and NBFCs get null for debt/equity and sales growth on purpose. Their
 * "Borrowings" are customer deposits (funding, not leverage) and their "Sales"
 * is interest income, so both ratios mean something different than they do for
 * an operating company; emitting them would invite false peer comparisons.
 */
export function parseRatios(symbol: string, html: string): Ratios {
  const root = parse(html);
  const caveats: string[] = [];

  const cards = new Map<string, string>();
  for (const li of root.querySelectorAll("#top-ratios li, ul.company-ratios li")) {
    const n = normalizeLabel(li.querySelector(".name")?.text ?? "");
    const v = (li.querySelector(".value")?.text ?? "").replace(/\s+/g, " ").trim();
    if (n && !cards.has(n)) cards.set(n, v);
  }

  const currentPrice = num(cards.get("Current Price"));
  const bookValue = num(cards.get("Book Value"));
  const { high, low } = highLow(cards.get("High / Low"));

  const pl = tableRows(root, "profit-loss");
  const plCols = columnLabels(root, "profit-loss");
  const bs = tableRows(root, "balance-sheet");
  const sh = tableRows(root, "shareholding");

  // A bank's P&L has "Financing Profit" instead of "Operating Profit", and its
  // balance sheet carries "Deposits" — either marks it as a financial.
  const isFinancialCompany = pl.has("Financing Profit") || bs.has("Deposits");

  // The P&L's final column is TTM, not a fiscal year; a CAGR must not span it.
  const fyCount = plCols.length - (plCols.at(-1)?.toUpperCase() === "TTM" ? 1 : 0);
  const at = (row: string[] | undefined, i: number) => num(row?.[i]);
  const fyIdx = (back: number) => fyCount - 1 - back;

  let salesGrowth3yPct: number | null = null;
  let profitGrowth3yPct: number | null = null;
  if (fyCount >= 4) {
    profitGrowth3yPct = cagrPct(at(pl.get("Net Profit"), fyIdx(3)), at(pl.get("Net Profit"), fyIdx(0)), 3);
    if (isFinancialCompany) {
      caveats.push("salesGrowth3yPct omitted: this looks like a bank/NBFC, where Sales is interest income.");
    } else {
      salesGrowth3yPct = cagrPct(at(pl.get("Sales"), fyIdx(3)), at(pl.get("Sales"), fyIdx(0)), 3);
    }
  } else {
    caveats.push("3-year growth omitted: fewer than 4 fiscal years of P&L published.");
  }

  let debtEquity: number | null = null;
  if (isFinancialCompany) {
    caveats.push("debtEquity omitted: this looks like a bank/NBFC, where borrowings are largely deposits.");
  } else {
    const last = (row: string[] | undefined) => num(row?.[(row?.length ?? 0) - 1]);
    const equity = last(bs.get("Equity Capital"));
    const reserves = last(bs.get("Reserves"));
    const borrowings = last(bs.get("Borrowings"));
    const netWorth = equity != null && reserves != null ? equity + reserves : null;
    debtEquity = ratio(borrowings, netWorth);
  }

  const promoters = sh.get("Promoters");
  const promoterHoldingPct = promoters ? num(promoters[promoters.length - 1]) : null;
  // Positive = promoters increased their stake over the last four quarters.
  const promoterChange4qPct =
    promoters && promoters.length >= 5
      ? round2((num(promoters[promoters.length - 1]) ?? 0) - (num(promoters[promoters.length - 5]) ?? 0))
      : null;

  const opmRow = pl.get("OPM %");
  const opmPctTtm = opmRow ? num(opmRow[opmRow.length - 1]) : null;

  const MAPPED = new Set([
    "Market Cap", "Current Price", "High / Low", "Stock P/E", "Book Value",
    "Dividend Yield", "ROCE", "ROE", "Face Value",
  ]);
  const unmapped: Record<string, string> = {};
  for (const [k, v] of cards) if (!MAPPED.has(k)) unmapped[k] = v;

  return {
    symbol: symbol.toUpperCase(),
    marketCapCr: num(cards.get("Market Cap")),
    currentPrice,
    high52w: high,
    low52w: low,
    pe: num(cards.get("Stock P/E")),
    pb: ratio(currentPrice, bookValue),
    bookValue,
    divYieldPct: num(cards.get("Dividend Yield")),
    roePct: num(cards.get("ROE")),
    rocePct: num(cards.get("ROCE")),
    faceValue: num(cards.get("Face Value")),
    debtEquity,
    salesGrowth3yPct,
    profitGrowth3yPct,
    promoterHoldingPct,
    promoterChange4qPct,
    opmPctTtm,
    isFinancialCompany,
    caveats,
    unmapped,
  };
}

export interface ScreenRow {
  /** Screener's URL slug, e.g. "RELIANCE" — usable as `symbol` for other tools. */
  slug: string | null;
  name: string;
  metrics: Record<string, string>;
}

export interface ScreenResult {
  query: string;
  totalResults: number | null;
  pagesFetched: number;
  columns: string[];
  rows: ScreenRow[];
}

/**
 * Run a Screener screen (the `/screen/raw/` DSL) and page through the results.
 *
 * Sign-in required: Screener 302s anonymous callers to /register/. 50 rows per
 * page, so `maxPages` bounds both latency and how hard we hit Screener.
 *
 * Query example:
 *   "Return on capital employed > 15 AND Debt to equity < 1 AND Piotroski score >= 7"
 */
export async function runScreen(
  query: string,
  { maxPages = 4, sort, order }: { maxPages?: number; sort?: string; order?: string } = {},
): Promise<ScreenResult> {
  if (!isSignedIn()) throw new AuthRequiredError("Running a Screener screen");

  let columns: string[] = [];
  let totalResults: number | null = null;
  const rows: ScreenRow[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ query, page: String(page) });
    if (sort) params.set("sort", sort);
    if (order) params.set("order", order);

    const res = await fetch(`${BASE}/screen/raw/?${params}`, {
      headers: headers({ Referer: `${BASE}/screen/new/` }),
      redirect: "manual",
    });
    assertNotLoginRedirect(res, "Running a Screener screen");
    if (res.status >= 300 && res.status < 400) {
      // Any other redirect is still a refusal to serve the screen.
      throw new AuthRequiredError("Running a Screener screen");
    }
    if (!res.ok) throw new Error(`Screener screen -> HTTP ${res.status}`);

    const html = await res.text();
    const root = parse(html);
    totalResults ??= num(html.match(/([\d,]+)\s*results?\s*found/i)?.[1] ?? null);

    const table = root.querySelector("table");
    if (!table) break;

    if (columns.length === 0) {
      // Screener repeats the header block every few rows; the first block is enough.
      const all = table.querySelectorAll("th").map((th) => normalizeLabel(th.text));
      const start = all.indexOf("S.No.");
      const second = all.indexOf("S.No.", start + 1);
      columns = start >= 0 && second > start ? all.slice(start, second) : all;
    }

    let pageRows = 0;
    for (const tr of table.querySelectorAll("tbody tr")) {
      const link = tr.querySelector("a[href*='/company/']");
      if (!link) continue; // header/spacer row
      const cells = tr.querySelectorAll("td").map((td) => td.text.replace(/\s+/g, " ").trim());
      const metrics: Record<string, string> = {};
      cells.forEach((v, i) => {
        const key = columns[i] || `col${i}`;
        if (key !== "S.No." && key !== "Name") metrics[key] = v;
      });
      rows.push({
        slug: link.getAttribute("href")?.match(/\/company\/([^/]+)\//)?.[1] ?? null,
        name: link.text.replace(/\s+/g, " ").trim(),
        metrics,
      });
      pageRows++;
    }

    pagesFetched++;
    if (pageRows === 0) break;
    if (totalResults !== null && rows.length >= totalResults) break;
  }

  return { query, totalResults, pagesFetched, columns, rows };
}

/** JSON chart API — clean time-series. metric examples: "Price", "Quarter Sales", "EPS". */
export async function fetchChart(
  companyId: number,
  metric = "Price-DMA50-Volume",
  days = 365,
): Promise<ChartSeries[]> {
  const path = `/api/company/${companyId}/chart/?q=${encodeURIComponent(metric)}&days=${days}`;
  const raw = await fetchHtml(path);
  const json = JSON.parse(raw) as {
    datasets?: { metric: string; label: string; values: [string, string][] }[];
  };
  return (json.datasets ?? []).map((d) => ({
    metric: d.metric,
    label: d.label,
    points: d.values
      .map(([date, v]) => ({ date, value: Number(v) }))
      .filter((p) => Number.isFinite(p.value)),
  }));
}
