/**
 * Anonymous stock screening.
 *
 * `/screen/raw/` — the DSL endpoint `runScreen` uses — 302s anonymous callers to
 * /register/, so screening used to require a session cookie. Screener publishes
 * the same table anonymously through its industry browser: /market/ links 188
 * leaf industry pages, and each leaf renders the identical column set that a
 * screen renders (CMP, P/E, Mar Cap, Div Yld, NP Qtr, Qtr Profit Var, Sales Qtr,
 * Qtr Sales Var, ROCE). Sweeping those therefore yields the whole universe —
 * 5,438 companies as of 2026-09-04, from Bharti Airtel (11.5 lakh Cr) down to
 * microcaps worth well under a crore (smallest seen: 0.07 Cr) — no login at all.
 *
 * The trade is that only those nine metrics exist anonymously. Anything else the
 * DSL can express (ROE, debt/equity, Piotroski, promoter holding, ...) simply is
 * not on these pages, so `screenAnonymously` reports such clauses as *unapplied*
 * rather than dropping them. A screen that silently ignored a filter would be
 * confidently wrong, which is worse than one that admits what it could not do.
 *
 * Two measured properties of those pages make the sweep far cheaper than one page
 * per leaf, and the `level`/`minMarketCapCr` options exist to exploit them:
 *
 *   1. Intermediate levels AGGREGATE. /market/ only links 4-level leaves, but the
 *      1-, 2- and 3-level prefixes are all live and serve the union of their
 *      children — /market/IN02/ reports 1,402 results, matching the 1,400 rows the
 *      12 IN02 leaves held a day earlier. So the same universe is reachable from
 *      12 sector URLs instead of 188 leaf URLs. Since every bucket costs at least
 *      one request, 12 buckets is 223 pages where 188 buckets is 334.
 *   2. Every page is strictly market-cap DESCENDING. Verified across all 188
 *      leaves, 5,438 rows, zero inversions, and again on the aggregate pages. A
 *      query with a market-cap floor can therefore stop paging a bucket the moment
 *      rows fall below the floor — 31 pages instead of 223 for a 10,000 Cr floor.
 *
 * Coarser buckets are what make (2) pay: the fixed one-page-per-bucket cost is 12
 * requests rather than 188, so early termination has something left to save. The
 * cost is that `industryName` is then a sector ("Consumer Discretionary") rather
 * than a leaf ("Commodity Chemicals"); `industryLevel` says which you got, and
 * `level: 4` restores the fine-grained labels at the old price.
 *
 * NOTE FOR MAINTAINERS: screener.in/robots.txt disallows `/*?page=`, `/*?sort=`
 * and `/*?limit=`. Paginating a leaf necessarily requests `?page=N`. Page 1 is
 * fetched as the bare (allowed) URL, and the sweep is cached for 12h and capped
 * at 2 concurrent requests, but the sweep does request disallowed query strings.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { sessionPath } from "./auth.js";
import { normalizeLabel, num } from "./numbers.js";
import { headers, type ScreenResult } from "./screener.js";

const BASE = "https://www.screener.in";

/** Leaf industry pages page at a fixed 25 rows; `?limit=50` is advertised in the
 * markup but ignored on /market/, so there is no way to fetch fewer pages. */
const ROWS_PER_PAGE = 25;

/** Bumped whenever the cached row shape changes, so an old file is ignored
 * rather than deserialized into the wrong type. v1 files are migrated rather
 * than discarded — see `readCache` — because a v1 sweep is by construction a
 * complete level-4 one, which is strictly better than anything v2 produces. */
const CACHE_VERSION = 2;

const DEFAULT_TTL_HOURS = 12;

/** How many of the four taxonomy levels to address when sweeping. 1 = the 12
 * sector pages, 4 = the 188 leaves /market/ actually links. Level 1 by default:
 * same companies, a third fewer requests, and it is what makes a market-cap
 * floor worth honouring. See the module comment. */
export type SweepLevel = 1 | 2 | 3 | 4;
const DEFAULT_SWEEP_LEVEL: SweepLevel = 1;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** The nine metrics Screener publishes anonymously. `null` is common and never
 * means zero — Tata Chemicals ships with an empty P/E cell, for instance. */
export interface MarketMetrics {
  /** Current market price, Rs. */
  cmp: number | null;
  /** Trailing P/E. */
  pe: number | null;
  marketCapCr: number | null;
  divYieldPct: number | null;
  /** Net profit, latest reported quarter, Rs. Cr. */
  netProfitQtrCr: number | null;
  /** YoY growth in latest-quarter net profit, %. */
  qtrProfitVarPct: number | null;
  salesQtrCr: number | null;
  qtrSalesVarPct: number | null;
  rocePct: number | null;
}

export type MetricField = keyof MarketMetrics;

