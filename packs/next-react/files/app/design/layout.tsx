import type React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "./_theme-toggle";

/**
 * 3-tier gating for the /design route.
 *
 *   Tier 1 — hard 404 in production. No exceptions.
 *   Tier 2 — opt-in via DESIGN_GALLERY_ENABLED=1 (set in .env.local).
 *   Tier 3 — project-specific auth slot. Add your session/allowlist check below.
 */
export default async function DesignGalleryLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  if (process.env.DESIGN_GALLERY_ENABLED !== "1") notFound();

  // Tier 3: project auth goes here. See design-system/CLAUDE.md for the recommended pattern.

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/80 px-6 py-3 backdrop-blur">
        <Link href="/design" className="text-sm font-semibold tracking-tight">
          Design System
        </Link>
        <ThemeToggle />
      </header>
      {children}
    </>
  );
}
