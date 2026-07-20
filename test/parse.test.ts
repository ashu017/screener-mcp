import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseFundamentals,
  parseFinancials,
  parsePeers,
  parseCompanyId,
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

test("peers returns graceful result when lazy-loaded", () => {
  const r = parsePeers(html);
  // Peer table is JS-lazy-loaded; expect the graceful note rather than a crash.
  expect(Array.isArray(r.peers)).toBe(true);
  if (r.peers.length === 0) expect(r.note).toBeTruthy();
});