export interface MarketRow extends MarketMetrics {
  /** Screener's URL slug, usable as `symbol` for get_ratios/get_fundamentals.
   * Usually a ticker ("SRF") but sometimes a bare BSE code ("506854") for names
   * that only trade on BSE — both resolve on /company/<slug>/. */
  slug: string;
  name: string;
  /** The bucket this row was swept from — "IN01" at level 1, up to
   * "IN01/IN0101/IN010101/IN010101001" at level 4. */
  industryPath: string;
  /** Screener's label for that bucket: a sector ("Consumer Discretionary") at
   * level 1, a specific industry ("Commodity Chemicals") at level 4. Read off the
   * page's own heading, so it is whatever Screener calls that bucket. */
  industryName: string;
  /** How many taxonomy levels `industryPath` carries, 1-4. Says how specific
   * `industryName` is; a level-1 sweep cannot report the leaf industry. */
  industryLevel: number;
  /** Screener's internal company id, from the row's data-row-company-id. */
  companyId: number | null;
}

/** Canonical Screener DSL name per field, plus the aliases we accept. The first
 * entry is what we echo back to callers; the rest exist because agents write
 * "Market Cap" or "ROCE" as often as the DSL's own spelling. Every alias is
 * matched through `normKey`, so case, "%", "Rs.Cr." and punctuation are free. */
const METRIC_ALIASES: Record<MetricField, readonly string[]> = {
  cmp: ["Current price", "CMP", "Price", "Current market price", "Market price"],
  pe: ["Price to Earning", "P/E", "PE", "PE ratio", "Stock P/E", "Price to earnings"],
  marketCapCr: ["Market Capitalization", "Market Capitalisation", "Market Cap", "Mar Cap"],
  divYieldPct: ["Dividend yield", "Div Yld", "Div yield"],
  netProfitQtrCr: ["Net Profit latest quarter", "NP Qtr", "Net profit qtr", "Quarterly net profit"],
  qtrProfitVarPct: [
    "YOY Quarterly profit growth",
    "Qtr Profit Var",
    "Quarterly profit growth",
    "Profit growth qtr",
  ],
  salesQtrCr: ["Sales latest quarter", "Sales Qtr", "Quarterly sales", "Revenue latest quarter"],
  qtrSalesVarPct: [
    "YOY Quarterly sales growth",
    "Qtr Sales Var",
    "Quarterly sales growth",
    "Sales growth qtr",
  ],
  rocePct: ["Return on capital employed", "ROCE"],
};

/** What a caller can filter or sort on without a login. Exported so the MCP tool
 * description and error messages stay in sync with the parser. */
export const SUPPORTED_METRICS: readonly { field: MetricField; dslName: string }[] = (
  Object.keys(METRIC_ALIASES) as MetricField[]
).map((field) => ({ field, dslName: METRIC_ALIASES[field][0] }));

/**
 * Fold a metric name to a lookup key. Screener writes the same metric three ways
 * — DSL name ("Market Capitalization"), column header ("Mar Cap Rs.Cr.") and
 * tooltip — and callers write a fourth; stripping units and punctuation collapses
 * them all. "/" survives so "P/E" stays distinct from "PE".
 */
