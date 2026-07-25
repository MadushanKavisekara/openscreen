import { describe, expect, it } from "vitest";
import { buildTimeMap, computeClips, editToSource, sourceToEdit } from "./timeMap";
import type { TrimRegion } from "./types";

function trim(startMs: number, endMs: number): TrimRegion {
	return { id: `t-${startMs}-${endMs}`, startMs, endMs };
}

describe("buildTimeMap", () => {
	it("maps 1:1 with no trims", () => {
		const map = buildTimeMap(10_000);
		expect(map.editDurationMs).toBe(10_000);
		expect(map.segments).toEqual([
			{ srcStartMs: 0, srcEndMs: 10_000, editStartMs: 0, editEndMs: 10_000 },
		]);
	});

	it("removes a middle cut and closes the gap on the edit timeline", () => {
		const map = buildTimeMap(10_000, [trim(2000, 4000)]);
		expect(map.editDurationMs).toBe(8000);
		expect(map.segments).toEqual([
			{ srcStartMs: 0, srcEndMs: 2000, editStartMs: 0, editEndMs: 2000 },
			{ srcStartMs: 4000, srcEndMs: 10_000, editStartMs: 2000, editEndMs: 8000 },
		]);
	});

	it("drops a leading cut", () => {
		const map = buildTimeMap(10_000, [trim(0, 3000)]);
		expect(map.editDurationMs).toBe(7000);
		expect(map.segments).toEqual([
			{ srcStartMs: 3000, srcEndMs: 10_000, editStartMs: 0, editEndMs: 7000 },
		]);
	});

	it("drops a trailing cut that reaches the end", () => {
		const map = buildTimeMap(10_000, [trim(8000, 10_000)]);
		expect(map.editDurationMs).toBe(8000);
		expect(map.segments).toEqual([
			{ srcStartMs: 0, srcEndMs: 8000, editStartMs: 0, editEndMs: 8000 },
		]);
	});

	it("collapses overlapping cuts into their union", () => {
		const map = buildTimeMap(10_000, [trim(2000, 5000), trim(4000, 7000)]);
		expect(map.editDurationMs).toBe(5000);
		expect(map.segments).toEqual([
			{ srcStartMs: 0, srcEndMs: 2000, editStartMs: 0, editEndMs: 2000 },
			{ srcStartMs: 7000, srcEndMs: 10_000, editStartMs: 2000, editEndMs: 5000 },
		]);
	});

	it("does not resurrect source for a nested cut", () => {
		const map = buildTimeMap(10_000, [trim(2000, 8000), trim(4000, 5000)]);
		expect(map.segments).toEqual([
			{ srcStartMs: 0, srcEndMs: 2000, editStartMs: 0, editEndMs: 2000 },
			{ srcStartMs: 8000, srcEndMs: 10_000, editStartMs: 2000, editEndMs: 4000 },
		]);
	});

	it("sorts unordered cuts and clamps out-of-range bounds", () => {
		const map = buildTimeMap(10_000, [trim(6000, 12_000), trim(-500, 1000)]);
		expect(map.segments).toEqual([
			{ srcStartMs: 1000, srcEndMs: 6000, editStartMs: 0, editEndMs: 5000 },
		]);
		expect(map.editDurationMs).toBe(5000);
	});

	it("yields an empty timeline when everything is cut", () => {
		const map = buildTimeMap(10_000, [trim(0, 10_000)]);
		expect(map.segments).toEqual([]);
		expect(map.editDurationMs).toBe(0);
	});
});

describe("editToSource / sourceToEdit round trips", () => {
	const map = buildTimeMap(10_000, [trim(2000, 4000)]);

	it("maps edit positions before the cut straight through", () => {
		expect(editToSource(map, 1000)).toBe(1000);
		expect(sourceToEdit(map, 1000)).toBe(1000);
	});

	it("maps edit positions after the cut with the gap removed", () => {
		// Edit 3000 sits in the second kept segment (source 4000-10000).
		expect(editToSource(map, 3000)).toBe(5000);
		expect(sourceToEdit(map, 5000)).toBe(3000);
	});

	it("collapses a source position inside the cut to the seam", () => {
		// Anything in source [2000,4000) is gone; it maps to the seam at edit 2000.
		expect(sourceToEdit(map, 2500)).toBe(2000);
		expect(sourceToEdit(map, 4000)).toBe(2000);
	});

	it("clamps out-of-range inputs", () => {
		expect(editToSource(map, -100)).toBe(0);
		expect(editToSource(map, 999_999)).toBe(10_000);
		expect(sourceToEdit(map, 999_999)).toBe(8000);
	});

	it("returns 0 for an empty timeline", () => {
		const empty = buildTimeMap(5000, [trim(0, 5000)]);
		expect(editToSource(empty, 100)).toBe(0);
		expect(sourceToEdit(empty, 100)).toBe(0);
	});
});

describe("computeClips", () => {
	it("is a single clip with no cuts or splits", () => {
		const map = buildTimeMap(10_000);
		const clips = computeClips(map, []);
		expect(clips).toHaveLength(1);
		expect(clips[0]).toMatchObject({ srcStartMs: 0, srcEndMs: 10_000, editStartMs: 0 });
	});

	it("splits a kept segment into two clips at an interior split point", () => {
		const map = buildTimeMap(10_000);
		const clips = computeClips(map, [4000]);
		expect(clips.map((c) => [c.srcStartMs, c.srcEndMs])).toEqual([
			[0, 4000],
			[4000, 10_000],
		]);
		expect(clips.map((c) => [c.editStartMs, c.editEndMs])).toEqual([
			[0, 4000],
			[4000, 10_000],
		]);
	});

	it("subdivides each kept segment independently across a cut", () => {
		const map = buildTimeMap(10_000, [trim(3000, 5000)]);
		// Split at 1000 (before cut) and 7000 (after cut).
		const clips = computeClips(map, [1000, 7000]);
		expect(clips.map((c) => [c.srcStartMs, c.srcEndMs])).toEqual([
			[0, 1000],
			[1000, 3000],
			[5000, 7000],
			[7000, 10_000],
		]);
		// Edit timeline is contiguous and rippled closed.
		expect(clips.map((c) => [c.editStartMs, c.editEndMs])).toEqual([
			[0, 1000],
			[1000, 3000],
			[3000, 5000],
			[5000, 8000],
		]);
	});

	it("ignores split points inside a removed span or on a boundary", () => {
		const map = buildTimeMap(10_000, [trim(3000, 5000)]);
		const clips = computeClips(map, [4000, 3000, 5000]);
		expect(clips.map((c) => [c.srcStartMs, c.srcEndMs])).toEqual([
			[0, 3000],
			[5000, 10_000],
		]);
	});
});
