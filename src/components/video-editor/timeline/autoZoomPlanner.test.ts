import { describe, expect, it } from "vitest";
import {
	type AutoZoomSample,
	extractAttentionEvents,
	normalizeSamples,
	planAutoZooms,
} from "./autoZoomPlanner";

const SAMPLE_INTERVAL_MS = 33;

/** Cursor parked at a point for `durationMs`, starting at `startMs`. */
function still(startMs: number, durationMs: number, cx: number, cy: number): AutoZoomSample[] {
	const samples: AutoZoomSample[] = [];
	for (let t = 0; t <= durationMs; t += SAMPLE_INTERVAL_MS) {
		samples.push({ timeMs: startMs + t, cx, cy, interactionType: "move" });
	}
	return samples;
}

/** Cursor travelling in a straight line, i.e. transit rather than attention. */
function sweep(
	startMs: number,
	durationMs: number,
	from: { cx: number; cy: number },
	to: { cx: number; cy: number },
): AutoZoomSample[] {
	const samples: AutoZoomSample[] = [];
	for (let t = 0; t <= durationMs; t += SAMPLE_INTERVAL_MS) {
		const progress = durationMs > 0 ? t / durationMs : 1;
		samples.push({
			timeMs: startMs + t,
			cx: from.cx + (to.cx - from.cx) * progress,
			cy: from.cy + (to.cy - from.cy) * progress,
			interactionType: "move",
		});
	}
	return samples;
}

function clickAt(timeMs: number, cx: number, cy: number): AutoZoomSample[] {
	return [
		{ timeMs, cx, cy, interactionType: "click" },
		{ timeMs: timeMs + SAMPLE_INTERVAL_MS, cx, cy, interactionType: "mouseup" },
	];
}

function sorted(samples: AutoZoomSample[]): AutoZoomSample[] {
	return [...samples].sort((a, b) => a.timeMs - b.timeMs);
}

describe("normalizeSamples", () => {
	it("drops samples captured while the cursor was off-display", () => {
		const result = normalizeSamples(
			[
				{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true },
				{ timeMs: 100, cx: 0.9, cy: 0.9, visible: false },
				{ timeMs: 200, cx: 0.5, cy: 0.5 },
			],
			1000,
		);

		expect(result).toHaveLength(2);
		expect(result.map((sample) => sample.timeMs)).toEqual([0, 200]);
	});

	it("clamps positions and sorts by time", () => {
		const result = normalizeSamples(
			[
				{ timeMs: 500, cx: 1.4, cy: -0.2 },
				{ timeMs: 100, cx: 0.5, cy: 0.5 },
			],
			1000,
		);

		expect(result[0].timeMs).toBe(100);
		expect(result[1].cx).toBe(1);
		expect(result[1].cy).toBe(0);
	});
});

describe("extractAttentionEvents", () => {
	it("emits a click event — the signal the legacy generator ignored entirely", () => {
		const samples = normalizeSamples(
			sorted([...still(0, 2000, 0.4, 0.4), ...clickAt(1000, 0.4, 0.4)]),
			3000,
		);
		const events = extractAttentionEvents(samples);

		expect(events.some((event) => event.kind === "click")).toBe(true);
	});

	it("classifies a press-move-release as one drag rather than a click plus a dwell", () => {
		const samples = normalizeSamples(
			sorted([
				{ timeMs: 0, cx: 0.2, cy: 0.5, interactionType: "click" },
				...sweep(33, 600, { cx: 0.2, cy: 0.5 }, { cx: 0.7, cy: 0.5 }),
				{ timeMs: 700, cx: 0.7, cy: 0.5, interactionType: "mouseup" },
			]),
			2000,
		);
		const events = extractAttentionEvents(samples);

		expect(events.some((event) => event.kind === "drag")).toBe(true);
		expect(events.some((event) => event.kind === "click")).toBe(false);
	});

	it("keeps a long pause as a single strong dwell instead of discarding it", () => {
		// The legacy detector rejected any run longer than 2600ms, throwing away exactly the
		// moments that most deserve a zoom.
		const samples = normalizeSamples(still(0, 6000, 0.3, 0.6), 8000);
		const events = extractAttentionEvents(samples);
		const dwells = events.filter((event) => event.kind === "dwell");

		expect(dwells).toHaveLength(1);
		expect(dwells[0].weight).toBeGreaterThan(0.5);
	});

	it("breaks a dwell on slow drift, which per-sample delta thresholds miss", () => {
		// Drifts across the screen slowly enough that no two consecutive samples move far,
		// so the legacy per-sample test merged it into one oversized run.
		const samples = normalizeSamples(
			sweep(0, 8000, { cx: 0.1, cy: 0.5 }, { cx: 0.9, cy: 0.5 }),
			9000,
		);
		const events = extractAttentionEvents(samples);
		const dwells = events.filter((event) => event.kind === "dwell");

		expect(dwells.length).toBeGreaterThan(1);
	});
});