function normKey(s: string): string {
  return normalizeLabel(s)
    .toLowerCase()
    .replace(/\brs\.?\s*cr\.?/g, " ")
    .replace(/\brs\.?/g, " ")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const FIELD_BY_KEY: Map<string, MetricField> = new Map();
for (const field of Object.keys(METRIC_ALIASES) as MetricField[]) {
  // The field name is an alias too, so a programmatic caller can pass "rocePct".
  for (const alias of [field, ...METRIC_ALIASES[field]]) FIELD_BY_KEY.set(normKey(alias), field);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function txt(el: HTMLElement | null | undefined): string {
  return (el?.text ?? "").replace(/\s+/g, " ").trim();
}

/** A page to sweep: a taxonomy path plus, when we know it, Screener's label. */
export interface IndustryBucket {
  path: string;
  /** Empty when only the code is known — /market/ links leaf anchors only, so a
   * rolled-up prefix has no anchor text and its name comes off its own page. */
  name: string;
}

/**
 * Buckets to sweep, from the /market/ index.
 *
 * Extracted rather than hardcoded so a reorganised taxonomy is picked up on the
 * next sweep. /market/ links only 4-level leaves, so `level` rolls those paths up
 * to their prefixes: level 1 dedupes 188 leaves down to the 12 sector codes. The
 * prefixes are not linked anywhere but are live URLs serving the union of their
 * children, so rolling up costs no extra request and loses no company.
 */
export function parseIndustryIndex(html: string, level: SweepLevel = 4): IndustryBucket[] {
  const seen = new Set<string>();
  const out: IndustryBucket[] = [];
  for (const a of parse(html).querySelectorAll("a[href^='/market/']")) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(/^\/market\/(IN\d+\/IN\d+\/IN\d+\/IN\d+)\/$/);
    if (!m) continue;
    const path = m[1].split("/").slice(0, level).join("/");
    if (seen.has(path)) continue;
    seen.add(path);
    // Anchor text names the leaf, so it only describes a full-depth path.
    out.push({ path, name: level === 4 ? txt(a) || path : "" });
  }
  return out;
}

export interface IndustryPage {
  rows: MarketRow[];
  /** Screener's verbatim column labels, first header block only. */
  columns: string[];
  /** From the "<N> results found" line — the bucket's true company count. */
  resultsFound: number | null;
  /** The bucket's name per its own `<h1>`, e.g. "Consumer Discretionary". Null if
   * the heading is missing. This is how a rolled-up path gets a label at all. */
  heading: string | null;
}

/** Screener titles these pages "<Name> Companies"; the suffix is noise on every
 * one of them, so it is dropped to leave the name a caller would recognise. */
function headingName(root: HTMLElement): string | null {
  const h = txt(root.querySelector("h1"));
  if (h === "") return null;
  return h.replace(/\s+Companies$/i, "").trim() || null;
}

/**
 * Parse one industry page — leaf, rolled-up sector, or (identically) a
 * /screen/raw/ page.
 *
 * `industryName` may be empty: a rolled-up path has no anchor text anywhere, so
 * the page's own `<h1>` is the only label available and is used as the fallback.
 *
 * Two quirks drive the shape of this. The header block is repeated every few
 * rows inside a single `<tbody>`, so the first `<tr>` carrying `<th>`s is the
 * one to read and rows are recognised by having a /company/ link. And each
 * `<th>` carries `data-tooltip` with the exact DSL name ("Return on capital
 * employed"), which is a far more stable key than the abbreviated visible label
 * — we map columns by tooltip and fall back to the label.
 */
export function parseIndustryPage(
  html: string,
  industryPath: string,
  industryName: string,
): IndustryPage {
  const root = parse(html);
  const table = root.querySelector("table");
  const resultsFound = num(html.match(/([\d,]+)\s*results?\s*found/i)?.[1] ?? null);
  const heading = headingName(root);
  const label = industryName || heading || industryPath;
  const industryLevel = industryPath.split("/").length;
  if (!table) return { rows: [], columns: [], resultsFound, heading };

  const headerRow = table.querySelectorAll("tr").find((tr) => tr.querySelectorAll("th").length > 1);
  const ths = headerRow?.querySelectorAll("th") ?? [];
  const columns = ths.map((th) => normalizeLabel(th.text));
  // Column index -> typed field. Positional, so an inserted column shifts the
  // rest correctly instead of silently mis-assigning values.
  const fieldByIndex = new Map<number, MetricField>();
  ths.forEach((th, i) => {
    const field =
      FIELD_BY_KEY.get(normKey(th.getAttribute("data-tooltip") ?? "")) ??
      FIELD_BY_KEY.get(normKey(th.text));
    if (field !== undefined && !fieldByIndex.has(i)) fieldByIndex.set(i, field);
  });

  const rows: MarketRow[] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const link = tr.querySelector("a[href*='/company/']");
    const slug = link?.getAttribute("href")?.match(/\/company\/([^/]+)\//)?.[1];
    if (!link || !slug) continue; // header or spacer row
    const cells = tr.querySelectorAll("td");
    const metrics: MarketMetrics = {
      cmp: null,
      pe: null,
      marketCapCr: null,
      divYieldPct: null,
      netProfitQtrCr: null,
      qtrProfitVarPct: null,
      salesQtrCr: null,
      qtrSalesVarPct: null,
      rocePct: null,
    };
    for (const [i, field] of fieldByIndex) metrics[field] = num(cells[i]?.text);
    const id = tr.getAttribute("data-row-company-id");
    rows.push({
      slug,
      name: txt(link),
      industryPath,
      industryName: label,
      industryLevel,
      companyId: id ? Number(id) : null,
      ...metrics,
    });
  }

  return { rows, columns, resultsFound, heading };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Screener throttles anonymous sweeps hard, and it escalates: a burst of roughly
 * 30 requests earns HTTP 429, and continuing through the 429s gets the IP refused
 * at the TCP level ("fetch failed") for several minutes. Measured on 2026-09-04
 * at 4 concurrent requests with a 200 ms gap.
 *
 * So backoff is process-global rather than per-request: the moment one worker is
 * throttled, every worker waits. Backing off only the unlucky worker is what
 * turns a soft throttle into a block.
 */
let backoffUntil = 0;

function scheduleBackoff(ms: number): void {
  backoffUntil = Math.max(backoffUntil, Date.now() + ms);
}

async function awaitBackoff(): Promise<void> {
  for (let wait = backoffUntil - Date.now(); wait > 0; wait = backoffUntil - Date.now()) {
    await sleep(wait);
  }
}

class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

async function fetchMarketHtml(pathAndQuery: string): Promise<string> {
  await awaitBackoff();
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: headers(), redirect: "manual" });
  if (res.status === 429 || res.status === 503) {
    const after = Number(res.headers.get("retry-after"));
    throw new RateLimitError(
      `Screener ${pathAndQuery} -> HTTP ${res.status} (rate limited)`,
      Number.isFinite(after) && after > 0 ? after * 1000 : null,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // The industry browser is public today. A redirect means Screener started
    // gating it, which invalidates this whole module — say so loudly.
    throw new Error(
      `Screener ${pathAndQuery} -> HTTP ${res.status} redirect to ` +
        `'${res.headers.get("location") ?? "?"}' (industry pages may no longer be public)`,
    );
  }
  if (!res.ok) throw new Error(`Screener ${pathAndQuery} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * Retry with exponential backoff. A throttle or a refused connection pauses the
 * whole pool; ordinary errors only delay this request. Over ~260 requests a lone
 * blip is likely, and losing a whole industry to it would quietly shrink the
 * universe — which is exactly the kind of silent wrongness this module avoids.
 */
async function fetchWithRetry(pathAndQuery: string, attempts: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchMarketHtml(pathAndQuery);
    } catch (e) {
      lastError = e;
      const backoff = Math.min(120_000, 30_000 * 2 ** attempt);
      if (e instanceof RateLimitError) {
        scheduleBackoff(e.retryAfterMs ?? backoff);
      } else if (e instanceof TypeError) {
        // undici reports a refused/reset connection as TypeError("fetch failed"),
        // which is what an IP-level block looks like. Treat it like a throttle.
        scheduleBackoff(backoff);
      } else {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

/** Hand-rolled worker pool: N workers pull from one queue, so in-flight requests
 * stay at N without fixed batches (whose duration is set by their slowest leaf,
 * leaving the other workers idle). */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface UniverseProgress {
  industriesDone: number;
  industriesTotal: number;
  pagesFetched: number;
  rows: number;
  /** Industry that just finished, for a one-line status message. */
  lastIndustry: string;
}

export interface FetchUniverseOptions {
  /** Ignore a fresh cache and re-sweep from scratch. */
  force?: boolean;
  /** Cache lifetime; defaults to SCREENER_UNIVERSE_TTL_HOURS or 12. */
  ttlHours?: number;
  /** Max simultaneous requests to Screener. Keep this low — see `scheduleBackoff`. */
  concurrency?: number;
  /** Pause after each request, per worker. */
  delayMs?: number;
  /** Attempts per page, including the first. */
  attemptsPerPage?: number;
  /** Safety valve for a pathologically large bucket. Level-1 buckets run to 57
   * pages today (Consumer Discretionary, 1,402 companies), so this has to clear
   * that comfortably; at level 4 no leaf exceeds 15. */
  maxPagesPerIndustry?: number;
  /** Taxonomy depth to address. Defaults to 1 (12 sector pages). Raise to 4 for
   * leaf-accurate `industryName` at ~50% more requests. */
  level?: SweepLevel;
  /**
   * Stop paging a bucket once its rows fall below this market cap, Rs. Cr.
   *
   * Safe only because every page is cap-descending; the resulting universe is
   * PARTIAL by design and `Universe.minMarketCapCr` records the floor so no
   * caller can mistake it for the whole market. This is the single biggest lever
   * on sweep time: 31 pages at 10,000 Cr against 223 at 0.
   */
  minMarketCapCr?: number;
  onProgress?: (p: UniverseProgress) => void;
}

export interface Universe {
  rows: MarketRow[];
  /** Screener's verbatim column labels, so downstream output can mirror a screen. */
  columns: string[];
  industriesTotal: number;
  /** Leaves that produced at least one row. */
  leavesVisited: number;
  /** HTTP requests to Screener; 0 when this call was served entirely from cache. */
  pagesFetched: number;
  /** ISO timestamp of the original sweep, not of this call — a repair pass tops up
   * the missing leaves without resetting the TTL clock on the rows already held. */
  fetchedAt: string;
  fromCache: boolean;
  /** Buckets we never managed to read. Non-empty means `rows` is missing companies,
   * which a caller must disclose rather than present as a small market. */
  failedIndustries: { path: string; name: string; reason: string }[];
  /** Taxonomy depth swept, so a caller can tell how specific `industryName` is. */
  sweepLevel: SweepLevel;
  /**
   * The market-cap floor this sweep stopped at, Rs. Cr. 0 means complete.
   *
   * Above 0, `rows` deliberately omits smaller companies, so `rows.length` is NOT
   * the size of the market. It is also the cache-reuse key: a universe swept to
   * floor F answers any query whose own floor is >= F, and nothing below it.
   */
  minMarketCapCr: number;
}

/**
 * Screener blocks by IP, not per request, so once several leaves in a row fail
 * there is nothing to gain by grinding through the remaining 150 — each would
 * just burn its retries against a closed door. Give up, keep what we have, and
 * let the next call repair the gaps.
 */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

/** Sits next to session.json. Public market data, so no 0600 — but the directory
 * stays 0700 because the session cookie lives in it. */
export function universeCachePath(): string {
  return join(dirname(sessionPath()), "universe-cache.json");
}

interface CacheFile extends Universe {
  version: number;
}

function ttlMs(opt?: number): number {
  const env = Number(process.env.SCREENER_UNIVERSE_TTL_HOURS);
  const hours = opt ?? (Number.isFinite(env) && env >= 0 ? env : DEFAULT_TTL_HOURS);
  return hours * 3_600_000;
}

function readCache(maxAgeMs: number): Universe | null {
  try {
    const c = JSON.parse(readFileSync(universeCachePath(), "utf8")) as CacheFile;
    if (!Array.isArray(c.rows) || c.rows.length === 0) return null;
    const age = Date.now() - Date.parse(c.fetchedAt);
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    // A v1 file predates rolled-up sweeps, so it is a complete level-4 one by
    // construction. Migrating beats discarding: it is the most complete universe
    // this module can produce, and re-earning it costs 334 requests.
    if (c.version === 1) {
      return {
        ...c,
        sweepLevel: 4,
        minMarketCapCr: 0,
        rows: c.rows.map((r) => ({ ...r, industryLevel: r.industryPath.split("/").length })),
        fromCache: true,
        pagesFetched: 0,
      };
    }
    if (c.version !== CACHE_VERSION) return null;
    return { ...c, fromCache: true, pagesFetched: 0 };
  } catch {
    return null; // absent, truncated, or hand-edited — just re-sweep
  }
}

function writeCache(u: Universe): void {
  try {
    const p = universeCachePath();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    chmodSync(dirname(p), 0o700);
    const file: CacheFile = { ...u, version: CACHE_VERSION, fromCache: false };
    writeFileSync(p, JSON.stringify(file) + "\n");
  } catch {
    // A read-only config dir must not fail a screen; we just re-sweep next time.
  }
}

/**
 * Page through one bucket.
 *
 * `minMarketCapCr` above 0 truncates the walk. Every page is cap-descending, so
 * once a page ends below the floor every later page is too and there is nothing
 * left worth fetching. The check reads the page's smallest *non-null* cap: a blank
 * cap cell means unknown, which can never satisfy a floor clause but must not be
 * read as zero and stop the walk early either.
 */
async function fetchIndustry(
  industry: IndustryBucket,
  maxPages: number,
  delayMs: number,
  attempts: number,
  minMarketCapCr = 0,
): Promise<IndustryPage & { pagesFetched: number }> {
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  let columns: string[] = [];
  let resultsFound: number | null = null;
  let heading: string | null = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    // Page 1 is the bare URL: it is the same content as ?page=1, one fewer
    // robots-disallowed query string, and warmer in Screener's cache.
    const url = page === 1 ? `/market/${industry.path}/` : `/market/${industry.path}/?page=${page}`;
    const html = await fetchWithRetry(url, attempts);
    const parsed = parseIndustryPage(html, industry.path, industry.name);
    pagesFetched++;
    if (columns.length === 0) columns = parsed.columns;
    resultsFound ??= parsed.resultsFound;
    heading ??= parsed.heading;

    const fresh = parsed.rows.filter((r) => !seen.has(r.slug));
    for (const r of fresh) {
      seen.add(r.slug);
      rows.push(r);
    }

    // Out-of-range pages neither 404 nor come back empty: Screener CLAMPS to the
    // last page and re-serves it (?page=100 on a 74-row leaf returns rows 51-74).
    // So "no new slugs" is the real terminator; the empty and short-page checks
    // are belt-and-braces for buckets that behave differently.
    if (fresh.length === 0) break;
    if (parsed.rows.length < ROWS_PER_PAGE) break;
    if (resultsFound !== null && rows.length >= resultsFound) break;
    if (minMarketCapCr > 0) {
      const caps = parsed.rows.map((r) => r.marketCapCr).filter((v): v is number => v !== null);
      // Strictly below, so a bucket whose rows sit exactly on the floor still pages
      // on — `>= floor` queries need those and they may span a page boundary.
      if (caps.length > 0 && Math.min(...caps) < minMarketCapCr) break;
    }
    await sleep(delayMs);
  }

  return { rows, columns, resultsFound, heading, pagesFetched };
}

/**
 * Every company Screener publishes above `minMarketCapCr`, swept from the public
 * industry browser.
 *
 * Request counts, all measured against the live site and its ~0.77 req/s pacing:
 *
 *   level 4, no floor   334 pages   449 s   (what this did before)
 *   level 1, no floor   223 pages   ~300 s
 *   level 1, floor 1000  70 pages    ~94 s
 *   level 1, floor 10000 31 pages    ~42 s
 *
 * So the floor, not the pacing, is what makes this quick — and the pacing is left
 * exactly where it was measured safe. Still slow enough to cache for 12h and to
 * want `onProgress` reporting "7/12 sectors" meanwhile.
 *
 * A partial sweep is cached too, and the next call *repairs* it: only the buckets
 * that failed are re-fetched, at the floor the original sweep used, and the
 * original `fetchedAt` is kept so repairs cannot refresh the TTL of rows that are
 * actually a day old. That makes a throttled sweep converge over a few calls
 * instead of restarting from zero and re-hammering what already worked.
 *
 * The cache is only reused when it reaches at least as deep as this call needs
 * (`cached.minMarketCapCr <= minMarketCapCr`). Asking for a lower floor than the
 * cache holds re-sweeps rather than answering from a universe that is missing the
 * very companies the caller just widened the query to include.
 */
export async function fetchUniverse(opts: FetchUniverseOptions = {}): Promise<Universe> {
  const {
    force = false,
    level = DEFAULT_SWEEP_LEVEL,
    minMarketCapCr = 0,
    // Both measured 2026-09-04. 4-in-flight with a 200 ms gap (~6 req/s) earned
    // an HTTP 429 inside ~30 requests and then a TCP-level block of this IP that
    // lasted ~57 minutes. 2-in-flight with a 2 s gap (~0.75 req/s) completed all
    // 188 leaves, 336 requests, untouched, in 449 s. Do not raise these without
    // re-measuring: the penalty is not a slow tool, it is the user's IP being
    // refused by screener.in for the best part of an hour.
    concurrency = 2,
    delayMs = 2000,
    attemptsPerPage = 4,
    // Level-1 buckets are large: Consumer Discretionary is 1,402 companies, 57
    // pages. 120 leaves headroom for growth without letting a misparse page
    // forever.
    maxPagesPerIndustry = 120,
    onProgress,
  } = opts;

  const fresh = force ? null : readCache(ttlMs(opts.ttlHours));
  // A shallower cache cannot answer a deeper question; re-sweep instead.
  const cached = fresh && fresh.minMarketCapCr <= minMarketCapCr ? fresh : null;
  if (cached && cached.failedIndustries.length === 0) return cached;

  // Repair pass: keep what we have and retry only the gaps, at the floor that
  // sweep used so the result stays internally consistent. Otherwise start from
  // /market/, which is also how a changed taxonomy gets picked up.
  const repairing = cached !== null;
  const floor = repairing ? cached.minMarketCapCr : minMarketCapCr;
  const sweepLevel = repairing ? cached.sweepLevel : level;
  const todo = repairing
    ? cached.failedIndustries.map(({ path, name }) => ({ path, name }))
    : parseIndustryIndex(await fetchMarketHtml("/market/"), level);
  if (todo.length === 0) {
    throw new Error("Screener /market/ listed no industry pages — the page layout may have changed");
  }

  const rows: MarketRow[] = cached ? [...cached.rows] : [];
  const bySlug = new Set(rows.map((r) => r.slug));
  const failedIndustries: Universe["failedIndustries"] = [];
  let columns = cached?.columns ?? [];
  let pagesFetched = repairing ? 0 : 1; // the /market/ index itself
  let leavesVisited = cached?.leavesVisited ?? 0;
  let done = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  await mapPool(todo, concurrency, async (industry) => {
    if (aborted) {
      failedIndustries.push({
        path: industry.path,
        name: industry.name,
        reason: `skipped: sweep abandoned after ${ABORT_AFTER_CONSECUTIVE_FAILURES} consecutive failures`,
      });
    } else {
      try {
        const page = await fetchIndustry(
          industry,
          maxPagesPerIndustry,
          delayMs,
          attemptsPerPage,
          floor,
        );
        pagesFetched += page.pagesFetched;
        consecutiveFailures = 0;
        if (columns.length === 0) columns = page.columns;
        if (page.rows.length > 0) leavesVisited++;
        // A rolled-up path has no anchor text, so the page heading is its label.
        if (industry.name === "") industry.name = page.heading ?? industry.path;
        // A company can be listed under more than one bucket; first one wins so a
        // row's industryPath stays stable across sweeps.
        for (const r of page.rows) {
          if (bySlug.has(r.slug)) continue;
          bySlug.add(r.slug);
          rows.push(r);
        }
      } catch (e) {
        failedIndustries.push({
          path: industry.path,
          name: industry.name,
          reason: e instanceof Error ? e.message : String(e),
        });
        if (++consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) aborted = true;
      }
      await sleep(delayMs);
    }
    done++;
    onProgress?.({
      industriesDone: done,
      industriesTotal: todo.length,
      pagesFetched,
      rows: rows.length,
      lastIndustry: industry.name,
    });
  });

  const universe: Universe = {
    rows,
    columns,
    industriesTotal: cached?.industriesTotal ?? todo.length,
    leavesVisited,
    pagesFetched,
    fetchedAt: cached?.fetchedAt ?? new Date().toISOString(),
    fromCache: false,
    failedIndustries,
    sweepLevel,
    minMarketCapCr: floor,
  };
  if (rows.length > 0) writeCache(universe);
  return universe;
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export type Comparator = ">" | "<" | ">=" | "<=" | "=";

export interface Clause {
  /** The caller's own text, echoed verbatim in appliedClauses/unappliedClauses. */
  text: string;
  field: MetricField;
  op: Comparator;
  value: number;
}

/** Thrown when nothing in the query can be evaluated anonymously. Returning the
 * unfiltered universe instead would present ~4,000 rows as a screen result. */
export class UnsupportedQueryError extends Error {}

const CLAUSE_RE = /^\s*(.+?)\s*(>=|<=|!=|=|>|<)\s*(-?[\d,.]+)\s*%?\s*$/;

export interface ParsedQuery {
  clauses: Clause[];
  unapplied: { text: string; reason: string }[];
}

/**
 * Split a Screener DSL string into clauses we can evaluate and clauses we cannot.
 *
 * AND is the only connective supported. OR and parentheses are left *unapplied*
 * rather than approximated: `A AND (B OR C)` filters on A and reports the rest,
 * which yields a superset of the true answer — honest, and the caller is told.
 */
export function parseQuery(query: string): ParsedQuery {
  const clauses: Clause[] = [];
  const unapplied: { text: string; reason: string }[] = [];

  for (const raw of query.split(/\bAND\b/i)) {
    const text = raw.trim();
    if (text === "") continue;

    if (/[()]/.test(text) || /\bOR\b/i.test(text)) {
      unapplied.push({ text, reason: "OR and parenthesised expressions are not supported" });
      continue;
    }
    const m = text.match(CLAUSE_RE);
    if (!m) {
      unapplied.push({ text, reason: "could not be parsed as '<metric> <op> <number>'" });
      continue;
    }
    const [, name, op, rhs] = m;
    if (op === "!=") {
      unapplied.push({ text, reason: "'!=' is not supported" });
      continue;
    }
    const field = FIELD_BY_KEY.get(normKey(name));
    if (field === undefined) {
      unapplied.push({
        text,
        reason: `'${name.trim()}' is not published on Screener's anonymous industry pages`,
      });
      continue;
    }
    const value = num(rhs);
    if (value === null) {
      unapplied.push({ text, reason: `'${rhs}' is not a number` });
      continue;
    }
    clauses.push({ text, field, op: op as Comparator, value });
  }

  return { clauses, unapplied };
}

