import type { TrimRegion } from "@/components/video-editor/types";

/**
 * A span of source footage that survives trimming, positioned on both the
 * original ("source") timeline and the shortened, rippled ("edit") timeline.
 *
 * The edit timeline is simply the kept spans concatenated in order, so
 * `editEndMs - editStartMs === srcEndMs - srcStartMs` for every segment and
 * each segment's `editStartMs` equals the previous segment's `editEndMs`.
 */
export interface KeepSegment {
	srcStartMs: number;
	srcEndMs: number;
	editStartMs: number;
	editEndMs: number;
}

/**
 * Bidirectional mapping between edit time (what the timeline/scrubber show)
 * and source time (what the `<video>` element actually plays), derived purely
 * from the removed trim regions. A recording with no trims maps 1:1.
 *
 * This is the ripple layer: the rest of the editor keeps storing everything in
 * source time, and this map is the single place that translates to/from the
 * shortened timeline the user sees.
 *
 * The keep-segment derivation mirrors `computeKeepSegments` in
 * `lib/exporter/timelineSegments.ts` (which the exporter and audio renderer
 * use) so the on-screen timeline and the exported file stay in lockstep — the
 * only difference is this one works in milliseconds and carries edit offsets.
 */
export interface TimeMap {
	totalSourceMs: number;
	editDurationMs: number;
	segments: KeepSegment[];
}

/** A selectable region of the edit timeline, bounded by cuts and split points. */
export interface Clip {
	id: string;
	srcStartMs: number;
	srcEndMs: number;
	editStartMs: number;
	editEndMs: number;
}

export function buildTimeMap(totalSourceMs: number, trimRegions?: TrimRegion[]): TimeMap {
	const total = Math.max(0, totalSourceMs);
	const segments: KeepSegment[] = [];

	const sorted = (trimRegions ?? [])
		.map((t) => ({
			startMs: Math.max(0, Math.min(t.startMs, total)),
			endMs: Math.max(0, Math.min(t.endMs, total)),
		}))
		.filter((t) => t.endMs > t.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	let srcCursor = 0;
	let editCursor = 0;
	const pushKept = (srcStart: number, srcEnd: number) => {
		if (srcEnd <= srcStart) return;
		const duration = srcEnd - srcStart;
		segments.push({
			srcStartMs: srcStart,
			srcEndMs: srcEnd,
			editStartMs: editCursor,
			editEndMs: editCursor + duration,
		});
		editCursor += duration;
	};

	for (const trim of sorted) {
		if (srcCursor < trim.startMs) {
			pushKept(srcCursor, trim.startMs);
		}
		// Keep the cursor monotonic so a nested/overlapping trim can't drag it
		// backward and resurrect source an earlier trim already removed.
		srcCursor = Math.max(srcCursor, trim.endMs);
	}
	if (srcCursor < total) {
		pushKept(srcCursor, total);
	}

	return { totalSourceMs: total, editDurationMs: editCursor, segments };
}

/**
 * Convert an edit-timeline position to the source position that should be fed
 * to the video element. Clamped to the edit duration.
 */
export function editToSource(map: TimeMap, editMs: number): number {
	if (map.segments.length === 0) return 0;
	const clamped = Math.max(0, Math.min(editMs, map.editDurationMs));
	for (const seg of map.segments) {
		if (clamped <= seg.editEndMs) {
			return seg.srcStartMs + (clamped - seg.editStartMs);
		}
	}
	const last = map.segments[map.segments.length - 1];
	return last.srcEndMs;
}

/**
 * Convert a source position to its edit-timeline position. A source position
 * that lands inside a removed span collapses to the seam between the
 * surrounding kept segments (the point the ripple joined them at).
 */
export function sourceToEdit(map: TimeMap, sourceMs: number): number {
	if (map.segments.length === 0) return 0;
	const clamped = Math.max(0, Math.min(sourceMs, map.totalSourceMs));
	for (const seg of map.segments) {
		if (clamped < seg.srcStartMs) {
			// In a removed gap before this segment: snap to the seam (its start).
			return seg.editStartMs;
		}
		if (clamped <= seg.srcEndMs) {
			return seg.editStartMs + (clamped - seg.srcStartMs);
		}
	}
	return map.editDurationMs;
}

/**
 * Re-express a list of source-time regions on the edit timeline so the
 * coordinate-agnostic timeline renders them rippled. Endpoints inside a removed
 * span collapse to its seam (see {@link sourceToEdit}).
 */
export function toEditSpanRegions<T extends { startMs: number; endMs: number }>(
	regions: readonly T[],
	map: TimeMap,
): T[] {
	return regions.map((r) => ({
		...r,
		startMs: sourceToEdit(map, r.startMs),
		endMs: sourceToEdit(map, r.endMs),
	}));
}

/**
 * Subdivide the kept timeline into selectable clips at each split point.
 * Split points are stored in source time; those landing inside a removed span
 * (or exactly on a clip boundary) are inert and produce no extra clip.
 */
export function computeClips(map: TimeMap, splitPoints?: number[]): Clip[] {
	const clips: Clip[] = [];
	for (let s = 0; s < map.segments.length; s++) {
		const seg = map.segments[s];
		const interior = (splitPoints ?? [])
			.filter((p) => p > seg.srcStartMs && p < seg.srcEndMs)
			.sort((a, b) => a - b);
		const boundaries = [seg.srcStartMs, ...interior, seg.srcEndMs];
		for (let i = 0; i < boundaries.length - 1; i++) {
			const srcStart = boundaries[i];
			const srcEnd = boundaries[i + 1];
			if (srcEnd <= srcStart) continue;
			clips.push({
				id: `clip-${s}-${i}`,
				srcStartMs: srcStart,
				srcEndMs: srcEnd,
				editStartMs: seg.editStartMs + (srcStart - seg.srcStartMs),
				editEndMs: seg.editStartMs + (srcEnd - seg.srcStartMs),
			});
		}
	}
	return clips;
}
