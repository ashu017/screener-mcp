/**
 * Public screens — running an arbitrary screen without ever handling a credential.
 *
 * Screener's custom-query endpoints (`/screen/raw/`, `/screen/new/`) 302 anonymous
 * callers to /register/, so we cannot run a bespoke DSL query on a user's behalf.
 * Asking them to dig a `sessionid` cookie out of DevTools is the thing we are
 * trying to eliminate, so this module takes the two-step route instead — neither
 * step needs a secret from them:
 *
 *   1. Hand-off. `buildScreenLink` mints a link to Screener's own query builder.
 *      The user's browser is already signed in, so *they* click it and the screen
 *      runs there. Nothing is transferred to us and nothing is stored.
 *   2. Durable capture. Once they save that screen it lives at
 *      /screens/<id>/<slug>/, which is readable anonymously — with pagination, and
 *      with no expiry. One click turns a login-gated query into a permanent public
 *      read. Sorting is the one thing that stays behind the wall: see `sort` below.
 *
 * There is no shortcut around step 2: passing `?query=` or `?q=` to a public
 * screen URL is silently ignored (the screen serves its own results regardless),
 * so the save is what actually buys us the custom query.
 *
 * Maintainer note: screener.in/robots.txt disallows the `?page=` and `?sort=`
 * parameters this module sends (and `/*?q=`, `/*?limit=`).
 */

import { parse, type HTMLElement } from "node-html-parser";
import { AuthRequiredError, headers, type ScreenResult, type ScreenRow } from "./screener.js";
import { normalizeLabel, num } from "./numbers.js";

const BASE = "https://www.screener.in";

/** Rows per page for an anonymous visitor. Screener's 10/25/50 selector drives
 * `?limit=`, which is itself login-gated (302 -> /register/), so 25 per request is
 * the ceiling without a session. */
const ROWS_PER_PAGE = 25;

/** Breather between page fetches. We are an uninvited client on someone else's
 * server; a twenty-page walk should not arrive as a burst. Screener does block an
 * IP that asks too fast, and it blocks at the TCP level rather than answering 429,
 * so the failure looks like the site being down. */
const PAGE_DELAY_MS = 300;

/** Hard ceiling on pages per call — 1,000 rows, and a bound on the damage a
 * caller can do by passing `maxPages: 500` to a 3,000-row screen. */
const MAX_PAGES = 40;

/** A canonical public-screen path, which is what Screener redirects us to when the
 * slug we asked for is wrong or missing. */