/**
 * The market-cap floor implied by a query, Rs. Cr., or 0 if it has none.
 *
 * This is what lets a screen cost 31 requests instead of 223, so it has to be
 * conservative in one direction only: never claim a floor the query does not
 * really impose. `>`, `>=` and `=` all bound from below, and taking `>` as
 * inclusive is deliberately slack — it can only make the sweep fetch one page
 * more than strictly needed. `<`, `<=` bound from above and imply nothing.
 * Several floors mean the tightest wins.
 */
function marketCapFloor(clauses: Clause[]): number {
  let floor = 0;
  for (const c of clauses) {
    if (c.field !== "marketCapCr") continue;
    if (c.op === ">" || c.op === ">=" || c.op === "=") floor = Math.max(floor, c.value);
  }
  return floor > 0 ? floor : 0;
}

function passes(row: MarketRow, c: Clause): boolean {
  const v = row[c.field];
  // A blank cell is unknown, not zero. Excluding it is the only safe reading:
  // "ROCE > 15" must not admit a company whose ROCE Screener never published.
  if (v === null) return false;
  switch (c.op) {
    case ">":
      return v > c.value;
    case "<":
      return v < c.value;
    case ">=":
      return v >= c.value;
    case "<=":
      return v <= c.value;
    case "=":
      return v === c.value;
  }
}

