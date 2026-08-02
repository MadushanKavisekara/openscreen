import type { ZoomDepth, ZoomFocus, ZoomFocusMode } from "../types";
import { MAX_ZOOM_SCALE, ZOOM_DEPTH_SCALES } from "../types";
import { clamp01, smoothStep } from "../videoPlayback/mathUtils";

/**
 * Auto-zoom placement planner ("v2").
 *
 * The legacy generator in zoomSuggestionUtils.ts picks candidates greedily: segment the
 * cursor track into still runs, sort by duration, accept the strongest with a fixed spacing,
 * and stamp a fixed-length region on each. That is local peak-picking, and it produces the
 * two artefacts the legacy path is known for — chatter (two nearby bursts become two
 * zoom-in/zoom-out cycles) and arbitrary extents (every region is 5% of the recording).
 *
 * This planner instead:
 *
 *   1. turns raw samples into weighted *attention events* (clicks, drags, dwells, text focus),
 *   2. splats them into a continuous saliency curve with an asymmetric temporal kernel —
 *      attention rises *before* a click, because the camera has to arrive before the action,
 *   3. thresholds that curve with hysteresis to get spans whose extents come from the data,
 *   4. selects the final set with a dynamic program that is globally optimal under a
 *      coverage budget and a minimum-gap constraint, rather than greedily.
 *
 * It only decides *placement* — which regions exist, when they start and end, where they
 * focus, how deep they go, and whether they anchor or follow. How the camera animates
 * through a region is unchanged and still owned by the playback/render path.
 */

/** Superset of CursorTelemetryPoint and CursorRecordingSample — whatever the caller has. */
export interface AutoZoomSample {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: string | null;
	cursorType?: string | null;
	visible?: boolean;
}

export interface AutoZoomPlanRegion {
	startMs: number;
	endMs: number;
	focus: ZoomFocus;
	/** Continuous scale; callers put this in `customScale`. */
	scale: number;
	/** Nearest preset to `scale`, for `ZoomRegion.depth`. */
	depth: ZoomDepth;
	/** "manual" anchors the frame on `focus`; "auto" follows the cursor for the span. */
	focusMode: ZoomFocusMode;
	/** Why this region exists, e.g. "3 clicks". Debug/telemetry only. */
	reason: string;
	/** Captured saliency mass. Comparable across regions of the same plan. */
	score: number;
}

export interface AutoZoomPlanOptions {
	samples: AutoZoomSample[];
	totalMs: number;
	/** Spans already on the timeline. Never overlapped, and they consume coverage budget. */
	existingRegions?: { startMs: number; endMs: number }[];
	/** Source video height in px. Caps zoom so the framed crop still fills the output. */
	sourceHeight?: number;
	/** Assumed export height for the pixel budget. */
	targetOutputHeight?: number;
	/** 0..1. Higher places more, and deeper, zooms. 0.5 is the tuned default. */
	intensity?: number;
}

const BUCKET_MS = 100;

// Temporal kernel. Attention ramps up before the event (the frame must have settled by the
// time the click lands) and decays more slowly after (the user is reading the result).
const CLICK_PRE_ROLL_MS = 700;
const CLICK_POST_ROLL_MS = 1400;
const DWELL_PRE_ROLL_MS = 400;
const DWELL_POST_ROLL_MS = 700;

const CLICK_WEIGHT = 1;
const DRAG_WEIGHT = 0.85;
/**
 * Deliberately below ENTER_THRESHOLD: a dwell on its own must not be able to open a region.
 * Stopping the mouse is not the same as doing something, and because the selector maximises
 * captured mass, long idles would otherwise outscore real interactions and win the budget.
 * A dwell still reinforces a nearby click and — being above EXIT_THRESHOLD — holds a region
 * open while the user keeps working in one place.
 */
const DWELL_WEIGHT_MAX = 0.5;
/** Recordings with no clicks at all (older telemetry, keyboard-driven demos) let dwells lead. */
const DWELL_ONLY_BOOST = 1.7;
const TEXT_FOCUS_WEIGHT = 0.55;