describe("planAutoZooms", () => {
	it("returns nothing for an empty or motionless recording", () => {
		expect(planAutoZooms({ samples: [], totalMs: 10_000 })).toEqual([]);
		expect(planAutoZooms({ samples: still(0, 500, 0.5, 0.5), totalMs: 0 })).toEqual([]);
	});

	it("places a region that has already zoomed in by the time the click lands", () => {
		const clickTimeMs = 5000;
		const samples = normalizeSamples(
			sorted([...still(0, 9000, 0.35, 0.45), ...clickAt(clickTimeMs, 0.35, 0.45)]),
			10_000,
		);

		const plan = planAutoZooms({ samples, totalMs: 10_000 });

		expect(plan.length).toBeGreaterThan(0);
		const region = plan.find((r) => r.startMs <= clickTimeMs && r.endMs >= clickTimeMs);
		expect(region).toBeDefined();
		// Lead-in: the region must open meaningfully before the click, not be centred on it.
		expect(clickTimeMs - (region?.startMs ?? 0)).toBeGreaterThan(700);
	});

	it("never opens a region inside the establishing shot", () => {
		const samples = normalizeSamples(
			sorted([...still(0, 6000, 0.5, 0.5), ...clickAt(200, 0.5, 0.5), ...clickAt(400, 0.5, 0.5)]),
			8000,
		);

		const plan = planAutoZooms({ samples, totalMs: 8000 });

		for (const region of plan) {
			expect(region.startMs).toBeGreaterThanOrEqual(600);
		}
	});

	it("merges two nearby click bursts into one region instead of two zoom cycles", () => {
		const samples = normalizeSamples(
			sorted([
				...still(0, 12_000, 0.4, 0.4),
				...clickAt(4000, 0.4, 0.4),
				...clickAt(4600, 0.41, 0.4),
				...clickAt(5300, 0.4, 0.41),
			]),
			13_000,
		);

		const plan = planAutoZooms({ samples, totalMs: 13_000 });
		const covering = plan.filter((region) => region.startMs < 6000 && region.endMs > 3500);

		expect(covering).toHaveLength(1);
	});

	it("keeps every region within the min/max length bounds and never overlaps", () => {
		const samples = normalizeSamples(
			sorted([
				...still(0, 30_000, 0.5, 0.5),
				...clickAt(3000, 0.3, 0.3),
				...clickAt(9000, 0.7, 0.3),
				...clickAt(15_000, 0.3, 0.7),
				...clickAt(21_000, 0.7, 0.7),
				...clickAt(27_000, 0.5, 0.5),
			]),
			31_000,
		);

		const plan = planAutoZooms({ samples, totalMs: 31_000 });
		expect(plan.length).toBeGreaterThan(0);

		for (const region of plan) {
			const durationMs = region.endMs - region.startMs;
			expect(durationMs).toBeGreaterThanOrEqual(1400);
			expect(durationMs).toBeLessThanOrEqual(6500);
		}
		for (let index = 1; index < plan.length; index += 1) {
			expect(plan[index].startMs).toBeGreaterThan(plan[index - 1].endMs);
		}
	});

	it("respects the coverage budget rather than zooming most of the recording", () => {
		const clicks: AutoZoomSample[] = [];
		for (let t = 2000; t < 28_000; t += 1000) {
			clicks.push(...clickAt(t, 0.5, 0.5));
		}
		const samples = normalizeSamples(sorted([...still(0, 30_000, 0.5, 0.5), ...clicks]), 30_000);

		const plan = planAutoZooms({ samples, totalMs: 30_000 });
		const covered = plan.reduce((sum, region) => sum + (region.endMs - region.startMs), 0);

		expect(covered).toBeLessThanOrEqual(30_000 * 0.55);
	});

	it("never overlaps a region the user already placed", () => {
		const samples = normalizeSamples(
			sorted([
				...still(0, 20_000, 0.4, 0.4),
				...clickAt(6000, 0.4, 0.4),
				...clickAt(14_000, 0.6, 0.6),
			]),
			20_000,
		);
		const existing = [{ startMs: 5000, endMs: 9000 }];

		const plan = planAutoZooms({ samples, totalMs: 20_000, existingRegions: existing });

		for (const region of plan) {
			expect(region.endMs <= existing[0].startMs || region.startMs >= existing[0].endMs).toBe(true);
		}
	});

	it("anchors a tight click cluster and follows a drag", () => {
		const anchored = planAutoZooms({
			samples: normalizeSamples(
				sorted([
					...still(0, 10_000, 0.45, 0.45),
					...clickAt(4000, 0.45, 0.45),
					...clickAt(4800, 0.46, 0.45),
				]),
				10_000,
			),
			totalMs: 10_000,
		});
		expect(anchored.some((region) => region.focusMode === "manual")).toBe(true);

		const dragged = planAutoZooms({
			samples: normalizeSamples(
				sorted([
					...still(0, 3000, 0.2, 0.5),
					{ timeMs: 3000, cx: 0.2, cy: 0.5, interactionType: "click" },
					...sweep(3033, 1500, { cx: 0.2, cy: 0.5 }, { cx: 0.8, cy: 0.5 }),
					{ timeMs: 4600, cx: 0.8, cy: 0.5, interactionType: "mouseup" },
					...still(4700, 3000, 0.8, 0.5),
				]),
				9000,
			),
			totalMs: 9000,
		});
		expect(dragged.some((region) => region.focusMode === "auto")).toBe(true);
	});

	it("caps zoom depth by the pixel budget of the source", () => {
		const samples = normalizeSamples(
			sorted([...still(0, 10_000, 0.45, 0.45), ...clickAt(5000, 0.45, 0.45)]),
			10_000,
		);

		const smallSource = planAutoZooms({ samples, totalMs: 10_000, sourceHeight: 800 });
		const largeSource = planAutoZooms({ samples, totalMs: 10_000, sourceHeight: 2160 });

		expect(smallSource.length).toBeGreaterThan(0);
		expect(largeSource.length).toBeGreaterThan(0);
		// 800px source against a 1080p target can only afford a shallow zoom.
		for (const region of smallSource) {
			expect(region.scale).toBeLessThanOrEqual(1.31);
		}
		expect(Math.max(...largeSource.map((r) => r.scale))).toBeGreaterThan(
			Math.max(...smallSource.map((r) => r.scale)),
		);
	});

	it("suppresses a pure cursor sweep with no interaction", () => {
		const samples = normalizeSamples(
			sweep(0, 4000, { cx: 0.05, cy: 0.5 }, { cx: 0.95, cy: 0.5 }),
			6000,
		);

		const plan = planAutoZooms({ samples, totalMs: 6000 });

		expect(plan).toEqual([]);
	});

	it("places more regions as intensity rises", () => {
		const samples = normalizeSamples(
			sorted([
				...still(0, 40_000, 0.5, 0.5),
				...clickAt(4000, 0.2, 0.2),
				...clickAt(11_000, 0.8, 0.2),
				...clickAt(18_000, 0.2, 0.8),
				...clickAt(25_000, 0.8, 0.8),
				...clickAt(32_000, 0.5, 0.5),
			]),
			40_000,
		);

		const timid = planAutoZooms({ samples, totalMs: 40_000, intensity: 0 });
		const eager = planAutoZooms({ samples, totalMs: 40_000, intensity: 1 });

		expect(eager.length).toBeGreaterThanOrEqual(timid.length);
	});
});
