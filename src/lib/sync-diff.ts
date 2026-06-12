import { mergeJsonKeys } from "./json-merge.js";
import type { Category, Format } from "./manifest.js";
import { extractMarkerInner, mergeMarkers } from "./markers.js";

export type FileVerdict =
	| { action: "skip"; reason: string }
	| { action: "rewrite"; reason: string; newContent?: string }
	| { action: "rewrite-region"; reason: string; newContent: string }
	| { action: "abort"; reason: string };

export interface DiffInput {
	prev: string | null;
	upstream: string;
	current: string | null;
}
export interface EntryInfo {
	category: Category;
	format?: Format;
	owned_keys?: string[];
}

export function diffFile(info: EntryInfo, d: DiffInput): FileVerdict {
	if (info.category === "generated") return { action: "skip", reason: "generated" };
	if (d.current === null)
		return {
			action: "rewrite",
			// prev=null → the file was never tracked, so it's new in this version, not deleted.
			// prev set → a previously-synced managed file is gone from disk; genuine restore.
			reason: d.prev === null ? "new in this version — creating" : "missing on disk — recreating",
		};
	if (info.category === "seeded")
		return { action: "skip", reason: "set up once at adopt; never overwritten" };

	if (info.category === "managed") {
		if (d.upstream === d.current) return { action: "skip", reason: "in sync" };
		if (d.prev !== null && d.prev !== d.current)
			return {
				action: "rewrite",
				reason: "overwritten (had local edits — original in git history)",
			};
		return { action: "rewrite", reason: "upstream changed" };
	}

	if (info.category === "hybrid") {
		if (info.format === "json") {
			let merged: string;
			try {
				merged = mergeJsonKeys(d.upstream, d.current, info.owned_keys ?? ["hooks"]);
			} catch (e) {
				return { action: "abort", reason: `config merge failed: ${(e as Error).message}` };
			}
			if (merged === d.current) return { action: "skip", reason: "pack-owned keys unchanged" };
			return {
				action: "rewrite",
				reason: "pack-owned keys changed upstream",
				newContent: merged,
			};
		}
		if (!info.format) return { action: "abort", reason: "managed file has no format declared" };
		const fmt = info.format;
		let currentInner: string, upstreamInner: string, prevInner: string | null;
		try {
			currentInner = extractMarkerInner(d.current, fmt);
			upstreamInner = extractMarkerInner(d.upstream, fmt);
			prevInner = d.prev === null ? null : extractMarkerInner(d.prev, fmt);
		} catch (e) {
			return { action: "abort", reason: `managed-section parse failed: ${(e as Error).message}` };
		}
		if (upstreamInner === currentInner)
			return { action: "skip", reason: "pack-managed section unchanged" };
		if (prevInner !== null && prevInner !== currentInner)
			return {
				action: "abort",
				reason: "you edited inside the pack-managed section — won't overwrite",
			};
		return {
			action: "rewrite-region",
			reason: "pack-managed section changed upstream",
			newContent: mergeMarkers(d.current, upstreamInner, fmt),
		};
	}

	return { action: "abort", reason: `unknown category` };
}