// Dwell = the cursor staying within DWELL_RADIUS of its running centroid. Unlike the legacy
// per-sample delta test this catches slow drift, and unlike the legacy 2600ms cap a longer
// dwell is treated as stronger evidence rather than being discarded.
const DWELL_RADIUS = 0.045;
const DWELL_MIN_MS = 500;
const DWELL_SATURATE_MS = 3000;

// A cursor crossing the screen is in transit, not attending to anything. Suppress rather than
// chase it — this is what stops the camera lunging at a mouse sweep.
const TRANSIT_SPEED_UPS = 0.9;
const TRANSIT_MAX_PENALTY = 0.6;

const CLICK_DEDUPE_MS = 80;
const DRAG_MIN_DISTANCE = 0.03;
const TEXT_FOCUS_MIN_MS = 700;

// Hysteresis: cross ENTER to open a span, fall below EXIT to close it. The gap is what stops
// a span flickering shut on a momentary dip in the curve.
const ENTER_THRESHOLD = 0.55;
const EXIT_THRESHOLD = 0.25;

const LEAD_IN_MS = 900;
const TAIL_MS = 600;
const MIN_REGION_MS = 1400;
const MAX_REGION_MS = 6500;
const MERGE_GAP_MS = 900;
/**
 * Kept small on purpose. Playback already links regions less than CHAINED_ZOOM_PAN_GAP_MS
 * apart into one continuous pan, so back-to-back regions read as a single camera move rather
 * than a pop out and back in. A larger gap here buys nothing and costs real events: it would
 * drop a "save" click whose lead-in happens to overlap the previous region's tail.
 */
const MIN_GAP_MS = 300;
/** Never zoom into the opening moments — the viewer needs the wide establishing shot first. */
const OPENING_GUARD_MS = 600;
const END_GUARD_MS = 400;

const BASE_MAX_COVERAGE = 0.55;

// Depth. The framed viewport must contain the activity with a margin to spare.
const FRAME_MARGIN = 0.06;
const SPREAD_SAFETY = 1.35;
const MIN_AUTO_SCALE = 1.3;
const MAX_AUTO_SCALE = 2.6;
const DEFAULT_TARGET_OUTPUT_HEIGHT = 1080;
/** Allow mild upscaling before it reads as soft. */
const PIXEL_BUDGET_SLACK = 1.15;

// Anchor vs follow.
const ANCHOR_SPREAD_MAX = 0.1;
const ANCHOR_DRIFT_MAX = 0.12;

type EventKind = "click" | "drag" | "dwell" | "text";

interface AttentionEvent {
	timeMs: number;
	cx: number;
	cy: number;
	kind: EventKind;
	weight: number;
	preRollMs: number;
	postRollMs: number;
}

interface SaliencyCurve {
	bucketMs: number;
	/** Attention mass per bucket, transit-suppressed. */
	weight: Float64Array;
	/** Saliency-weighted centroid per bucket. */
	cx: Float64Array;
	cy: Float64Array;
	/** Weighted RMS radius of the contributing events around that centroid. */
	spread: Float64Array;
	/** Dominant event kind per bucket, used to pick anchor vs follow. */
	dragMass: Float64Array;
}

interface RawSpan {
	startMs: number;
	endMs: number;
}

interface Candidate {
	startMs: number;
	endMs: number;
	focus: ZoomFocus;
	spread: number;
	drift: number;
	dragRatio: number;
	score: number;
	clickCount: number;
	reason: string;
}

function distance(ax: number, ay: number, bx: number, by: number) {
	return Math.hypot(ax - bx, ay - by);
}

function isClickSample(sample: AutoZoomSample) {
	const type = sample.interactionType;
	return (
		type === "click" || type === "double-click" || type === "right-click" || type === "middle-click"
	);
}

/**
 * Sort, clamp and drop samples the planner must not reason about. Invisible samples (cursor
 * left the display) are removed outright rather than clamped to an edge, which would otherwise
 * manufacture a phantom dwell against the screen border.
 */