export interface AnonymousScreenRow extends MarketRow {
  /** Display strings keyed by Screener's verbatim column labels — mirrors
   * `ScreenRow.metrics` so this result can stand in for a run_screen result.
   * Rendered from the typed values, so "2547" not "2547.00". */
  metrics: Record<string, string>;
}

export interface AnonymousScreenResult extends ScreenResult {
  rows: AnonymousScreenRow[];
  source: "anonymous-industry-pages";
  /** Rows matching the applied clauses, before `limit`. Mirrors `totalResults`. */
  totalResults: number;
  /** How many companies were screened, and when they were fetched. */
  universeSize: number;
  universeFetchedAt: string;
  /** The market-cap floor the universe was swept to, Rs. Cr. Above 0, `universeSize`
   * counts only companies at or above it — it is not the size of the market. */
  universeMinMarketCapCr: number;
  /** Taxonomy depth swept: 1 means `industryName` on each row is a sector rather
   * than a specific industry. */
  universeSweepLevel: number;
  appliedClauses: string[];
  /** Clauses that were NOT evaluated. Non-empty means `rows` is a superset. */
  unappliedClauses: string[];
  /** Plain-language summary of the above, safe to relay to a user verbatim. */
  note: string;
}

export interface ScreenAnonymouslyOptions extends FetchUniverseOptions {
  /** Metric to sort by; DSL name or field name. Defaults to market cap. */
  sort?: string;
  order?: "asc" | "desc";
  /** Rows returned; `totalResults` still reports the full match count. */
  limit?: number;
  /** Reuse an already-fetched universe instead of hitting the cache/network. */
  universe?: Universe;
}

