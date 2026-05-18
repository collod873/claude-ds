import React from "react";
import type { Meta } from "@/design-system/types/meta";
import tokens from "@/design-system/tokens.json";

type TokenEntry = { name: string; value: string };

function flattenTokens(obj: Record<string, unknown>, prefix = ""): TokenEntry[] {
  return Object.entries(obj).flatMap(([key, val]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return flattenTokens(val as Record<string, unknown>, name);
    }
    return [{ name, value: String(val) }];
  });
}

function TokensReference(): React.ReactElement {
  const entries = flattenTokens(tokens as unknown as Record<string, unknown>);
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">Design Tokens</h1>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left border-b">
            <th className="pb-2 pr-4">Token</th>
            <th className="pb-2 pr-4">Value</th>
            <th className="pb-2">Preview</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((t) => (
            <tr key={t.name} className="border-b">
              <td className="py-1 pr-4 font-mono">{t.name}</td>
              <td className="py-1 pr-4 font-mono text-muted-foreground">{t.value}</td>
              <td className="py-1">
                {t.name.toLowerCase().includes("color") ? (
                  <span
                    className="inline-block w-6 h-6 rounded border"
                    style={{ backgroundColor: t.value }}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export const meta: Meta = {
  kind: "reference",
  title: "Design Tokens",
  render: () => <TokensReference />,
};