export function normalizeSamples(samples: AutoZoomSample[], totalMs: number): AutoZoomSample[] {
	return samples
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.visible !== false,
		)
		.map((sample) => ({
			...sample,
			timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
			cx: clamp01(sample.cx),
			cy: clamp01(sample.cy),
		}))
		.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Turn samples into weighted attention events.
 *
 * Clicks are the primary signal and were entirely unused by the legacy generator. A click
 * held and dragged becomes a single drag event (which later forces follow mode) rather than
 * a click plus a bogus dwell at the drop point.
 */
export function extractAttentionEvents(samples: AutoZoomSample[]): AttentionEvent[] {
	const events: AttentionEvent[] = [];
	if (samples.length === 0) return events;

	// --- clicks and drags -------------------------------------------------------------
	let lastClickTimeMs = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		if (!isClickSample(sample)) continue;
		if (sample.timeMs - lastClickTimeMs < CLICK_DEDUPE_MS) continue;
		lastClickTimeMs = sample.timeMs;

		// Walk forward to the matching mouseup to see whether this was a drag.
		let travelled = 0;
		let endIndex = index;
		for (let probe = index + 1; probe < samples.length; probe += 1) {
			const prev = samples[probe - 1];
			const curr = samples[probe];
			travelled += distance(prev.cx, prev.cy, curr.cx, curr.cy);
			endIndex = probe;
			if (curr.interactionType === "mouseup") break;
			// A press that never releases within a sensible window is treated as a plain click.
			if (curr.timeMs - sample.timeMs > MAX_REGION_MS) break;
		}

		const end = samples[endIndex];
		if (travelled >= DRAG_MIN_DISTANCE && end.timeMs > sample.timeMs) {
			events.push({
				timeMs: Math.round((sample.timeMs + end.timeMs) / 2),
				cx: (sample.cx + end.cx) / 2,
				cy: (sample.cy + end.cy) / 2,
				kind: "drag",
				weight: DRAG_WEIGHT,
				preRollMs: CLICK_PRE_ROLL_MS,
				postRollMs: CLICK_POST_ROLL_MS,
			});
		} else {
			events.push({
				timeMs: sample.timeMs,
				cx: sample.cx,
				cy: sample.cy,
				kind: "click",
				weight: CLICK_WEIGHT,
				preRollMs: CLICK_PRE_ROLL_MS,
				postRollMs: CLICK_POST_ROLL_MS,
			});
		}
	}

	// --- dwells -----------------------------------------------------------------------
	let runStart = 0;
	let sumX = samples[0].cx;
	let sumY = samples[0].cy;
	let count = 1;

	const flushDwell = (endIndexExclusive: number) => {
		if (endIndexExclusive - runStart < 2) return;
		const start = samples[runStart];
		const end = samples[endIndexExclusive - 1];
		const durationMs = end.timeMs - start.timeMs;
		if (durationMs < DWELL_MIN_MS) return;

		const cx = sumX / count;
		const cy = sumY / count;
		// Longer is stronger, saturating so a two-minute idle does not dominate the plan.
		const weight = DWELL_WEIGHT_MAX * clamp01(durationMs / DWELL_SATURATE_MS);
		events.push({
			timeMs: Math.round((start.timeMs + end.timeMs) / 2),
			cx,
			cy,
			kind: "dwell",
			weight,
			preRollMs: DWELL_PRE_ROLL_MS,
			// A long dwell should stay hot for its whole span, not just its midpoint.
			postRollMs: DWELL_POST_ROLL_MS + durationMs / 2,
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const sample = samples[index];
		const centroidX = sumX / count;
		const centroidY = sumY / count;
		if (distance(sample.cx, sample.cy, centroidX, centroidY) > DWELL_RADIUS) {
			flushDwell(index);
			runStart = index;
			sumX = sample.cx;
			sumY = sample.cy;
			count = 1;
			continue;
		}
		sumX += sample.cx;
		sumY += sample.cy;
		count += 1;
	}
	flushDwell(samples.length);

	// --- sustained text focus ---------------------------------------------------------
	let textStart: AutoZoomSample | null = null;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		const isText = sample.cursorType === "text";
		if (isText && !textStart) {
			textStart = sample;
			continue;
		}
		if (!isText && textStart) {
			const end = samples[index - 1];
			if (end.timeMs - textStart.timeMs >= TEXT_FOCUS_MIN_MS) {
				events.push({
					timeMs: Math.round((textStart.timeMs + end.timeMs) / 2),
					cx: (textStart.cx + end.cx) / 2,
					cy: (textStart.cy + end.cy) / 2,
					kind: "text",
					weight: TEXT_FOCUS_WEIGHT,
					preRollMs: DWELL_PRE_ROLL_MS,
					postRollMs: DWELL_POST_ROLL_MS + (end.timeMs - textStart.timeMs) / 2,
				});
			}
			textStart = null;
		}
	}

	// Without any click or drag to lead, dwells are the only evidence available — promote them
	// so a mouse-less demo (or a recording whose telemetry predates click capture) still gets a
	// plan instead of nothing.
	const hasInteraction = events.some((event) => event.kind === "click" || event.kind === "drag");
	if (!hasInteraction) {
		for (const event of events) {
			if (event.kind === "dwell") event.weight *= DWELL_ONLY_BOOST;
		}
	}

	return events.sort((a, b) => a.timeMs - b.timeMs);
}