/**
 * Run a Screener DSL query against the anonymous universe.
 *
 * Accepts the same query strings as `run_screen` but evaluates them locally, so
 * no session cookie is needed. Only the nine metrics in `SUPPORTED_METRICS`
 * exist on Screener's public industry pages; every other clause comes back in
 * `unappliedClauses` and is described in `note`. The intended workflow is
 * "narrow here, then call get_ratios per shortlisted symbol to check the rest".
 *
 * Throws `UnsupportedQueryError` when no clause at all could be applied — the
 * alternative, handing back the whole universe labelled as a screen result, is
 * the exact false confidence this module exists to avoid.
 *
 * A market-cap clause in the query pays for itself: it becomes the sweep's floor,
 * which is the difference between a ~40 s first call and a ~5 min one. Callers who
 * want that speed without such a clause can set `minMarketCapCr` explicitly, which
 * is then applied as a filter as well as a floor so the answer does not depend on
 * how deep the cache happens to reach.
 */
export async function screenAnonymously(
  query: string,
  opts: ScreenAnonymouslyOptions = {},
): Promise<AnonymousScreenResult> {
  const { clauses, unapplied } = parseQuery(query);
  if (clauses.length === 0) {
    const names = SUPPORTED_METRICS.map((m) => m.dslName).join(", ");
    throw new UnsupportedQueryError(
      `None of this query can be evaluated without a Screener login: ` +
        unapplied.map((u) => `"${u.text}" (${u.reason})`).join("; ") +
        `. Anonymous screening supports only: ${names}. ` +
        `Either rewrite the query with those metrics, or sign in (\`npx screener-mcp login\`) and use run_screen.`,
    );
  }

  // An explicit floor above the query's own narrows the answer, so it is recorded
  // as a real clause: `appliedClauses` shows it, and the rows are the same whether
  // the universe came from a floored sweep or a complete cache.
  const queryFloor = marketCapFloor(clauses);
  const askedFloor = Math.max(0, opts.minMarketCapCr ?? 0);
  if (askedFloor > queryFloor) {
    clauses.push({
      text: `Market Capitalization >= ${askedFloor}`,
      field: "marketCapCr",
      op: ">=",
      value: askedFloor,
    });
  }
  const floor = Math.max(queryFloor, askedFloor);

  const universe = opts.universe ?? (await fetchUniverse({ ...opts, minMarketCapCr: floor }));
  const matched = universe.rows.filter((r) => clauses.every((c) => passes(r, c)));

  // Sort key: default to market cap desc, which is what the industry pages
  // themselves default to and puts the recognisable names first.
  // An unrecognised sort falls back to that default rather than to raw sweep
  // order, so the ranking stays deterministic; `note` still says it was dropped.
  const requested = opts.sort === undefined ? "marketCapCr" : FIELD_BY_KEY.get(normKey(opts.sort));
  const sortIgnored = requested === undefined;
  const sortField: MetricField = requested ?? "marketCapCr";
  const dir = (opts.order ?? "desc") === "asc" ? 1 : -1;
  // Nulls always sort last: an unknown metric should never top a ranking.
  matched.sort((a, b) => {
    const x = a[sortField];
    const y = b[sortField];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });

  const limit = opts.limit ?? 200;
  const columns = universe.columns.length > 0 ? universe.columns : [];
  const rows: AnonymousScreenRow[] = matched.slice(0, Math.max(0, limit)).map((r) => {
    // Same convention as runScreen: keyed by Screener's column labels, minus the
    // two identity columns that live on the row itself.
    const metrics: Record<string, string> = {};
    for (const label of columns) {
      if (label === "S.No." || label === "Name") continue;
      const field = FIELD_BY_KEY.get(normKey(label));
      const v = field ? r[field] : null;
      metrics[label] = v === null ? "" : String(v);
    }
    return { ...r, metrics };
  });

  // The note is ordered worst-news-first, because a caller who reads only the
  // start of it must still learn that the answer is incomplete.
  const parts: string[] = [];
  if (universe.failedIndustries.length > 0) {
    parts.push(
      `INCOMPLETE UNIVERSE: ${universe.failedIndustries.length} of ${universe.industriesTotal} ` +
        `industries could not be fetched (${universe.failedIndustries[0].reason}), so matching ` +
        `companies may be missing entirely. Call again to retry just the missing industries.`,
    );
  }
  if (unapplied.length > 0) {
    parts.push(
      `${unapplied.length} clause(s) could NOT be applied: ` +
        unapplied.map((u) => `"${u.text}" — ${u.reason}`).join("; ") +
        `. These rows are therefore a SUPERSET of your query: they satisfy ` +
        `${clauses.map((c) => `"${c.text}"`).join(" AND ")} only. ` +
        `Call get_ratios on each shortlisted symbol to check the remaining condition(s) yourself.`,
    );
  }
  if (sortIgnored) parts.push(`sort '${opts.sort}' ignored: not an anonymous column.`);
  if (matched.length > rows.length) {
    parts.push(`${matched.length} matched; showing the first ${rows.length} (raise limit for more).`);
  }
  parts.push(
    `Screened locally against ${universe.rows.length} companies from Screener's public industry ` +
      `pages (fetched ${universe.fetchedAt}${universe.fromCache ? ", from cache" : ""}). No login used.`,
  );
  if (universe.minMarketCapCr > 0) {
    parts.push(
      `That universe covers only companies at or above ${universe.minMarketCapCr} Cr market cap — ` +
        `the sweep stopped there because the query cannot match anything smaller, so ` +
        `universeSize is not the size of the market.`,
    );
  }
  if (universe.sweepLevel < 4) {
    parts.push(`industryName is a sector, not a specific industry (swept at level ${universe.sweepLevel}).`);
  }

  return {
    query,
    source: "anonymous-industry-pages",
    totalResults: matched.length,
    pagesFetched: universe.pagesFetched,
    columns,
    rows,
    universeSize: universe.rows.length,
    universeFetchedAt: universe.fetchedAt,
    universeMinMarketCapCr: universe.minMarketCapCr,
    universeSweepLevel: universe.sweepLevel,
    appliedClauses: clauses.map((c) => c.text),
    unappliedClauses: unapplied.map((u) => u.text),
    note: parts.join(" "),
  };
}
