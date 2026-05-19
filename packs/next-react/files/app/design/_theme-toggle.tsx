"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

/**
 * Theme toggle for the design gallery.
 * Uses next-themes `useTheme` — the consumer must have next-themes installed
 * (claude-ds assumes next-themes is present since it is a peer requirement of
 * common UI toolkits like shadcn-ui and is widely adopted in Next.js projects).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render the icon after mount
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Same dimensions as the real button so layout does not shift
    return <div className="size-8" aria-hidden />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex size-8 items-center justify-center rounded-md text-sm hover:bg-muted transition-colors"
    >
      {isDark ? "☀︎" : "☾"}
    </button>
  );
}