/** Cursor speed per bucket in normalized units/second, used to suppress transit. */
function buildSpeedTrack(samples: AutoZoomSample[], bucketCount: number): Float64Array {
	const speed = new Float64Array(bucketCount);
	if (samples.length < 2) return speed;

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		const dtMs = curr.timeMs - prev.timeMs;
		if (dtMs <= 0) continue;
		const unitsPerSecond = (distance(prev.cx, prev.cy, curr.cx, curr.cy) / dtMs) * 1000;
		const from = Math.max(0, Math.floor(prev.timeMs / BUCKET_MS));
		const to = Math.min(bucketCount - 1, Math.floor(curr.timeMs / BUCKET_MS));
		for (let bucket = from; bucket <= to; bucket += 1) {
			speed[bucket] = Math.max(speed[bucket], unitsPerSecond);
		}
	}
	return speed;
}

/**
 * Splat events into a continuous saliency curve.
 *
 * The asymmetric kernel is the important part: `preRollMs` before the event ramps attention up
 * so the emitted span starts early enough for the zoom-in to have completed by the time the
 * click lands. The legacy generator centred its region on the trigger, so the camera was still
 * flying in during the action it was supposed to be showing.
 */
export function buildSaliencyCurve(
	events: AttentionEvent[],
	samples: AutoZoomSample[],
	totalMs: number,
): SaliencyCurve {
	const bucketCount = Math.max(1, Math.ceil(totalMs / BUCKET_MS));
	const weight = new Float64Array(bucketCount);
	const sumX = new Float64Array(bucketCount);
	const sumY = new Float64Array(bucketCount);
	const sumX2 = new Float64Array(bucketCount);
	const sumY2 = new Float64Array(bucketCount);
	const dragMass = new Float64Array(bucketCount);

	for (const event of events) {
		const from = Math.max(0, Math.floor((event.timeMs - event.preRollMs) / BUCKET_MS));
		const to = Math.min(bucketCount - 1, Math.ceil((event.timeMs + event.postRollMs) / BUCKET_MS));
		for (let bucket = from; bucket <= to; bucket += 1) {
			const dt = bucket * BUCKET_MS + BUCKET_MS / 2 - event.timeMs;
			let envelope: number;
			if (dt < 0) {
				envelope = smoothStep(clamp01(1 + dt / event.preRollMs));
			} else {
				envelope = smoothStep(clamp01(1 - dt / event.postRollMs));
			}
			if (envelope <= 0) continue;

			const contribution = event.weight * envelope;
			weight[bucket] += contribution;
			sumX[bucket] += contribution * event.cx;
			sumY[bucket] += contribution * event.cy;
			sumX2[bucket] += contribution * event.cx * event.cx;
			sumY2[bucket] += contribution * event.cy * event.cy;
			if (event.kind === "drag") dragMass[bucket] += contribution;
		}
	}

	const speed = buildSpeedTrack(samples, bucketCount);
	const cx = new Float64Array(bucketCount);
	const cy = new Float64Array(bucketCount);
	const spread = new Float64Array(bucketCount);

	for (let bucket = 0; bucket < bucketCount; bucket += 1) {
		const mass = weight[bucket];
		if (mass <= 0) {
			cx[bucket] = 0.5;
			cy[bucket] = 0.5;
			continue;
		}
		const meanX = sumX[bucket] / mass;
		const meanY = sumY[bucket] / mass;
		cx[bucket] = meanX;
		cy[bucket] = meanY;
		const varX = Math.max(0, sumX2[bucket] / mass - meanX * meanX);
		const varY = Math.max(0, sumY2[bucket] / mass - meanY * meanY);
		spread[bucket] = Math.sqrt(varX + varY);

		const excessSpeed = (speed[bucket] - TRANSIT_SPEED_UPS) / TRANSIT_SPEED_UPS;
		if (excessSpeed > 0) {
			weight[bucket] = mass * (1 - TRANSIT_MAX_PENALTY * clamp01(excessSpeed));
		}
	}

	return { bucketMs: BUCKET_MS, weight, cx, cy, spread, dragMass };
}

