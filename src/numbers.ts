/**
 * Screener renders numbers for human eyes: "₹ 17,60,650 Cr.", "0.46 %", "23.6",
 * "—" for missing. Consumers want numbers. These helpers do that one conversion,
 * and are deliberately strict about returning null rather than NaN or 0, so a
 * missing metric never reads as a real zero.
 *
 * Note the grouping is Indian (lakh/crore: 17,60,650 = 1760650), not thousands —
 * but since we strip separators entirely rather than interpreting them, both
 * conventions parse correctly.
 */

/** A single scalar Screener value → number, or null when absent/unparseable. */
export function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s
    .replace(/&nbsp;/g, " ")
    .replace(/[₹%×,\s]/g, "")
    .replace(/Cr\.?/gi, "")
    .trim();
  if (cleaned === "" || cleaned === "—" || cleaned === "-" || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "₹ 1,612 / 1,250" → { high, low }. */
export function highLow(s: string | null | undefined): { high: number | null; low: number | null } {
  const parts = (s ?? "").split("/");
  return { high: num(parts[0]), low: num(parts[1]) };
}

/**
 * Compound annual growth rate as a percentage, from the oldest and newest values
 * of an n-year span. Returns null when either end is missing or non-positive —
 * a CAGR across a sign flip (loss → profit) is not a meaningful number, and
 * reporting one would be worse than reporting nothing.
 */
export function cagrPct(oldest: number | null, newest: number | null, years: number): number | null {
  if (oldest == null || newest == null || years <= 0) return null;
  if (oldest <= 0 || newest <= 0) return null;
  return round2((Math.pow(newest / oldest, 1 / years) - 1) * 100);
}

export function round2(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/** Ratio of two values as a plain number (not a percentage), null-safe. */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return round2(numerator / denominator);
}

/** Screener suffixes expandable row labels with "+" ("Sales&nbsp;+"). */
export function normalizeLabel(s: string): string {
  return s.replace(/&nbsp;/g, " ").replace(/\s*\+\s*$/, "").replace(/\s+/g, " ").trim();
}
