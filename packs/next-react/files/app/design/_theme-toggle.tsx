"use client";

import { useEffect, useState } from "react";

/**
 * Prefers next-themes `useTheme` when available.
 * Falls back to toggling the `dark` class on <html> directly.
 */
export function ThemeToggle() {
  // Try to use next-themes dynamically so the file works in consumers without it
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  // next-themes hook — resolved at runtime
  let nextThemesTheme: string | undefined;
  let nextThemesSetTheme: ((t: string) => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nt = require("next-themes");
    // Only call hooks at the top level — but we're inside a component so this is safe.
    // However, conditional require is fine here because the hook call itself is
    // unconditional within the component render path (same hook call order every render).
    // If next-themes is absent the require will throw and we fall through to the DOM path.
    const { useTheme } = nt as { useTheme: () => { theme?: string; setTheme: (t: string) => void } };
    const { theme, setTheme } = useTheme();
    nextThemesTheme = theme;
    nextThemesSetTheme = setTheme;
  } catch {
    // next-themes not available — use DOM fallback below
  }

  useEffect(() => {
    setMounted(true);
    if (nextThemesTheme !== undefined) {
      setIsDark(nextThemesTheme === "dark");
    } else {
      setIsDark(document.documentElement.classList.contains("dark"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextThemesTheme]);

  if (!mounted) {
    // Avoid hydration mismatch — render a placeholder with same dimensions
    return <div className="size-8" aria-hidden />;
  }

  function toggle() {
    const next = isDark ? "light" : "dark";
    if (nextThemesSetTheme) {
      nextThemesSetTheme(next);
    } else {
      document.documentElement.classList.toggle("dark", next === "dark");
    }
    setIsDark(next === "dark");
  }

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex size-8 items-center justify-center rounded-md text-sm hover:bg-muted transition-colors"
    >
      {isDark ? "☀︎" : "☾"}
    </button>
  );
}
