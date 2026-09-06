import { test, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseFundamentals,
  parseFinancials,
  parseCompanyId,
  parseWarehouseId,
  fetchPeers,
  fetchCompanyHtml,
} from "../src/screener.js";
import { parse } from "node-html-parser";

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, "tcs.fixture.html"), "utf8");

test("parses company id from data-url", () => {
  expect(parseCompanyId(parse(html))).toBe(3365);
});

test("parses fundamentals ratio cards", () => {
  const f = parseFundamentals("TCS", html, "url");
  expect(f.name).toContain("Tata Consultancy");
  expect(f.companyId).toBe(3365);
  expect(f.ratios.length).toBeGreaterThanOrEqual(8);
  const pe = f.ratios.find((r) => /P\/E/i.test(r.name));
  expect(pe?.value).toBe("15.2");
  const roce = f.ratios.find((r) => r.name === "ROCE");
  expect(roce?.value).toMatch(/63/);
});

test("parses all statement sections with data", () => {
  const fin = parseFinancials(html);
  const sections = fin.map((s) => s.section);
  expect(sections).toContain("Profit & Loss");
  expect(sections).toContain("Balance Sheet");
  const pl = fin.find((s) => s.section === "Profit & Loss")!;
  expect(pl.columns.length).toBeGreaterThan(5);
  expect(pl.rows.length).toBeGreaterThan(5);
});

test("parses warehouse id (distinct from company id)", () => {
  const wid = parseWarehouseId(parse(html));
  expect(wid).toBe(6599230);
});

test("fetches and parses live peers (network)", async () => {
  const wid = parseWarehouseId(parse(html));
  const r = await fetchPeers(wid!);
  expect(r.peers.length).toBeGreaterThan(2);
  // TCS's peer set should include Infosys.
  expect(r.peers.some((p) => /INFY|Infosys/i.test(p.name))).toBe(true);
  expect(r.median).toBeTruthy();
}, 20000);

/**
 * Screener answers some consolidated views with a 200 whose statement tables
 * carry row labels and no period columns — measured on NETWEB, BHARTIHEXA,
 * KSHINTL and DYCL, all of which have 13 quarters on their standalone page. The
 * old fallback only triggered on a 404, so those companies silently returned
 * null ratios and zero quarters. These tests stub fetch so the fallback decision
 * itself is under test, not Screener's current markup.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A company page with `periods` period columns in each statement table. */
function pageWith(periods: number): string {
  const head = ["Label", ...Array.from({ length: periods }, (_, i) => `Mar ${2020 + i}`)]
    .map((h) => `<th>${h}</th>`)
    .join("");
  const table = `<table><thead><tr>${head}</tr></thead><tbody><tr><td>Sales</td></tr></tbody></table>`;
  return ["quarters", "profit-loss", "balance-sheet"]
    .map((id) => `<section id="${id}">${table}</section>`)
    .join("");
}

/** Serve a body per URL suffix; anything unlisted 404s, as Screener does. */
function stubFetch(bodies: { consolidated?: string; standalone?: string }): () => string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    seen.push(u);
    const body = u.endsWith("/consolidated/") ? bodies.consolidated : bodies.standalone;
    return body === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  }) as unknown as typeof fetch;
  return () => seen;
}

test("falls back to standalone when the consolidated view has no periods", async () => {
  const seen = stubFetch({ consolidated: pageWith(0), standalone: pageWith(13) });
  const { url } = await fetchCompanyHtml("NETWEB");
  expect(url).toBe("https://www.screener.in/company/NETWEB/");
  expect(seen()).toHaveLength(2);
});

test("keeps the consolidated view when it has periods, without a second request", async () => {
  const seen = stubFetch({ consolidated: pageWith(13), standalone: pageWith(13) });
  const { url } = await fetchCompanyHtml("POLYCAB");
  expect(url).toBe("https://www.screener.in/company/POLYCAB/consolidated/");
  expect(seen()).toHaveLength(1);
});

test("keeps consolidated when only some statements are empty", async () => {
  // ESDS: no quarterly table at all, but six years of annuals. Not the bug, and
  // its consolidated view reports one more year than its standalone one.
  const consolidated = `<section id="quarters"><table><thead><tr></tr></thead></table></section>${pageWith(6)}`;
  stubFetch({ consolidated, standalone: pageWith(5) });
  const { url } = await fetchCompanyHtml("ESDS");
  expect(url).toBe("https://www.screener.in/company/ESDS/consolidated/");
});

test("returns the consolidated view when both views are empty", async () => {
  stubFetch({ consolidated: pageWith(0), standalone: pageWith(0) });
  const { url } = await fetchCompanyHtml("EMPTY");
  expect(url).toBe("https://www.screener.in/company/EMPTY/consolidated/");
});

test("still throws when neither view exists", async () => {
  stubFetch({});
  await expect(fetchCompanyHtml("NOSUCHTICKER")).rejects.toThrow(/not found/);
});

test("the TCS fixture is not mistaken for an empty page", async () => {
  stubFetch({ consolidated: html });
  const page = await fetchCompanyHtml("TCS");
  expect(page.url).toBe("https://www.screener.in/company/TCS/consolidated/");
});