/** Threshold the curve with hysteresis, then merge spans separated by less than MERGE_GAP_MS. */
export function segmentSaliency(
	curve: SaliencyCurve,
	enterThreshold: number,
	exitThreshold: number,
): RawSpan[] {
	const spans: RawSpan[] = [];
	let openStart: number | null = null;

	for (let bucket = 0; bucket < curve.weight.length; bucket += 1) {
		const value = curve.weight[bucket];
		if (openStart === null) {
			if (value >= enterThreshold) openStart = bucket;
			continue;
		}
		if (value < exitThreshold) {
			spans.push({ startMs: openStart * curve.bucketMs, endMs: bucket * curve.bucketMs });
			openStart = null;
		}
	}
	if (openStart !== null) {
		spans.push({
			startMs: openStart * curve.bucketMs,
			endMs: curve.weight.length * curve.bucketMs,
		});
	}

	// Merging is what replaces the legacy "drop candidates closer than SUGGESTION_SPACING_MS".
	// Two bursts a beat apart should read as one sustained zoom, not two cycles.
	const merged: RawSpan[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.startMs - last.endMs <= MERGE_GAP_MS) {
			last.endMs = span.endMs;
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}

/**
 * Recursively cut spans that outrun the maximum region length, splitting at the quietest
 * bucket near the middle so the seam lands where attention dips.
 *
 * Truncating instead would silently discard the tail — a sustained work session ending in a
 * "save" click would keep the session and lose the click. The pieces are allowed to overlap
 * once lead-in and tail are added; the selector resolves that by picking a compatible subset.
 */
export function splitLongSpans(
	spans: RawSpan[],
	curve: SaliencyCurve,
	maxCoreMs: number,
): RawSpan[] {
	const out: RawSpan[] = [];

	const visit = (span: RawSpan, depth: number) => {
		const lengthMs = span.endMs - span.startMs;
		if (lengthMs <= maxCoreMs || depth > 4) {
			out.push(span);
			return;
		}

		const searchFrom = Math.floor((span.startMs + lengthMs * 0.25) / curve.bucketMs);
		const searchTo = Math.min(
			curve.weight.length - 1,
			Math.floor((span.startMs + lengthMs * 0.75) / curve.bucketMs),
		);
		let splitBucket = searchFrom;
		let lowest = Number.POSITIVE_INFINITY;
		for (let bucket = searchFrom; bucket <= searchTo; bucket += 1) {
			if (curve.weight[bucket] < lowest) {
				lowest = curve.weight[bucket];
				splitBucket = bucket;
			}
		}

		const splitMs = splitBucket * curve.bucketMs;
		if (splitMs <= span.startMs || splitMs >= span.endMs) {
			out.push(span);
			return;
		}
		visit({ startMs: span.startMs, endMs: splitMs }, depth + 1);
		visit({ startMs: splitMs, endMs: span.endMs }, depth + 1);
	};

	for (const span of spans) visit(span, 0);
	return out;
}

/** Grow a raw span into a shootable region and measure its framing statistics. */
function buildCandidate(
	span: RawSpan,
	curve: SaliencyCurve,
	events: AttentionEvent[],
	totalMs: number,
	maxRegionMs: number,
	tailScale: number,
): Candidate | null {
	const startMs = Math.max(OPENING_GUARD_MS, span.startMs - LEAD_IN_MS);
	let endMs = Math.min(totalMs - END_GUARD_MS, span.endMs + TAIL_MS * tailScale);
	if (endMs - startMs < MIN_REGION_MS) {
		endMs = Math.min(totalMs - END_GUARD_MS, startMs + MIN_REGION_MS);
	}
	// Trimmed against the coverage budget as well as the hard cap: a candidate longer than the
	// whole budget is unaffordable to the selector, and dropping it outright would leave a
	// short recording with no zooms at all.
	if (endMs - startMs > maxRegionMs) {
		endMs = startMs + maxRegionMs;
	}
	if (endMs - startMs < MIN_REGION_MS) return null;

	const fromBucket = Math.floor(startMs / curve.bucketMs);
	const toBucket = Math.min(curve.weight.length - 1, Math.floor(endMs / curve.bucketMs));

	let mass = 0;
	let sumX = 0;
	let sumY = 0;
	let sumSpread = 0;
	let dragMass = 0;
	for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
		const value = curve.weight[bucket];
		if (value <= 0) continue;
		mass += value;
		sumX += value * curve.cx[bucket];
		sumY += value * curve.cy[bucket];
		sumSpread += value * curve.spread[bucket];
		dragMass += curve.dragMass[bucket];
	}
	if (mass <= 0) return null;

	const focus: ZoomFocus = { cx: clamp01(sumX / mass), cy: clamp01(sumY / mass) };

	// Events actually inside the region decide the reason string and the spatial spread that
	// drives depth — the curve's per-bucket spread understates a cluster spanning the span.
	const inside = events.filter((event) => event.timeMs >= startMs && event.timeMs <= endMs);
	const clickCount = inside.filter((event) => event.kind === "click").length;
	const dragCount = inside.filter((event) => event.kind === "drag").length;
	const dwellCount = inside.filter((event) => event.kind === "dwell").length;
	const textCount = inside.filter((event) => event.kind === "text").length;

	let eventSpread = sumSpread / mass;
	if (inside.length > 0) {
		let radial = 0;
		let radialWeight = 0;
		for (const event of inside) {
			radial += event.weight * distance(event.cx, event.cy, focus.cx, focus.cy) ** 2;
			radialWeight += event.weight;
		}
		if (radialWeight > 0) {
			eventSpread = Math.max(eventSpread, Math.sqrt(radial / radialWeight));
		}
	}

	// Drift across the span: if attention travels, the frame has to follow rather than anchor.
	// Measured between the weighted centroids of the two halves, skipping empty buckets — the
	// span's outer edges are lead-in/tail and carry no weight to average.
	const midBucket = Math.floor((fromBucket + toBucket) / 2);
	const halfCentroid = (from: number, to: number): ZoomFocus | null => {
		let halfMass = 0;
		let halfX = 0;
		let halfY = 0;
		for (let bucket = from; bucket <= to; bucket += 1) {
			const value = curve.weight[bucket];
			if (value <= 0) continue;
			halfMass += value;
			halfX += value * curve.cx[bucket];
			halfY += value * curve.cy[bucket];
		}
		return halfMass > 0 ? { cx: halfX / halfMass, cy: halfY / halfMass } : null;
	};
	const head = halfCentroid(fromBucket, midBucket);
	const tail = halfCentroid(midBucket + 1, toBucket);
	const drift = head && tail ? distance(head.cx, head.cy, tail.cx, tail.cy) : 0;

	const reasonParts: string[] = [];
	if (clickCount > 0) reasonParts.push(`${clickCount} click${clickCount === 1 ? "" : "s"}`);
	if (dragCount > 0) reasonParts.push(`${dragCount} drag${dragCount === 1 ? "" : "s"}`);
	if (textCount > 0) reasonParts.push("text focus");
	if (reasonParts.length === 0 && dwellCount > 0) reasonParts.push("dwell");

	return {
		startMs: Math.round(startMs),
		endMs: Math.round(endMs),
		focus,
		spread: eventSpread,
		drift,
		dragRatio: mass > 0 ? dragMass / mass : 0,
		score: mass,
		clickCount,
		reason: reasonParts.join(" + ") || "activity",
	};
}

