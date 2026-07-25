import type { EditorState } from "@/hooks/useEditorHistory";
import { buildTimeMap } from "./timeMap";
import type { TrimRegion } from "./types";

/**
 * Ripple-editing reducers: turning a "delete this clip" or "split here" gesture
 * into the source-time state changes that make the timeline shrink.
 *
 * Everything stays in source time. A deleted clip becomes a `TrimRegion`; the
 * time map (derived from trim regions) is what ripples the timeline closed, so
 * these helpers never need to shift downstream regions — they only clean up the
 * effects the cut lands on top of, per the drop-if-inside / clamp-if-straddling
 * policy.
 */

interface TimedRegion {
	startMs: number;
	endMs: number;
}

/**
 * Reconcile timed effect regions (zooms, camera-fullscreen, speed, annotations)
 * with a removed source span [cutStartMs, cutEndMs):
 *  - fully outside the cut, or spanning across it → kept unchanged
 *  - fully inside the cut → dropped (its footage is gone)
 *  - straddling one edge → clamped to end/start exactly at the cut seam
 */
export function clampRegionsForCut<T extends TimedRegion>(
	regions: readonly T[],
	cutStartMs: number,
	cutEndMs: number,
): T[] {
	const out: T[] = [];
	for (const r of regions) {
		// No overlap: the ripple shifts it, but its source span is untouched.
		if (r.endMs <= cutStartMs || r.startMs >= cutEndMs) {
			out.push(r);
			continue;
		}
		// Spans across the whole cut: it legitimately continues past the seam.
		if (r.startMs < cutStartMs && r.endMs > cutEndMs) {
			out.push(r);
			continue;
		}
		// Fully inside: the footage it decorates no longer exists.
		if (r.startMs >= cutStartMs && r.endMs <= cutEndMs) {
			continue;
		}
		// Left part survives → end at the seam.
		if (r.startMs < cutStartMs) {
			out.push({ ...r, endMs: cutStartMs });
			continue;
		}
		// Right part survives → start at the seam.
		out.push({ ...r, startMs: cutEndMs });
	}
	return out;
}

/**
 * Compute the state change for ripple-deleting the source span
 * [cutStartMs, cutEndMs). Returns the partial `EditorState` to push, or `null`
 * when the span is empty/invalid. Adjacent and overlapping cuts are merged by
 * the time map, so the new trim can be stored verbatim.
 */
export function computeClipDeletion(
	prev: EditorState,
	cutStartMs: number,
	cutEndMs: number,
	newTrimId: string,
): Partial<EditorState> | null {
	const start = Math.round(cutStartMs);
	const end = Math.round(cutEndMs);
	if (!(end > start)) return null;

	const newTrim: TrimRegion = { id: newTrimId, startMs: start, endMs: end };

	return {
		trimRegions: [...prev.trimRegions, newTrim],
		// Split points inside (or on the edges of) the removed span become inert.
		splitPoints: prev.splitPoints.filter((p) => p < start || p > end),
		zoomRegions: clampRegionsForCut(prev.zoomRegions, start, end),
		cameraFullscreenRegions: clampRegionsForCut(prev.cameraFullscreenRegions, start, end),
		speedRegions: clampRegionsForCut(prev.speedRegions, start, end),
		annotationRegions: clampRegionsForCut(prev.annotationRegions, start, end),
	};
}

/**
 * Compute the split-point list after splitting at `sourceMs`. Returns the new
 * list, or `null` when the position is not a valid cut point: outside the kept
 * timeline, inside a removed span, exactly on a seam/clip boundary, or already
 * a split point.
 */
export function computeSplit(
	prev: EditorState,
	sourceMs: number,
	totalSourceMs: number,
): number[] | null {
	const point = Math.round(sourceMs);
	const map = buildTimeMap(totalSourceMs, prev.trimRegions);
	const insideKept = map.segments.some((seg) => point > seg.srcStartMs && point < seg.srcEndMs);
	if (!insideKept) return null;
	if (prev.splitPoints.includes(point)) return null;
	return [...prev.splitPoints, point].sort((a, b) => a - b);
}
