/**
 * Chart color ramp — the token-bound source of truth for data-viz color.
 *
 * Data-viz is where color carries meaning, so it must not bypass the token
 * surface. Every value here is derived from `design-system/tokens.json`
 * (`color.chart.*`); there are no parallel hex literals in this file, which is
 * why the TOK-001 hook leaves it alone. This module is deliberately
 * chart-library-agnostic — it knows nothing about tremor — so a future chart
 * lib swap throws away only the thin feed layer (`tremor-preset.ts`), never the
 * ramp.
 */
import tokens from "@/design-system/tokens.json";

const chart = tokens.color.chart;

/** Semantic status encodings — color where the meaning is fixed. */
export type ChartStatus = keyof typeof chart.status;

/**
 * Ordered categorical ramp for arbitrary series. Index 0 is the primary
 * series; the order is stable so series colors are reproducible across charts.
 */
export const categoricalRamp: readonly string[] = Object.keys(chart.categorical)
  .sort((a, b) => Number(a) - Number(b))
  .map((k) => (chart.categorical as Record<string, string>)[k]);

/** Semantic status encodings keyed by meaning (positive, negative, …). */
export const statusRamp: Readonly<Record<ChartStatus, string>> = chart.status;

/** Color for the nth series, wrapping the ramp for series counts past its end. */
export function seriesColor(index: number): string {
  const n = categoricalRamp.length;
  return categoricalRamp[((index % n) + n) % n];
}

/** Color for a semantically-encoded series (status charts). */
export function statusColor(status: ChartStatus): string {
  return statusRamp[status];
}