/**
 * Globally optimal selection: weighted interval scheduling with a coverage budget.
 *
 * `dp[i][u]` is the best achievable score using the first `i` candidates while spending `u`
 * quantized units of screen time. This is the piece that makes the plan feel edited: when the
 * budget binds, it drops whichever regions contribute least *overall*, instead of the legacy
 * greedy pass which committed to the longest dwell first and let everything else fall out.
 */
export function selectRegions(
	candidates: Candidate[],
	budgetMs: number,
	reserved: { startMs: number; endMs: number }[],
): Candidate[] {
	const usable = candidates
		.filter(
			(candidate) =>
				!reserved.some(
					(span) =>
						candidate.endMs + MIN_GAP_MS > span.startMs &&
						candidate.startMs - MIN_GAP_MS < span.endMs,
				),
		)
		.sort((a, b) => a.endMs - b.endMs);

	if (usable.length === 0 || budgetMs <= 0) return [];

	const unitMs = BUCKET_MS;
	const budgetUnits = Math.max(0, Math.floor(budgetMs / unitMs));
	const cost = usable.map((candidate) =>
		Math.max(1, Math.round((candidate.endMs - candidate.startMs) / unitMs)),
	);

	// p[i] = last candidate that can precede i while respecting MIN_GAP_MS.
	const p = usable.map((candidate) => {
		let lo = 0;
		let hi = usable.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (usable[mid].endMs + MIN_GAP_MS <= candidate.startMs) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return found;
	});

	const width = budgetUnits + 1;
	const dp = new Float64Array((usable.length + 1) * width);
	for (let index = 1; index <= usable.length; index += 1) {
		const candidate = usable[index - 1];
		const candidateCost = cost[index - 1];
		const prev = p[index - 1] + 1;
		for (let used = 0; used <= budgetUnits; used += 1) {
			const skip = dp[(index - 1) * width + used];
			let take = Number.NEGATIVE_INFINITY;
			if (used >= candidateCost) {
				take = dp[prev * width + (used - candidateCost)] + candidate.score;
			}
			dp[index * width + used] = Math.max(skip, take);
		}
	}

	const chosen: Candidate[] = [];
	let index = usable.length;
	let used = budgetUnits;
	while (index > 0) {
		const skip = dp[(index - 1) * width + used];
		if (dp[index * width + used] === skip) {
			index -= 1;
			continue;
		}
		const candidateCost = cost[index - 1];
		chosen.push(usable[index - 1]);
		used -= candidateCost;
		index = p[index - 1] + 1;
	}

	return chosen.reverse();
}

