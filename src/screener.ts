import { parse, type HTMLElement } from "node-html-parser";

const BASE = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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

async function fetchHtml(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
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
    const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
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
  /** Screener lazy-loads the peer table via JS, so it is usually NOT present in
   * the server-rendered HTML. When empty, `sector`/`note` explain why and the
   * caller can fall back to get_financials / get_fundamentals of named peers. */
  sector: string | null;
  note?: string;
}

export function parsePeers(html: string): PeersResult {
  const root = parse(html);
  const sector =
    txt(root.querySelector("#peers .sub, section#peers p")) ||
    txt(root.querySelector("[href*='/company/compare/']")) ||
    null;

  const table = root.querySelector("#peers table, .peers table, section#peers table");
  if (!table) {
    return {
      peers: [],
      sector,
      note: "Peer table is lazy-loaded by Screener's JS and not in the server-rendered HTML. Use the company's sector to identify peers and call get_fundamentals on them.",
    };
  }

  const headers = table.querySelectorAll("thead th").map((th) => txt(th));
  const peers: Peer[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;
    const name = txt(cells[1]) || txt(cells[0]);
    const values: Record<string, string> = {};
    cells.forEach((td, i) => {
      const key = headers[i] || `col${i}`;
      values[key] = txt(td);
    });
    if (name && !/median/i.test(name)) peers.push({ name, values });
  }
  return { peers, sector };
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
