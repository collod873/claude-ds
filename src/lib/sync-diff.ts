import type { Category, Format } from "./manifest.js";
import { extractMarkerInner, mergeMarkers } from "./markers.js";
import { mergeJsonKeys } from "./json-merge.js";

export type FileVerdict =
  | { action: "skip"; reason: string }
  | { action: "rewrite"; reason: string; newContent?: string }
  | { action: "rewrite-region"; reason: string; newContent: string }
  | { action: "abort"; reason: string };

export interface DiffInput { prev: string | null; upstream: string; current: string | null; }
export interface EntryInfo { category: Category; format?: Format; owned_keys?: string[]; }

export function diffFile(info: EntryInfo, d: DiffInput): FileVerdict {
  if (info.category === "generated") return { action: "skip", reason: "generated" };
  if (d.current === null) return { action: "rewrite", reason: "missing on disk — recreating" };
  if (info.category === "seeded") return { action: "skip", reason: "seeded; never re-touched" };

  if (info.category === "managed") {
    if (d.upstream === d.current) return { action: "skip", reason: "in sync" };
    if (d.prev !== null && d.prev !== d.current) return { action: "rewrite", reason: "overwritten (had local edits — original in git history)" };
    return { action: "rewrite", reason: "upstream changed" };
  }

  if (info.category === "hybrid") {
    if (info.format === "json") {
      let merged: string;
      try {
        merged = mergeJsonKeys(d.upstream, d.current, info.owned_keys ?? ["hooks"]);
      } catch (e) {
        return { action: "abort", reason: `json merge failed: ${(e as Error).message}` };
      }
      if (merged === d.current) return { action: "skip", reason: "hybrid json in sync" };
      return { action: "rewrite", reason: "hybrid json owned keys changed upstream", newContent: merged };
    }
    if (!info.format) return { action: "abort", reason: "hybrid file has no format declared" };
    const fmt = info.format;
    let currentInner: string, upstreamInner: string, prevInner: string | null;
    try {
      currentInner = extractMarkerInner(d.current, fmt);
      upstreamInner = extractMarkerInner(d.upstream, fmt);
      prevInner = d.prev === null ? null : extractMarkerInner(d.prev, fmt);
    } catch (e) {
      return { action: "abort", reason: `marker parse failed: ${(e as Error).message}` };
    }
    if (upstreamInner === currentInner) return { action: "skip", reason: "marker region in sync" };
    if (prevInner !== null && prevInner !== currentInner)
      return { action: "abort", reason: "user edited inside managed marker block" };
    return { action: "rewrite-region", reason: "marker region changed upstream", newContent: mergeMarkers(d.current, upstreamInner, fmt) };
  }

  return { action: "abort", reason: `unknown category` };
}