/**
 * Scale ceiling from the pixel budget. Zooming 2.2x on a 1280x800 capture exported at 1080p is
 * mush; the same zoom on a 4K capture is still native pixels. A single fixed default depth is
 * therefore always wrong on one end of the range.
 */
function resolveScaleCeiling(sourceHeight?: number, targetOutputHeight?: number): number {
	const target = targetOutputHeight ?? DEFAULT_TARGET_OUTPUT_HEIGHT;
	if (!sourceHeight || !Number.isFinite(sourceHeight) || sourceHeight <= 0 || target <= 0) {
		return MAX_AUTO_SCALE;
	}
	const budget = (sourceHeight / target) * PIXEL_BUDGET_SLACK;
	return Math.max(MIN_AUTO_SCALE, Math.min(MAX_AUTO_SCALE, budget));
}

function nearestDepth(scale: number): ZoomDepth {
	const depths = Object.keys(ZOOM_DEPTH_SCALES).map(Number) as ZoomDepth[];
	let best: ZoomDepth = depths[0];
	let bestDelta = Number.POSITIVE_INFINITY;
	for (const depth of depths) {
		const delta = Math.abs(ZOOM_DEPTH_SCALES[depth] - scale);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = depth;
		}
	}
	return best;
}

/** Fit the activity in frame: half-viewport at scale s is 0.5/s, which must cover the spread. */
function resolveScale(candidate: Candidate, ceiling: number, intensity: number): number {
	const required = candidate.spread * SPREAD_SAFETY + FRAME_MARGIN;
	const fitted = required > 0 ? 0.5 / required : ceiling;
	const biased = fitted * (0.85 + 0.3 * clamp01(intensity));
	const scale = Math.max(MIN_AUTO_SCALE, Math.min(ceiling, biased));
	return Math.min(MAX_ZOOM_SCALE, Math.round(scale * 100) / 100);
}

