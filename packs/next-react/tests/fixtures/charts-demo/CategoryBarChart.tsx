/**
 * Representative tremor chart routed entirely through the DS chart preset.
 *
 * Note: this is a pack *test fixture*, not a shipped consumer file — shipping a
 * `@tremor/react` import into every consumer would break the ones that don't use
 * tremor (north star). It demonstrates the acceptance property: a real tremor
 * chart drives all of its color from the preset, with zero chart-specific color
 * values in the consuming code. Tremor's component API stays fully exposed —
 * this is not a wrapper.
 */
import { BarChart } from "@tremor/react";
import { categoryColors, chartColors } from "@ds/charts";

const data = [
  { month: "Jan", revenue: 2890, expenses: 2338 },
  { month: "Feb", revenue: 2756, expenses: 2103 },
  { month: "Mar", revenue: 3322, expenses: 2194 },
];

const categories = ["revenue", "expenses"];

export function CategoryBarChart() {
  // category→color mapping available when a per-series binding is needed; the
  // ordered `colors` prop covers the common case.
  void categoryColors(categories);
  return (
    <BarChart data={data} index="month" categories={categories} colors={chartColors} />
  );
}
