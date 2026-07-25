import { describe, expect, it } from "vitest";
import { type EditorState, INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import { clampRegionsForCut, computeClipDeletion, computeSplit } from "./clipEditing";
import type { TrimRegion } from "./types";

function region(startMs: number, endMs: number) {
	return { id: `r-${startMs}-${endMs}`, startMs, endMs };
}

function trim(startMs: number, endMs: number): TrimRegion {
	return { id: `t-${startMs}-${endMs}`, startMs, endMs };
}

function stateWith(overrides: Partial<EditorState>): EditorState {
	return { ...INITIAL_EDITOR_STATE, ...overrides };
}

describe("clampRegionsForCut", () => {
	const cutStart = 4000;
	const cutEnd = 6000;

	it("keeps a region entirely before the cut", () => {
		expect(clampRegionsForCut([region(1000, 3000)], cutStart, cutEnd)).toEqual([
			region(1000, 3000),
		]);
	});

	it("keeps a region entirely after the cut untouched (ripple handles the shift)", () => {
		expect(clampRegionsForCut([region(7000, 9000)], cutStart, cutEnd)).toEqual([
			region(7000, 9000),
		]);
	});

	it("drops a region fully inside the cut", () => {
		expect(clampRegionsForCut([region(4500, 5500)], cutStart, cutEnd)).toEqual([]);
	});

	it("drops a region whose bounds equal the cut", () => {
		expect(clampRegionsForCut([region(4000, 6000)], cutStart, cutEnd)).toEqual([]);
	});

	it("keeps a region that spans across the whole cut", () => {
		expect(clampRegionsForCut([region(2000, 8000)], cutStart, cutEnd)).toEqual([
			region(2000, 8000),
		]);
	});

	it("clamps a region straddling the start edge to end at the seam", () => {
		expect(clampRegionsForCut([region(3000, 5000)], cutStart, cutEnd)).toEqual([
			{ ...region(3000, 5000), endMs: 4000 },
		]);
	});

	it("clamps a region straddling the end edge to start at the seam", () => {
		expect(clampRegionsForCut([region(5000, 7000)], cutStart, cutEnd)).toEqual([
			{ ...region(5000, 7000), startMs: 6000 },
		]);
	});

	it("treats a region touching the edge as outside (no zero-length)", () => {
		expect(clampRegionsForCut([region(2000, 4000)], cutStart, cutEnd)).toEqual([
			region(2000, 4000),
		]);
		expect(clampRegionsForCut([region(6000, 8000)], cutStart, cutEnd)).toEqual([
			region(6000, 8000),
		]);
	});
});

describe("computeClipDeletion", () => {
	it("adds a trim for the removed span and applies the drop/clamp policy", () => {
		const prev = stateWith({
			zoomRegions: [
				{ ...region(1000, 3000) } as never, // before → kept
				{ ...region(4500, 5500) } as never, // inside → dropped
				{ ...region(3000, 5000) } as never, // straddles start → clamped
			],
			splitPoints: [2000, 4500, 7000],
		});
		const result = computeClipDeletion(prev, 4000, 6000, "trim-9");
		expect(result?.trimRegions).toEqual([{ id: "trim-9", startMs: 4000, endMs: 6000 }]);
		expect(result?.splitPoints).toEqual([2000, 7000]);
		expect(result?.zoomRegions?.map((r) => [r.startMs, r.endMs])).toEqual([
			[1000, 3000],
			[3000, 4000],
		]);
	});

	it("returns null for an empty or inverted span", () => {
		expect(computeClipDeletion(INITIAL_EDITOR_STATE, 5000, 5000, "t")).toBeNull();
		expect(computeClipDeletion(INITIAL_EDITOR_STATE, 6000, 5000, "t")).toBeNull();
	});

	it("preserves earlier trims so the map can merge adjacent cuts", () => {
		const prev = stateWith({ trimRegions: [trim(0, 2000)] });
		const result = computeClipDeletion(prev, 2000, 4000, "trim-2");
		expect(result?.trimRegions).toEqual([
			trim(0, 2000),
			{ id: "trim-2", startMs: 2000, endMs: 4000 },
		]);
	});
});

describe("computeSplit", () => {
	it("adds a sorted split point inside the kept timeline", () => {
		expect(computeSplit(INITIAL_EDITOR_STATE, 4000, 10_000)).toEqual([4000]);
		expect(computeSplit(stateWith({ splitPoints: [6000] }), 4000, 10_000)).toEqual([4000, 6000]);
	});

	it("rejects a split inside a removed span", () => {
		const prev = stateWith({ trimRegions: [trim(3000, 5000)] });
		expect(computeSplit(prev, 4000, 10_000)).toBeNull();
	});

	it("rejects a split on a boundary or at the timeline edges", () => {
		expect(computeSplit(INITIAL_EDITOR_STATE, 0, 10_000)).toBeNull();
		expect(computeSplit(INITIAL_EDITOR_STATE, 10_000, 10_000)).toBeNull();
	});

	it("rejects a duplicate split point", () => {
		expect(computeSplit(stateWith({ splitPoints: [4000] }), 4000, 10_000)).toBeNull();
	});
});
