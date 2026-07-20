# screener-mcp — New Tools Design

**Date:** 2026-07-21
**Status:** Approved (design)

## Goal

Extend screener-mcp beyond single-stock deep-dive (its current 4 tools all require a
known symbol) to support three agent workflows the user prioritized: **discovery**,
**comparison**, and **news/filings** — all **anonymous** (no Screener login).

## Context

Current tools (`src/index.ts`, `src/screener.ts`): `get_fundamentals`, `get_financials`,
`get_peers`, `get_chart`. All keyed off an exact NSE/BSE `symbol`. Data comes from one
server-rendered company HTML GET (`fetchCompanyHtml`) plus a JSON chart API.

### Endpoint reconnaissance (verified 2026-07-21, anonymous)

| Capability | Anonymous | Endpoint |
|---|---|---|
| Company search | ✅ clean JSON | `GET /api/company/search/?q={q}` → `[{id,name,url}]` |
| Announcements | ✅ | in page + `GET /announcements/recent/{companyId}/` |
| Annual reports / Credit ratings / Concalls | ✅ | `#documents` section in company HTML |
| Custom screen query | ❌ 302 → `/register/` | login-gated — **out of scope** |
| Watchlists / saved screens | ❌ | require auth — **out of scope** |

## Scope

In scope: `search_company`, `get_documents`, `compare_stocks`, and a TTL cache refactor.
Out of scope: custom screening and anything requiring login (documented as a known
limitation in the README).

## Tools

### 1. `search_company`
- **Args:** `query: string` (company name or partial, e.g. "tata", "infosys").
- **Returns:** `{ query, results: { symbol, name, id }[] }`.
- **Impl:** `GET /api/company/search/?q={query}`. Parse each result's `url`
  (`/company/{SYMBOL}/...`) into `symbol`; pass `id` and `name` through.
- **Why:** keystone. Every "find/compare the X companies" request currently dead-ends
  because the agent must already know the exact symbol. This unblocks them.

### 2. `get_documents`
- **Args:** `symbol: string`.
- **Returns:**
  ```
  {
    symbol,
    announcements: { title, date, url }[],
    annualReports: { year, url, source }[],
    creditRatings: { title, date, url }[],
    concalls:      { title, date, url, kind }[]   // kind: transcript | ppt | notes | recording
  }
  ```
- **Impl:** parse the `#documents` section already present in `fetchCompanyHtml` output.
  Four sub-blocks under `h3` headers: "Announcements", "Annual reports", "Credit ratings",
  "Concalls". Extract title/label, date if present, and the external href (BSE/NSE/PDF).
  Links + metadata only — do NOT fetch or parse the linked PDFs/transcripts.
- **Note:** the fuller announcements list is lazy-loaded via
  `/announcements/recent/{companyId}/`; v1 uses what the main page already renders to
  avoid an extra request. May revisit if the inline list proves too short.

### 3. `compare_stocks`
- **Args:** `symbols: string[]` (2+), `metrics?: string[]` (optional filter of ratio names).
- **Returns:** `{ symbols, metrics, rows: { symbol, name, ratios: Record<string,string> }[], missing: string[] }`.
- **Impl:** fan out `fetchCompanyHtml` + reuse `parseFundamentals` per symbol (bounded
  concurrency, e.g. 4). Align on ratio `name`. If `metrics` given, filter to those
  (case-insensitive). Symbols that fail to resolve go in `missing`, don't fail the whole call.
- **Why:** `get_peers` only gives Screener's auto sector peers. This compares an
  arbitrary user-supplied list.

## Supporting refactor: TTL cache

- Wrap `fetchCompanyHtml` in a small in-memory TTL cache (key: uppercased symbol,
  default TTL 5 min, cap ~100 entries). `compare_stocks` over N symbols and repeated
  tool calls in one session then avoid re-hitting Screener — directly serves the README's
  "don't hammer the site" etiquette. Cache is process-local; no persistence.
- Keep it internal to `screener.ts`; no new dependency.

## Error handling

- Follow the existing pattern: tools catch and return `err(message)`; success returns
  `json(data)`.
- `search_company`: empty results → `{ query, results: [] }` (not an error).
- `get_documents`: missing subsections → empty arrays, never throw.
- `compare_stocks`: per-symbol failures collected in `missing[]`; only throw if *all* fail.

## Testing

- Extend `test/parse.test.ts` against the existing `test/tcs.fixture.html` fixture
  (deterministic, no network):
  - `parseDocuments(html)` → asserts the four subsections and link extraction.
  - `parseSearchResults(json)` → symbol extraction from `url`.
  - `compare` alignment logic given two parsed `Fundamentals` objects.
- Search/documents parsers must be pure functions on HTML/JSON so they're fixture-testable,
  mirroring the current `parseFundamentals` / `parsePeersFragment` split.

## README updates

- Add the three tools to the tools table.
- Add a "Known limitations" note: custom screening and watchlists require a Screener
  login and are intentionally not supported (anonymous-only server).
