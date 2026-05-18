import React from "react";
import type { Meta } from "@/design-system/types/meta";
import tokens from "@/design-system/tokens.json";

const MOTION_KEYS = ["duration", "easing", "motion", "transition", "animation", "timing"];

type TokenEntry = { name: string; value: string };

function extractMotion(obj: Record<string, unknown>, prefix = ""): TokenEntry[] {
  return Object.entries(obj).flatMap(([key, val]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return extractMotion(val as Record<string, unknown>, name);
    }
    if (MOTION_KEYS.some((k) => name.toLowerCase().includes(k))) {
      return [{ name, value: String(val) }];
    }
    return [];
  });
}

function MotionReference(): React.ReactElement {
  const tokensObj =
    tokens && typeof tokens === "object" && !Array.isArray(tokens)
      ? (tokens as Record<string, unknown>)
      : {};
  const entries = extractMotion(tokensObj);

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">Motion Tokens</h1>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">
          No motion tokens found in design-system/tokens.json. Add keys
          containing &quot;duration&quot;, &quot;easing&quot;, &quot;motion&quot;,
          &quot;transition&quot;, or &quot;animation&quot;.
        </p>
      ) : (
        <>
          <table className="w-full text-sm border-collapse mb-8">
            <thead>
              <tr className="text-left border-b">
                <th className="pb-2 pr-4">Token</th>
                <th className="pb-2">Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((t) => (
                <tr key={t.name} className="border-b">
                  <td className="py-1 pr-4 font-mono">{t.name}</td>
                  <td className="py-1 font-mono text-muted-foreground">{t.value}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section>
            <h2 className="text-lg font-semibold mb-4">Animation Demo</h2>
            <div className="flex gap-4 flex-wrap">
              {entries
                .filter((t) => t.name.toLowerCase().includes("duration"))
                .map((t) => (
                  <div
                    key={t.name}
                    className="border rounded p-4 text-center"
                    style={{ animationDuration: t.value }}
                  >
                    <div
                      className="w-8 h-8 bg-primary rounded animate-spin mx-auto mb-2"
                      style={{ animationDuration: t.value }}
                    />
                    <code className="text-xs">{t.name}</code>
                    <p className="text-xs text-muted-foreground">{t.value}</p>
                  </div>
                ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export const meta: Meta = {
  kind: "reference",
  title: "Motion Tokens",
  render: () => <MotionReference />,
};
