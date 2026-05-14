import { extractMarkerInner, mergeMarkers } from "./markers.js";
import { mergeJsonKeys } from "./json-merge.js";
export function diffFile(info, d) {
    if (info.category === "generated")
        return { action: "skip", reason: "generated" };
    if (d.current === null)
        return { action: "rewrite", reason: "missing on disk — recreating" };
    if (info.category === "seeded")
        return { action: "skip", reason: "seeded; never re-touched" };
    if (info.category === "managed") {
        if (d.upstream === d.current)
            return { action: "skip", reason: "in sync" };
        if (d.prev !== null && d.prev !== d.current)
            return { action: "abort", reason: "managed file hand-edited; aborting this file" };
        return { action: "rewrite", reason: "upstream changed" };
    }
    if (info.category === "hybrid") {
        if (info.format === "json") {
            let merged;
            try {
                merged = mergeJsonKeys(d.upstream, d.current, ["hooks"]);
            }
            catch (e) {
                return { action: "abort", reason: `json merge failed: ${e.message}` };
            }
            if (merged === d.current)
                return { action: "skip", reason: "hybrid json in sync" };
            return { action: "rewrite", reason: "hybrid json hooks changed upstream", newContent: merged };
        }
        if (!info.format)
            return { action: "abort", reason: "hybrid file has no format declared" };
        const fmt = info.format;
        let currentInner, upstreamInner, prevInner;
        try {
            currentInner = extractMarkerInner(d.current, fmt);
            upstreamInner = extractMarkerInner(d.upstream, fmt);
            prevInner = d.prev === null ? null : extractMarkerInner(d.prev, fmt);
        }
        catch (e) {
            return { action: "abort", reason: `marker parse failed: ${e.message}` };
        }
        if (upstreamInner === currentInner)
            return { action: "skip", reason: "marker region in sync" };
        if (prevInner !== null && prevInner !== currentInner)
            return { action: "abort", reason: "user edited inside managed marker block" };
        return { action: "rewrite-region", reason: "marker region changed upstream", newContent: mergeMarkers(d.current, upstreamInner, fmt) };
    }
    return { action: "abort", reason: `unknown category` };
}
