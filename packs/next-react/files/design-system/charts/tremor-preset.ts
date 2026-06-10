/**
 * Tremor feed layer — the throwaway adapter that hands the token-bound ramp to
 * tremor through its color-input surface (the `colors` prop and a
 * category→color mapping). This file is intentionally thin: it imports nothing
 * from tremor and adds no color of its own, so it is the only thing a future
 * chart-lib swap discards. The ramp (`./ramp`) survives untouched.
 *
 * Usage in a consumer (no chart-specific color literals in app code):
 *
 *   import { chartColors, categoryColors } from "@ds/charts";
 *   <BarChart data={data} index="month" categories={cats} colors={chartColors} />
 */
import { type ChartStatus, categoricalRamp, seriesColor, statusColor } from "@/design-system/charts/ramp";

/**
 * Ordered color array for a chart's `colors` prop. Index i drives category i;
 * pass it straight through — `<BarChart … colors={chartColors} />`.
 */
export const chartColors: readonly string[] = categoricalRamp;

/** A `colors` array sized to `count` categories, wrapping the ramp as needed. */
export function chartColorsFor(count: number): string[] {
  return Array.from({ length: count }, (_, i) => seriesColor(i));
}

/** Map an ordered list of category names to ramp colors (category→color). */
export function categoryColors(categories: readonly string[]): Record<string, string> {
  return Object.fromEntries(categories.map((name, i) => [name, seriesColor(i)]));
}

/** Color for a semantically-encoded series in a status chart. */
export function statusChartColor(status: ChartStatus): string {
  return statusColor(status);
}

export type { ChartStatus };
