/**
 * Anonymous stock screening.
 *
 * `/screen/raw/` — the DSL endpoint `runScreen` uses — 302s anonymous callers to
 * /register/, so screening used to require a session cookie. Screener publishes
 * the same table anonymously through its industry browser: /market/ links 188
 * leaf industry pages, and each leaf renders the identical column set that a
 * screen renders (CMP, P/E, Mar Cap, Div Yld, NP Qtr, Qtr Profit Var, Sales Qtr,
 * Qtr Sales Var, ROCE). Sweeping every leaf therefore yields the whole universe —
 * 5,438 companies as of 2026-09-04, from Bharti Airtel (11.5 lakh Cr) down to
 * microcaps worth well under a crore (smallest seen: 0.07 Cr) — no login at all.
 *
 * The trade is that only those nine metrics exist anonymously. Anything else the
 * DSL can express (ROE, debt/equity, Piotroski, promoter holding, ...) simply is
 * not on these pages, so `screenAnonymously` reports such clauses as *unapplied*
 * rather than dropping them. A screen that silently ignored a filter would be
 * confidently wrong, which is worse than one that admits what it could not do.
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
 * rather than deserialized into the wrong type. */
const CACHE_VERSION = 1;

const DEFAULT_TTL_HOURS = 12;

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
  /** The leaf this row came from, e.g. "IN01/IN0101/IN010101/IN010101001". */
  industryPath: string;
  /** Screener's label for that leaf, e.g. "Commodity Chemicals". */
  industryName: string;
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

/** Leaf paths from /market/, e.g. "IN01/IN0101/IN010101/IN010101001". Extracted
 * rather than hardcoded so a reorganised taxonomy is picked up on the next sweep;
 * /market/ links only leaves, so a 4-level shape is the whole filter we need. */
export function parseIndustryIndex(html: string): { path: string; name: string }[] {
  const seen = new Set<string>();
  const out: { path: string; name: string }[] = [];
  for (const a of parse(html).querySelectorAll("a[href^='/market/']")) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(/^\/market\/(IN\d+\/IN\d+\/IN\d+\/IN\d+)\/$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ path: m[1], name: txt(a) || m[1] });
  }
  return out;
}

export interface IndustryPage {
  rows: MarketRow[];
  /** Screener's verbatim column labels, first header block only. */
  columns: string[];
  /** From the "<N> results found" line — the leaf's true company count. */
  resultsFound: number | null;
}

/**
 * Parse one leaf industry page (or, identically, a /screen/raw/ page).
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
  if (!table) return { rows: [], columns: [], resultsFound };

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
      industryName,
      companyId: id ? Number(id) : null,
      ...metrics,
    });
  }

  return { rows, columns, resultsFound };
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
  /** Safety valve for a pathologically large leaf. */
  maxPagesPerIndustry?: number;
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
  /** Leaves we never managed to read. Non-empty means `rows` is missing companies,
   * which a caller must disclose rather than present as a small market. */
  failedIndustries: { path: string; name: string; reason: string }[];
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
    if (c.version !== CACHE_VERSION || !Array.isArray(c.rows) || c.rows.length === 0) return null;
    const age = Date.now() - Date.parse(c.fetchedAt);
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
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

/** Page through one leaf. */
async function fetchIndustry(
  industry: { path: string; name: string },
  maxPages: number,
  delayMs: number,
  attempts: number,
): Promise<IndustryPage & { pagesFetched: number }> {
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  let columns: string[] = [];
  let resultsFound: number | null = null;
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

    const fresh = parsed.rows.filter((r) => !seen.has(r.slug));
    for (const r of fresh) {
      seen.add(r.slug);
      rows.push(r);
    }

    // Out-of-range pages neither 404 nor come back empty: Screener CLAMPS to the
    // last page and re-serves it (?page=100 on a 74-row leaf returns rows 51-74).
    // So "no new slugs" is the real terminator; the empty and short-page checks
    // are belt-and-braces for leaves that behave differently.
    if (fresh.length === 0) break;
    if (parsed.rows.length < ROWS_PER_PAGE) break;
    if (resultsFound !== null && rows.length >= resultsFound) break;
    await sleep(delayMs);
  }

  return { rows, columns, resultsFound, pagesFetched };
}

/**
 * Every company Screener publishes, swept from the public industry browser.
 *
 * Measured 2026-09-04: 188 leaves, 336 requests, 5,438 companies, 449 s at the
 * default pacing. Minutes, not seconds — so the result is cached on disk for 12h
 * and callers should pass `onProgress` to report "142/188 industries" meanwhile.
 *
 * A partial sweep is cached too, and the next call *repairs* it: only the leaves
 * that failed are re-fetched, and the original `fetchedAt` is kept so repairs
 * cannot refresh the TTL of rows that are actually a day old. That makes a
 * throttled sweep converge over a few calls instead of restarting from zero and
 * re-hammering the 180 leaves that already worked.
 */
export async function fetchUniverse(opts: FetchUniverseOptions = {}): Promise<Universe> {
  const {
    force = false,
    // Both measured 2026-09-04. 4-in-flight with a 200 ms gap (~6 req/s) earned
    // an HTTP 429 inside ~30 requests and then a TCP-level block of this IP that
    // lasted ~57 minutes. 2-in-flight with a 2 s gap (~0.75 req/s) completed all
    // 188 leaves, 336 requests, untouched, in 449 s. Do not raise these without
    // re-measuring: the penalty is not a slow tool, it is the user's IP being
    // refused by screener.in for the best part of an hour.
    concurrency = 2,
    delayMs = 2000,
    attemptsPerPage = 4,
    maxPagesPerIndustry = 40,
    onProgress,
  } = opts;

  const cached = force ? null : readCache(ttlMs(opts.ttlHours));
  if (cached && cached.failedIndustries.length === 0) return cached;

  // Repair pass: keep what we have and retry only the gaps. Otherwise start from
  // /market/, which is also how a changed taxonomy gets picked up.
  const repairing = cached !== null;
  const todo = repairing
    ? cached.failedIndustries.map(({ path, name }) => ({ path, name }))
    : parseIndustryIndex(await fetchMarketHtml("/market/"));
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
        const page = await fetchIndustry(industry, maxPagesPerIndustry, delayMs, attemptsPerPage);
        pagesFetched += page.pagesFetched;
        consecutiveFailures = 0;
        if (columns.length === 0) columns = page.columns;
        if (page.rows.length > 0) leavesVisited++;
        // A company can be listed under more than one leaf; first one wins so a
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

  const universe = opts.universe ?? (await fetchUniverse(opts));
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

  return {
    query,
    source: "anonymous-industry-pages",
    totalResults: matched.length,
    pagesFetched: universe.pagesFetched,
    columns,
    rows,
    universeSize: universe.rows.length,
    universeFetchedAt: universe.fetchedAt,
    appliedClauses: clauses.map((c) => c.text),
    unappliedClauses: unapplied.map((u) => u.text),
    note: parts.join(" "),
  };
}