/**
 * A tight cluster of clicks that does not move should anchor — the frame holds still while the
 * user works, which is what reads as composed. Anything that travels (a drag, a wandering
 * cluster) has to follow. The legacy generator hardcoded follow for every region, so a single
 * idle mouse sweep mid-zoom dragged the whole frame with it.
 */
function resolveFocusMode(candidate: Candidate): ZoomFocusMode {
	if (candidate.dragRatio > 0.25) return "auto";
	if (candidate.spread <= ANCHOR_SPREAD_MAX && candidate.drift <= ANCHOR_DRIFT_MAX) {
		return "manual";
	}
	return "auto";
}

export function planAutoZooms(options: AutoZoomPlanOptions): AutoZoomPlanRegion[] {
	const {
		samples,
		totalMs,
		existingRegions = [],
		sourceHeight,
		targetOutputHeight,
		intensity = 0.5,
	} = options;

	if (!(totalMs > 0) || samples.length < 2) return [];

	const normalized = normalizeSamples(samples, totalMs);
	if (normalized.length < 2) return [];

	const events = extractAttentionEvents(normalized);
	if (events.length === 0) return [];

	const curve = buildSaliencyCurve(events, normalized, totalMs);

	// Intensity moves both thresholds together: lower thresholds open more and longer spans.
	const thresholdScale = 1.6 - 1.2 * clamp01(intensity);
	const rawSpans = segmentSaliency(
		curve,
		ENTER_THRESHOLD * thresholdScale,
		EXIT_THRESHOLD * thresholdScale,
	);
	if (rawSpans.length === 0) return [];

	const reservedMs = existingRegions.reduce(
		(sum, region) => sum + Math.max(0, region.endMs - region.startMs),
		0,
	);
	const coverage = BASE_MAX_COVERAGE * (0.6 + 0.8 * clamp01(intensity));
	const budgetMs = Math.max(0, totalMs * coverage - reservedMs);
	if (budgetMs < MIN_REGION_MS) return [];

	const maxRegionMs = Math.min(MAX_REGION_MS, Math.max(MIN_REGION_MS, budgetMs));
	const maxCoreMs = Math.max(MIN_REGION_MS, maxRegionMs - LEAD_IN_MS - TAIL_MS);
	// Each span offers a full-tail and a clipped-tail variant. When two spans sit close enough
	// that the full pair cannot both fit, the selector can shorten the earlier region's tail
	// instead of dropping the later region entirely. The lead-in is never traded away — it is
	// what guarantees the camera has settled before the action it exists to show.
	const candidates = splitLongSpans(rawSpans, curve, maxCoreMs)
		.flatMap((span) =>
			[1, 0.25].map((tailScale) =>
				buildCandidate(span, curve, events, totalMs, maxRegionMs, tailScale),
			),
		)
		.filter((candidate): candidate is Candidate => candidate !== null);
	if (candidates.length === 0) return [];

	const selected = selectRegions(candidates, budgetMs, existingRegions);
	const ceiling = resolveScaleCeiling(sourceHeight, targetOutputHeight);

	return selected.map((candidate) => {
		const scale = resolveScale(candidate, ceiling, intensity);
		return {
			startMs: candidate.startMs,
			endMs: candidate.endMs,
			focus: candidate.focus,
			scale,
			depth: nearestDepth(scale),
			focusMode: resolveFocusMode(candidate),
			reason: candidate.reason,
			score: candidate.score,
		};
	});
}
