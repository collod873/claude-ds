import React from "react";
import { notFound } from "next/navigation";

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

  return <>{children}</>;
}