const CANONICAL_PATH = /^\/screens\/\d+\/[^/]+\/$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep user-supplied text out of multi-line error messages. */
function clip(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Raised when a screen id or URL is not readable anonymously.
 *
 * Screener does not distinguish the reasons — a deleted screen, an id that never
 * existed and (as far as we can tell) a screen its owner has not shared all come
 * back as a 404 or a 302 to /register/ — so the message names the one thing the
 * user can act on.
 */
export class ScreenNotPublicError extends Error {
  constructor(readonly screenId: number) {
    super(
      `Screener has no publicly readable screen with id ${screenId}. ` +
        `If it is the user's own screen, ask them to open it in their browser, save it, ` +
        `pick the public/shared option if one is offered, then paste the address back.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. The hand-off
// ---------------------------------------------------------------------------

export interface ScreenLink {
  /** The DSL echoed back, so an agent can show the user what it is about to run. */
  query: string;
  /** Screener's interactive builder with the query pre-filled. Login-gated on
   * purpose: the user's own browser supplies the session we deliberately lack. */
  url: string;
  /** The same query straight to the results table, for a user already signed in. */
  resultsUrl: string;
  /** Numbered hand-off, safe to relay verbatim. Assumes no technical vocabulary
   * and never asks for a cookie, a password or a token. */
  instructions: string;
  /** The same steps unnumbered, for a caller that renders its own list. */
  steps: string[];
}

/**
 * Step 4's button label ("Save Your Query", top right) is Screener's own wording,
 * from https://www.screener.in/guides/creating-screens/.
 *
 * Step 5 is deliberately conditional. That guide documents saving but says nothing
 * about who can see a saved screen, and the save form is only rendered to
 * signed-in users, so we have not been able to confirm whether there is a
 * public/private control at all. "If Screener offers a choice" is true either way;
 * naming a checkbox that may not exist would leave the user hunting for it.
 */
const HANDOFF_STEPS: string[] = [
  "Click the link below. It opens Screener with this screen already filled in.",
  "If Screener asks you to sign in, go ahead — you are signing in to Screener itself, so I never see your password.",
  "The screen runs and lists the companies that match. That is your answer for today.",
  'To make it reusable, click "Save Your Query" at the top right and give the screen a name.',
  "If Screener offers a choice about who can see the saved screen, pick the public or shared option.",
  "Copy the web address from your browser's address bar and paste it back to me. It looks like " +
    "https://www.screener.in/screens/1234567/your-screen-name/ — once I have that, I can read this " +
    "screen myself any time, without you signing in again.",
];

/**
 * Turn a Screener DSL query into a link the user can click, plus the words to send
 * with it.
 *
 * Example query:
 *   "Return on capital employed > 15 AND Return on equity > 15 AND Market Capitalization > 10000"
 */
export function buildScreenLink(query: string): ScreenLink {
  const q = query.trim();
  if (!q) throw new Error("buildScreenLink: query is empty.");

  // Every real query contains spaces and a > or <, so the encoding has to survive
  // a round trip. URLSearchParams is also exactly what Screener's own
  // <textarea name="query"> form submits, hence the parameter name.
  const params = new URLSearchParams({ query: q });

  return {
    query: q,
    url: `${BASE}/screen/new/?${params}`,
    resultsUrl: `${BASE}/screen/raw/?${params}`,
    instructions: HANDOFF_STEPS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    steps: [...HANDOFF_STEPS],
  };
}

// ---------------------------------------------------------------------------
// 2. Reading a saved public screen
// ---------------------------------------------------------------------------

export interface ScreenRef {
  id: number;
  /** Slug when the input carried one. Null is fine — `fetchPublicScreen` resolves
   * it, because /screens/<id>/ with no slug is a 404. */
  slug: string | null;
}

/**
 * Accept a screen reference in whatever shape it arrives: a bare id, a full URL,
 * a URL with a `?page=2` tail, a missing scheme, a missing trailing slash.
 *
 * Liberal on purpose. This is the function a non-technical user's copy-paste lands
 * in, and the whole layer is pointless if it trips over the address bar.
 */
export function parseScreenRef(idOrUrl: string | number): ScreenRef {
  const raw = String(idOrUrl ?? "").trim();
  if (/^\d+$/.test(raw)) return { id: Number(raw), slug: null };

  const m = raw.match(/(?:^|\/)screens\/(\d+)(?:\/([^/?#\s]+))?/i);
  if (m) return { id: Number(m[1]), slug: m[2] ?? null };

  // A builder link is the one wrong-but-plausible paste — it carries the query,
  // not a saved screen — so name that instead of "unparseable".
  if (/\/screen\/(new|raw)\//i.test(raw)) {
    throw new Error(
      `That is a Screener query-builder link, not a saved screen: "${clip(raw)}". ` +
        `Ask the user to save the screen first, then paste the /screens/<id>/<name>/ address.`,
    );
  }
  throw new Error(
    `Not a Screener screen id or address: "${clip(raw)}". ` +
      `Expected a number like 2437615, or a link like ` +
      `https://www.screener.in/screens/2437615/my-screen/.`,
  );
}

interface Fetched {
  status: number;
  location: string | null;
  html: string;
}

/**
 * Anonymous GET, redirects unfollowed.
 *
 * `headers()` carries a session cookie when one happens to exist, since Screener
 * serves richer data to signed-in users on these same URLs — but every path below
 * is correct with no session at all, which is the point of the module.
 */
async function get(path: string, params?: URLSearchParams): Promise<Fetched> {
  const qs = params && [...params.keys()].length > 0 ? `?${params}` : "";
  const res = await fetch(`${BASE}${path}${qs}`, { headers: headers(), redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    return { status: res.status, location: res.headers.get("location"), html: "" };
  }
  if (!res.ok) return { status: res.status, location: null, html: "" };
  return { status: res.status, location: null, html: await res.text() };
}

function isLoginRedirect(location: string): boolean {
  return /\/(login|register)\//.test(location);
}

/**
 * Turn a `ScreenRef` into a fetchable path.
 *
 * /screens/<id>/ with no slug is a 404, but /screens/<id>/<anything>/ 302s to the
 * canonical slug — so a bare id becomes one placeholder request whose Location
 * header tells us the real path.
 */
async function resolvePath(ref: ScreenRef): Promise<string> {
  if (ref.slug) return `/screens/${ref.id}/${ref.slug}/`;

  const placeholder = `/screens/${ref.id}/s/`;
  const r = await get(placeholder);
  if (r.status === 200) return placeholder; // the placeholder happened to be the real slug
  if (r.status >= 300 && r.status < 400) {
    const next = (r.location ?? "").split("?")[0];
    if (!isLoginRedirect(next) && CANONICAL_PATH.test(next)) return next;
  }
  throw new ScreenNotPublicError(ref.id);
}

/**
 * Fetch one page of a public screen, correcting the slug if Screener redirects.
 *
 * The canonicalising redirect drops the query string, so the params have to be
 * re-attached to the new path rather than taken from the Location header.
 *
 * Three different failures all arrive as a 3xx, and they need different answers:
 * a slug fix (follow it), a login wall (name whichever gate we hit), and anything
 * else (say we do not understand it rather than guess).
 */
async function fetchScreenPage(
  id: number,
  startPath: string,
  params: URLSearchParams,
): Promise<{ html: string; path: string }> {
  let path = startPath;
  for (let hop = 0; hop < 2; hop++) {
    const r = await get(path, params);
    if (r.status === 200) return { html: r.html, path };
    if (r.status >= 300 && r.status < 400) {
      const next = (r.location ?? "").split("?")[0];
      if (CANONICAL_PATH.test(next) && next !== path) {
        path = next;
        continue;
      }
      if (isLoginRedirect(next)) {
        // `sort` is gated for anonymous readers even on a screen whose plain pages
        // we can read (measured: ?sort=... -> 302 /register/, ?page= and ?order=
        // -> 200). Blame the parameter we know is gated before blaming the screen.
        // A private screen asked for *with* a sort therefore reports as a sorting
        // problem; retrying without `sort` tells the two apart.
        if (params.has("sort")) throw new AuthRequiredError("Sorting a Screener public screen");
        throw new ScreenNotPublicError(id);
      }
      throw new Error(`Screener redirected ${path} to ${next || "an unknown location"}`);
    }
    if (r.status === 404) throw new ScreenNotPublicError(id);
    throw new Error(`Screener ${path} -> HTTP ${r.status}`);
  }
  throw new Error(`Screener kept redirecting ${startPath}`);
}

export interface SortableColumn {
  /** The exact value to pass as `sort`, e.g. "market capitalization". */
  key: string;
  /** Column header as displayed, e.g. "Mar Cap Rs.Cr.". */
  label: string;
  /** Screener's canonical ratio name, e.g. "Market Capitalization". */
  ratio: string;
}

export interface PublicScreenResult extends ScreenResult {
  id: number;
  slug: string;
  url: string;
  title: string;
  /** The screen's own DSL, read back off the page — so a caller can report what a
   * saved screen actually filters on, or re-run it verbatim through `run_screen`.
   * Empty string if the builder form ever stops being rendered anonymously. */
  query: string;
  description: string | null;
  /** Screener credits the screen's creator; useful for telling a user's own saved
   * screen apart from a curated one. */
  author: string | null;
  totalPages: number | null;
  rowsPerPage: number;
  /** Valid `sort` values, lifted from the header links. Screener wants the ratio
   * name ("market capitalization"), not the display label ("Mar Cap") — the label
   * is accepted and silently returns zero companies. Worth reporting even though
   * an anonymous caller cannot use them: the page advertises the sort links to
   * everyone, and they do work once a session exists. */
  sortableColumns: SortableColumn[];
  appliedSort: string | null;
  appliedOrder: string | null;
  /** Human-readable notes about a result that is technically fine but probably not
   * what the caller meant — chiefly an unrecognised `sort`. */
  warnings: string[];
}

/**
 * Cells of the first header block.
 *
 * Screener repeats the whole `<th>` row every few data rows, so everything after
 * the second "S.No." is a duplicate — the same quirk `runScreen` works around.
 * Here the `<th>`s sit in `<tbody>` rather than `<thead>`, and each carries the
 * sort link we harvest below.
 */
function firstHeaderBlock(table: HTMLElement): HTMLElement[] {
  const ths = table.querySelectorAll("th");
  const isSNo = (th: HTMLElement): boolean => normalizeLabel(th.text) === "S.No.";
  const start = ths.findIndex(isSNo);
  if (start < 0) return ths;
  const next = ths.slice(start + 1).findIndex(isSNo);
  return next < 0 ? ths.slice(start) : ths.slice(start, start + 1 + next);
}

function parseSortableColumns(ths: HTMLElement[]): SortableColumn[] {
  const out: SortableColumn[] = [];
  for (const th of ths) {
    const a = th.querySelector("a[href*='sort=']");
    if (!a) continue; // "S.No." links to ?order=asc only
    const href = a.getAttribute("href") ?? "";
    const q = href.indexOf("?");
    if (q < 0) continue;
    // The href is the authoritative spelling of the key; "+" decodes back to the
    // space Screener expects.
    const key = new URLSearchParams(href.slice(q + 1)).get("sort");
    if (!key) continue;
    const aria = (a.getAttribute("aria-label") ?? "").replace(/^Sort on\s+/i, "").trim();
    out.push({
      key,
      label: normalizeLabel(th.text),
      ratio: th.getAttribute("data-tooltip") || aria || key,
    });
  }
  return out;
}

function parseRows(table: HTMLElement, columns: string[]): ScreenRow[] {
  const rows: ScreenRow[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const link = tr.querySelector("a[href*='/company/']");
    if (!link) continue; // repeated header block, or a spacer row
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
  }
  return rows;
}

/** The blurb and byline Screener prints under the title. */
function parseByline(root: HTMLElement): { description: string | null; author: string | null } {
  const byline = root.querySelectorAll("p.sub").find((p) => /\/user\/\d+\//.test(p.innerHTML));
  if (!byline) return { description: null, author: null };
  const author = normalizeLabel(byline.querySelector("a[href*='/user/']")?.text ?? "") || null;
  // The description is the plain <p> sibling in the same box.
  const desc = byline.parentNode
    ?.querySelectorAll("p")
    .find((p) => !(p.getAttribute("class") ?? "").includes("sub"));
  return { description: normalizeLabel(desc?.text ?? "") || null, author };
}

function parseTotalPages(root: HTMLElement, totalResults: number | null): number | null {
  const linked = root
    .querySelectorAll(".pagination a[href*='page=']")
    .map((a) => {
      const href = a.getAttribute("href") ?? "";
      return Number(new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("page"));
    })
    .filter((n) => Number.isFinite(n) && n > 0);
  // A screen's pagination bar elides the middle but always links the last page,
  // and totalResults/ROWS_PER_PAGE agrees; take whichever we have.
  const candidates = [
    linked.length > 0 ? Math.max(...linked) : null,
    totalResults !== null ? Math.ceil(totalResults / ROWS_PER_PAGE) : null,
  ].filter((n): n is number => n !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Read a saved public screen anonymously and page through its results.
 *
 * 25 rows per page, so `maxPages` bounds both latency and how hard we lean on
 * Screener; it is clamped to MAX_PAGES, and the walk stops early once we hold every
 * row the page claims exists.
 *
 * `sort` needs a session. Measured against the live site: `?sort=<anything>` on a
 * publicly readable screen 302s to /register/, while `?page=` and `?order=` on the
 * same URL both return 200 — Screener renders the sort links to anonymous visitors
 * but puts a registration wall behind them. `order` on its own is accepted and then
 * ignored (byte-identical row order), so it is not a way in. So `sort` raises
 * AuthRequiredError
 * unless a session cookie exists, and the honest way to get "the biggest companies
 * in this screen" without one is to page through the whole screen and order the
 * rows locally. Sorting one page of 25 would just relabel an arbitrary slice.
 *
 * When it is usable, `sort` must be a ratio name rather than a column header — pass
 * one of the `key` values from `sortableColumns`, which are reported either way.
 */
export async function fetchPublicScreen(
  idOrUrl: string | number,
  { maxPages = 4, sort, order }: { maxPages?: number; sort?: string; order?: string } = {},
): Promise<PublicScreenResult> {
  const ref = parseScreenRef(idOrUrl);
  let path = await resolvePath(ref);

  let title = "";
  let query = "";
  let description: string | null = null;
  let author: string | null = null;
  let totalResults: number | null = null;
  let totalPages: number | null = null;
  let columns: string[] = [];
  let sortableColumns: SortableColumn[] = [];
  const rows: ScreenRow[] = [];
  let pagesFetched = 0;

  const pageLimit = Math.min(Math.max(1, maxPages), MAX_PAGES);
  for (let page = 1; page <= pageLimit; page++) {
    const params = new URLSearchParams({ page: String(page) });
    if (sort) params.set("sort", sort);
    if (order) params.set("order", order);

    if (page > 1) await sleep(PAGE_DELAY_MS);
    const got = await fetchScreenPage(ref.id, path, params);
    path = got.path; // a stale slug canonicalises on the first hop; keep the fix
    const root = parse(got.html);

    if (pagesFetched === 0) {
      title = normalizeLabel(root.querySelector("h1")?.text ?? "");
      // A multi-line query comes back CRLF-separated from the textarea; strip the
      // carriage returns but keep the line breaks, which are part of how the
      // author wrote it and which Screener accepts on the way back in.
      query = (root.querySelector("textarea[name='query']")?.text ?? "").replace(/\r\n?/g, "\n").trim();
      ({ description, author } = parseByline(root));
      totalResults = num(got.html.match(/([\d,]+)\s*results?\s*found/i)?.[1] ?? null);
    }

    const table = root.querySelector("table.data-table") ?? root.querySelector("table");
    if (!table) break;

    if (columns.length === 0) {
      const ths = firstHeaderBlock(table);
      columns = ths.map((th) => normalizeLabel(th.text));
      sortableColumns = parseSortableColumns(ths);
    }
    if (totalPages === null) totalPages = parseTotalPages(root, totalResults);

    const pageRows = parseRows(table, columns);
    rows.push(...pageRows);
    pagesFetched++;

    if (pageRows.length === 0) break;
    if (totalResults !== null && rows.length >= totalResults) break;
    if (totalPages !== null && page >= totalPages) break;
  }

  // An unknown `sort` is not an error to Screener: it accepts the parameter and
  // answers with an empty table. Say so, or the caller reports "no matches" for
  // what is really a typo — passing "Mar Cap" instead of "market capitalization".
  // Only reachable with a session, since anonymous `sort` never gets past the
  // registration wall; the empty-table behaviour was observed on a signed-in read.
  const warnings: string[] = [];
  if (sort && rows.length === 0 && sortableColumns.length > 0) {
    const known = sortableColumns.some((c) => c.key.toLowerCase() === sort.trim().toLowerCase());
    warnings.push(
      known
        ? `Sorting by "${sort}" returned no companies.`
        : `Sorting by "${sort}" returned no companies, and "${sort}" is not one of this screen's ` +
          `sort keys — Screener accepts an unknown key and answers with an empty table. Valid keys: ` +
          `${sortableColumns.map((c) => `"${c.key}"`).join(", ")}.`,
    );
  }

  return {
    id: ref.id,
    slug: path.split("/").filter(Boolean).at(-1) ?? "",
    url: `${BASE}${path}`,
    title,
    query,
    description,
    author,
    totalResults,
    totalPages,
    pagesFetched,
    rowsPerPage: ROWS_PER_PAGE,
    columns,
    sortableColumns,
    rows,
    appliedSort: sort ?? null,
    appliedOrder: order ?? null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Finding screens someone else already saved
// ---------------------------------------------------------------------------

export interface PublicScreenSummary {
  id: number;
  slug: string;
  title: string;
  /** The one-line blurb printed under the title. */
  description: string | null;
  /** Result count where the listing prints one. The current /screens/ layout does
   * not, so expect null; `fetchPublicScreen` is where counts come from. */
  resultCount: number | null;
  url: string;
}

export interface PublicScreenDirectory {
  page: number;
  pagesFetched: number;
  /** True while a "Next" link exists. /screens/ never prints a last-page number
   * (Screener's guide claims 50,000+ screens), so there is no total to report. */
  hasMore: boolean;
  screens: PublicScreenSummary[];
}

/**
 * Read Screener's public screen directory. A discovery convenience — often a user
 * wants a screen someone has already built rather than a new one.
 *
 * 25 listings per page, and the directory keeps serving pages far beyond any
 * plausible read, so `maxPages` stays deliberately small.
 */
export async function listPublicScreens({
  page = 1,
  maxPages = 1,
}: { page?: number; maxPages?: number } = {}): Promise<PublicScreenDirectory> {
  const screens: PublicScreenSummary[] = [];
  let hasMore = false;
  let pagesFetched = 0;

  for (let i = 0; i < Math.max(1, maxPages); i++) {
    if (i > 0) await sleep(PAGE_DELAY_MS);
    const r = await get("/screens/", new URLSearchParams({ page: String(page + i) }));
    if (r.status !== 200) throw new Error(`Screener /screens/ -> HTTP ${r.status}`);

    const root = parse(r.html);
    const before = screens.length;
    for (const a of root.querySelectorAll("a[href*='/screens/']")) {
      const href = a.getAttribute("href") ?? "";
      const m = href.match(/^\/screens\/(\d+)\/([^/?#]+)\//);
      if (!m) continue;
      const title = normalizeLabel(a.querySelector("strong")?.text ?? "");
      if (!title) continue; // nav/breadcrumb link rather than a listing
      screens.push({
        id: Number(m[1]),
        slug: m[2],
        title,
        description: normalizeLabel(a.querySelector(".sub")?.text ?? "") || null,
        resultCount: num(a.text.match(/([\d,]+)\s*results?/i)?.[1] ?? null),
        url: `${BASE}${href}`,
      });
    }

    pagesFetched++;
    hasMore = root.querySelectorAll(".pagination a").some((a) => /next/i.test(a.text));
    if (screens.length === before) break;
  }

  return { page, pagesFetched, hasMore, screens };
}
