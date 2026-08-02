import type { Range, Span } from "dnd-timeline";
import { useTimelineContext } from "dnd-timeline";
import {
	Captions,
	Check,
	ChevronDown,
	FlaskConical,
	Gauge,
	Maximize,
	MessageSquare,
	Plus,
	ScanEye,
	Scissors,
	Trash2,
	WandSparkles,
	ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { isTextEditingTarget, matchesShortcut } from "@/lib/shortcuts";
import type { AutoZoomEngine } from "@/lib/userPreferences";
import { cn } from "@/lib/utils";
import { ASPECT_RATIOS, type AspectRatio, getAspectRatioLabel } from "@/utils/aspectRatioUtils";
import { formatShortcut } from "@/utils/platformUtils";
import { BLUR_REGIONS_ENABLED } from "../featureFlags";
import { findFreeGapAt } from "../regionPlacement";
import type { Clip } from "../timeMap";
import type { AnnotationRegion, CameraFullscreenRegion, SpeedRegion, ZoomRegion } from "../types";
import Item from "./Item";
import glassStyles from "./ItemGlass.module.css";
import KeyframeMarkers from "./KeyframeMarkers";
import Row from "./Row";
import TimelineWrapper from "./TimelineWrapper";

/** End-cap colour for the recording clip — matches the default variant in Item.tsx. */
const CLIP_END_CAP_COLOR = "#FACC15";

const ZOOM_ROW_ID = "row-zoom";
const CAMERA_ROW_ID = "row-camera-fullscreen";
const ANNOTATION_ROW_ID = "row-annotation";
const BLUR_ROW_ID = "row-blur";
const SPEED_ROW_ID = "row-speed";
const FALLBACK_RANGE_MS = 1000;
const TARGET_MARKER_COUNT = 12;

interface TimelineEditorProps {
	videoDuration: number;
	hasVideoSource?: boolean;
	currentTime: number;
	/**
	 * Reads the live playhead position (ms) directly, bypassing `currentTime` React
	 * state. The playhead subscribes to this via its own rAF loop so it stays in sync
	 * with actual playback regardless of how long an ancestor's re-render takes.
	 */
	getPlaybackTimeMs?: () => number;
	onSeek?: (time: number) => void;
	zoomRegions: ZoomRegion[];
	onZoomAdded: (span: Span) => void;
	/** Magic-wand auto-zoom toggle state + handler. */
	autoZoomEnabled?: boolean;
	onToggleAutoZoom?: (enabled: boolean) => void;
	/** Which generator places automatic zooms; switching regenerates them immediately. */
	autoZoomEngine?: AutoZoomEngine;
	onAutoZoomEngineChange?: (engine: AutoZoomEngine) => void;
	/** Global Auto-Focus toggle state + handler. */
	autoFocusAll?: boolean;
	onToggleAutoFocusAll?: (on: boolean) => void;
	onZoomSpanChange: (id: string, span: Span) => void;
	onZoomDelete: (id: string) => void;
	selectedZoomId: string | null;
	onSelectZoom: (id: string | null) => void;
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	onCameraFullscreenAdded?: (span: Span) => void;
	onCameraFullscreenSpanChange?: (id: string, span: Span) => void;
	onCameraFullscreenDelete?: (id: string) => void;
	selectedCameraFullscreenId?: string | null;
	onSelectCameraFullscreen?: (id: string | null) => void;
	/** Selectable clips of the edit timeline (video split by cuts and split points). */
	clips?: Clip[];
	/** Split the clip under the playhead at the current position. */
	onSplit?: () => void;
	/** Ripple-delete a clip: remove it and close the gap. */
	onDeleteClip?: (clip: Clip) => void;
	/** Source start ms of the selected clip, or null. */
	selectedClipStartMs?: number | null;
	onSelectClip?: (clip: Clip | null) => void;
	annotationRegions?: AnnotationRegion[];
	onAnnotationAdded?: (span: Span) => void;
	onAnnotationSpanChange?: (id: string, span: Span) => void;
	onAnnotationDelete?: (id: string) => void;
	selectedAnnotationId?: string | null;
	onSelectAnnotation?: (id: string | null) => void;
	blurRegions?: AnnotationRegion[];
	onBlurAdded?: (span: Span) => void;
	onBlurSpanChange?: (id: string, span: Span) => void;
	onBlurDelete?: (id: string) => void;
	selectedBlurId?: string | null;
	onSelectBlur?: (id: string | null) => void;
	speedRegions?: SpeedRegion[];
	onSpeedAdded?: (span: Span) => void;
	onSpeedSpanChange?: (id: string, span: Span) => void;
	onSpeedDelete?: (id: string) => void;
	selectedSpeedId?: string | null;
	onSelectSpeed?: (id: string | null) => void;
	aspectRatio: AspectRatio;
	onAspectRatioChange: (aspectRatio: AspectRatio) => void;
	videoUrl?: string;
	/** Opens the auto-captions flow. When omitted, the captions button is hidden. */
	onGenerateCaptions?: () => void;
	isGeneratingCaptions?: boolean;
	/** Localized label for the auto-captions button (lives in the `editor` namespace). */
	captionsLabel?: string;
}

interface TimelineScaleConfig {
	minItemDurationMs: number;
	defaultItemDurationMs: number;
	minVisibleRangeMs: number;
}

interface TimelineRenderItem {
	id: string;
	rowId: string;
	span: Span;
	label: string;
	zoomDepth?: number;
	zoomCustomScale?: number;
	speedValue?: number;
	isAutoFocus?: boolean;
	variant: "zoom" | "camera-fullscreen" | "annotation" | "speed" | "blur";
}

const SCALE_CANDIDATES = [
	{ intervalSeconds: 0.05, gridSeconds: 0.01 },
	{ intervalSeconds: 0.1, gridSeconds: 0.02 },
	{ intervalSeconds: 0.25, gridSeconds: 0.05 },
	{ intervalSeconds: 0.5, gridSeconds: 0.1 },
	{ intervalSeconds: 1, gridSeconds: 0.25 },
	{ intervalSeconds: 2, gridSeconds: 0.5 },
	{ intervalSeconds: 5, gridSeconds: 1 },
	{ intervalSeconds: 10, gridSeconds: 2 },
	{ intervalSeconds: 15, gridSeconds: 3 },
	{ intervalSeconds: 30, gridSeconds: 5 },
	{ intervalSeconds: 60, gridSeconds: 10 },
	{ intervalSeconds: 120, gridSeconds: 20 },
	{ intervalSeconds: 300, gridSeconds: 30 },
	{ intervalSeconds: 600, gridSeconds: 60 },
	{ intervalSeconds: 900, gridSeconds: 120 },
	{ intervalSeconds: 1800, gridSeconds: 180 },
	{ intervalSeconds: 3600, gridSeconds: 300 },
];

/**
 * Picks the best axis interval for the currently visible time range, so marker
 * density stays meaningful regardless of video length.
 */
function calculateAxisScale(visibleRangeMs: number): { intervalMs: number; gridMs: number } {
	const visibleSeconds = visibleRangeMs / 1000;
	const candidate =
		SCALE_CANDIDATES.find((c) => {
			if (visibleSeconds <= 0) return true;
			return visibleSeconds / c.intervalSeconds <= TARGET_MARKER_COUNT;
		}) ?? SCALE_CANDIDATES[SCALE_CANDIDATES.length - 1];
	return {
		intervalMs: Math.round(candidate.intervalSeconds * 1000),
		gridMs: Math.round(candidate.gridSeconds * 1000),
	};
}

function calculateTimelineScale(durationSeconds: number): TimelineScaleConfig {
	const totalMs = Math.max(0, Math.round(durationSeconds * 1000));

	// 100ms, precise enough to cut but still grabbable.
	const minItemDurationMs = 100;

	// 5% of duration, clamped to 1-30s.
	const defaultItemDurationMs =
		totalMs > 0
			? Math.max(minItemDurationMs, Math.min(Math.round(totalMs * 0.05), 30000))
			: Math.max(minItemDurationMs, 1000);

	// 300ms, enough to view 0.1s items comfortably. Axis markers adapt via
	// calculateAxisScale, so there's no cap on zoom-in.
	const minVisibleRangeMs = 300;

	return {
		minItemDurationMs,
		defaultItemDurationMs,
		minVisibleRangeMs,
	};
}

function createInitialRange(totalMs: number): Range {
	if (totalMs > 0) {
		return { start: 0, end: totalMs };
	}

	return { start: 0, end: FALLBACK_RANGE_MS };
}

function clampVisibleRange(candidate: Range, totalMs: number): Range {
	if (totalMs <= 0) {
		return candidate;
	}

	const span = Math.max(candidate.end - candidate.start, 1);

	if (span >= totalMs) {
		return { start: 0, end: totalMs };
	}

	const start = Math.max(0, Math.min(candidate.start, totalMs - span));
	return { start, end: start + span };
}

function normalizeWheelDelta(delta: number, deltaMode: number, pageSizePx: number): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSizePx;
	}

	return delta;
}

function formatTimeLabel(milliseconds: number, intervalMs: number) {
	const totalSeconds = milliseconds / 1000;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const fractionalDigits = intervalMs < 250 ? 2 : intervalMs < 1000 ? 1 : 0;

	if (hours > 0) {
		const minutesString = minutes.toString().padStart(2, "0");
		const secondsString = Math.floor(seconds).toString().padStart(2, "0");
		return `${hours}:${minutesString}:${secondsString}`;
	}

	if (fractionalDigits > 0) {
		const secondsWithFraction = seconds.toFixed(fractionalDigits);
		const [wholeSeconds, fraction] = secondsWithFraction.split(".");
		return `${minutes}:${wholeSeconds.padStart(2, "0")}.${fraction}`;
	}

	return `${minutes}:${Math.floor(seconds).toString().padStart(2, "0")}`;
}

function formatPlayheadTime(ms: number): string {
	const s = ms / 1000;
	const min = Math.floor(s / 60);
	const sec = s % 60;
	if (min > 0) return `${min}:${sec.toFixed(1).padStart(4, "0")}`;
	return `${sec.toFixed(1)}s`;
}

function shouldStartTimelineScrub(target: EventTarget | null, timelineElement: HTMLElement) {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	for (let element: HTMLElement | null = target; element && element !== timelineElement; ) {
		const className = element.className;
		const classText = typeof className === "string" ? className : "";

		if (
			classText.split(/\s+/).includes("group") ||
			classText.includes("cursor-grab") ||
			classText.includes("cursor-grabbing") ||
			classText.includes("cursor-ew-resize") ||
			element.style.cursor === "col-resize"
		) {
			return false;
		}

		element = element.parentElement;
	}

	return true;
}

function PlaybackCursor({
	currentTimeMs,
	videoDurationMs,
	getPlaybackTimeMs,
	onSeek,
	onRangeChange,
	timelineRef,
	keyframes = [],
}: {
	currentTimeMs: number;
	videoDurationMs: number;
	getPlaybackTimeMs?: () => number;
	onSeek?: (time: number) => void;
	onRangeChange?: (updater: (previous: Range) => Range) => void;
	timelineRef: React.RefObject<HTMLDivElement>;
	keyframes?: { id: string; time: number }[];
}) {
	const { sidebarWidth, direction, range, valueToPixels, pixelsToValue } = useTimelineContext();
	const sideProperty = direction === "rtl" ? "right" : "left";
	const [isDragging, setIsDragging] = useState(false);
	const [dragPreviewTimeMs, setDragPreviewTimeMs] = useState<number | null>(null);

	// Drives the playhead position from the video element every animation frame,
	// isolated from the rest of the tree: this component's own `useState` call only
	// re-renders this small subtree, not TimelineEditor/VideoEditor above it. That
	// decoupling is what keeps the playhead glued to actual playback even while an
	// ancestor's (much heavier) re-render is in flight — see issue #111.
	const [liveTimeMs, setLiveTimeMs] = useState(currentTimeMs);
	const getPlaybackTimeMsRef = useRef(getPlaybackTimeMs);
	useEffect(() => {
		getPlaybackTimeMsRef.current = getPlaybackTimeMs;
	}, [getPlaybackTimeMs]);

	useEffect(() => {
		if (!getPlaybackTimeMsRef.current) {
			return;
		}

		let rafId: number;
		const tick = () => {
			const getter = getPlaybackTimeMsRef.current;
			if (getter) {
				const latest = getter();
				setLiveTimeMs((previous) => (previous === latest ? previous : latest));
			}
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(rafId);
	}, []);

	const resolvedTimeMs = getPlaybackTimeMs ? liveTimeMs : currentTimeMs;

	useEffect(() => {
		if (!isDragging) return;

		const handleMouseMove = (e: MouseEvent) => {
			if (!timelineRef.current || !onSeek) return;

			const rect = timelineRef.current.getBoundingClientRect();
			const clickX = e.clientX - rect.left - sidebarWidth;
			const contentWidth = Math.max(rect.width - sidebarWidth, 1);

			// Allow dragging past the edges, but clamp the value
			const relativeMs = pixelsToValue(clickX);
			let absoluteMs = Math.max(0, Math.min(range.start + relativeMs, videoDurationMs));

			// Snap to a keyframe within 150ms
			const snapThresholdMs = 150;
			const nearbyKeyframe = keyframes.find(
				(kf) =>
					Math.abs(kf.time - absoluteMs) <= snapThresholdMs &&
					kf.time >= range.start &&
					kf.time <= range.end,
			);

			if (nearbyKeyframe) {
				absoluteMs = nearbyKeyframe.time;
			}

			setDragPreviewTimeMs(absoluteMs);

			const visibleMs = range.end - range.start;
			if (onRangeChange && visibleMs > 0 && videoDurationMs > visibleMs) {
				const msPerPixel = visibleMs / contentWidth;
				const overflowLeftPx = Math.max(0, -clickX);
				const overflowRightPx = Math.max(0, clickX - contentWidth);

				if (overflowLeftPx > 0 && range.start > 0) {
					const shiftMs = overflowLeftPx * msPerPixel;
					onRangeChange((previous) => {
						const nextRange = clampVisibleRange(
							{
								start: previous.start - shiftMs,
								end: previous.end - shiftMs,
							},
							videoDurationMs,
						);
						return nextRange.start === previous.start && nextRange.end === previous.end
							? previous
							: nextRange;
					});
				} else if (overflowRightPx > 0 && range.end < videoDurationMs) {
					const shiftMs = overflowRightPx * msPerPixel;
					onRangeChange((previous) => {
						const nextRange = clampVisibleRange(
							{
								start: previous.start + shiftMs,
								end: previous.end + shiftMs,
							},
							videoDurationMs,
						);
						return nextRange.start === previous.start && nextRange.end === previous.end
							? previous
							: nextRange;
					});
				}
			}

			onSeek(absoluteMs / 1000);
		};

		const handleMouseUp = () => {
			setIsDragging(false);
			setDragPreviewTimeMs(null);
			document.body.style.cursor = "";
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		document.body.style.cursor = "ew-resize";

		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "";
		};
	}, [
		isDragging,
		onSeek,
		onRangeChange,
		timelineRef,
		sidebarWidth,
		range.start,
		range.end,
		videoDurationMs,
		pixelsToValue,
		keyframes,
	]);

	const displayTimeMs =
		isDragging && dragPreviewTimeMs !== null ? dragPreviewTimeMs : resolvedTimeMs;

	if (videoDurationMs <= 0 || displayTimeMs < 0) {
		return null;
	}

	const clampedTime = Math.min(displayTimeMs, videoDurationMs);

	if (clampedTime < range.start || clampedTime > range.end) {
		return null;
	}

	const offset = valueToPixels(clampedTime - range.start);

	return (
		<div
			className="absolute top-0 bottom-0 z-50 group/cursor"
			style={{
				[sideProperty === "right" ? "marginRight" : "marginLeft"]: `${sidebarWidth - 1}px`,
				pointerEvents: "none", // pass clicks through to the timeline; the handle re-enables them
			}}
		>
			<div
				className="absolute top-0 bottom-0 w-[2px] bg-[#6C55FF] shadow-[0_0_18px_rgba(108,85,255,0.68)] cursor-ew-resize pointer-events-auto hover:shadow-[0_0_24px_rgba(108,85,255,0.85)] transition-shadow"
				style={{
					[sideProperty]: `${offset}px`,
				}}
				onMouseDown={(e) => {
					e.stopPropagation(); // Prevent timeline click
					setDragPreviewTimeMs(resolvedTimeMs);
					setIsDragging(true);
				}}
			>
				<div
					className="absolute -top-2 left-1/2 -translate-x-1/2 hover:scale-110 transition-transform"
					style={{ width: "20px", height: "20px" }}
				>
					<div className="w-4 h-4 mx-auto mt-[2px] bg-[#6C55FF] rotate-45 rounded-[5px] shadow-lg shadow-[#6C55FF]/30 border border-white/30" />
				</div>
				{isDragging && (
					<div className="absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] text-white/90 font-medium tabular-nums whitespace-nowrap border border-white/10 shadow-lg pointer-events-none">
						{formatPlayheadTime(clampedTime)}
					</div>
				)}
			</div>
		</div>
	);
}

function TimelineAxis({
	videoDurationMs,
	currentTimeMs,
}: {
	videoDurationMs: number;
	currentTimeMs: number;
}) {
	const { sidebarWidth, direction, range, valueToPixels } = useTimelineContext();
	const sideProperty = direction === "rtl" ? "right" : "left";

	const { intervalMs } = useMemo(
		() => calculateAxisScale(range.end - range.start),
		[range.end, range.start],
	);

	const markers = useMemo(() => {
		if (intervalMs <= 0) {
			return { markers: [], minorTicks: [] };
		}

		const maxTime = videoDurationMs > 0 ? videoDurationMs : range.end;
		const visibleStart = Math.max(0, Math.min(range.start, maxTime));
		const visibleEnd = Math.min(range.end, maxTime);
		const markerTimes = new Set<number>();

		const firstMarker = Math.ceil(visibleStart / intervalMs) * intervalMs;

		for (let time = firstMarker; time <= maxTime; time += intervalMs) {
			if (time >= visibleStart && time <= visibleEnd) {
				markerTimes.add(Math.round(time));
			}
		}

		if (visibleStart <= maxTime) {
			markerTimes.add(Math.round(visibleStart));
		}

		if (videoDurationMs > 0) {
			markerTimes.add(Math.round(videoDurationMs));
		}

		const sorted = Array.from(markerTimes)
			.filter((time) => time <= maxTime)
			.sort((a, b) => a - b);

		// 4 minor ticks between major intervals
		const minorTicks = [];
		const minorInterval = intervalMs / 5;

		for (let time = firstMarker; time <= maxTime; time += minorInterval) {
			if (time >= visibleStart && time <= visibleEnd) {
				const isMajor = Math.abs(time % intervalMs) < 1;
				if (!isMajor) {
					minorTicks.push(time);
				}
			}
		}

		return {
			markers: sorted.map((time) => ({
				time,
				label: formatTimeLabel(time, intervalMs),
			})),
			minorTicks,
		};
	}, [intervalMs, range.end, range.start, videoDurationMs]);

	return (
		<div
			className="h-9 bg-[#0c0d10] border-b border-white/[0.07] relative overflow-hidden select-none"
			style={{
				[sideProperty === "right" ? "marginRight" : "marginLeft"]: `${sidebarWidth}px`,
			}}
		>
			{/* Minor Ticks */}
			{markers.minorTicks.map((time) => {
				const offset = valueToPixels(time - range.start);
				return (
					<div
						key={`minor-${time}`}
						className="absolute bottom-0 h-1.5 w-[1px] bg-white/[0.07]"
						style={{ [sideProperty]: `${offset}px` }}
					/>
				);
			})}

			{/* Major Markers */}
			{markers.markers.map((marker) => {
				const offset = valueToPixels(marker.time - range.start);
				const markerStyle: React.CSSProperties = {
					position: "absolute",
					bottom: 0,
					height: "100%",
					display: "flex",
					flexDirection: "row",
					alignItems: "flex-end",
					[sideProperty]: `${offset}px`,
				};

				return (
					<div key={marker.time} style={markerStyle}>
						<div className="flex flex-col items-center pb-1">
							<div className="h-2.5 w-[1px] bg-white/20 mb-1" />
							<span
								className={cn(
									"text-[10px] font-medium tabular-nums tracking-tight",
									marker.time === currentTimeMs ? "text-brand" : "text-slate-500",
								)}
							>
								{marker.label}
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}

/**
 * The clips track: the video split into selectable segments on the edit timeline.
 * Cuts and split points show as seams between clips; selecting a clip and hitting
 * delete (button or Backspace) ripple-removes it. Positioned in the content area
 * (offset by the sidebar) using the same pixel mapping as the rest of the timeline.
 */
function ClipsTrack({
	clips,
	selectedClipStartMs,
	onSelectClip,
	onDeleteClip,
	rangeStartMs,
	sidebarWidth,
	valueToPixels,
	deleteLabel,
}: {
	clips: Clip[];
	selectedClipStartMs: number | null;
	onSelectClip?: (clip: Clip | null) => void;
	onDeleteClip?: (clip: Clip) => void;
	rangeStartMs: number;
	sidebarWidth: number;
	valueToPixels: (value: number) => number;
	deleteLabel: string;
}) {
	// Stop pointer/click events from reaching the timeline's scrub + seek handlers, so
	// interacting with a clip selects it instead of moving the playhead. The playhead is
	// still driven from the axis/ruler above. A bare-area click deselects.
	const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
	return (
		<div
			className="relative border-b border-white/[0.055] bg-[#101116]"
			style={{ minHeight: 44 }}
			onPointerDown={stop}
			onClick={(e) => {
				stop(e);
				onSelectClip?.(null);
			}}
		>
			<div className="absolute inset-y-0" style={{ left: sidebarWidth, right: 0 }}>
				{clips.map((clip) => {
					const left = valueToPixels(clip.editStartMs - rangeStartMs);
					const width = valueToPixels(clip.editEndMs - clip.editStartMs);
					if (width <= 0) return null;
					const isSelected = clip.srcStartMs === selectedClipStartMs;
					return (
						<button
							type="button"
							key={clip.id}
							onPointerDown={stop}
							onClick={(e) => {
								e.stopPropagation();
								onSelectClip?.(isSelected ? null : clip);
							}}
							className="absolute top-1 bottom-1 group/clip cursor-pointer"
							style={{ left, width: Math.max(width, 2) }}
						>
							{/*
								The glass styling sits on an inner element rather than the button itself:
								`.glassYellow` sets `position: relative`, which would override the absolute
								positioning this wrapper needs to place the clip on the track. Same split
								Item.tsx uses for the effect items.
							*/}
							<div
								className={cn(
									glassStyles.glassYellow,
									"h-full w-full overflow-hidden",
									isSelected && glassStyles.selected,
								)}
								// The end caps already delineate both ends, so `.glassYellow`'s 1px border
								// only added a hard line at the clip's leading/trailing edge. Kept
								// transparent rather than removed so the box model (and the selected
								// state's ring) stays identical. Scoped here — the shared class is still
								// bordered for the annotation/blur items that use it.
								style={{ margin: 0, borderColor: "transparent" }}
							>
								{/*
									End caps matching the effect items (see Item.tsx). Decorative here —
									the clip row has no resize handles — so they keep the stylesheet's
									`pointer-events: none`. Back-to-back caps also mark the boundary
									between adjacent clips, which the old seam borders used to do.
								*/}
								<div
									className={cn(glassStyles.zoomEndCap, glassStyles.left)}
									style={{ width: 8, opacity: 0.9, background: CLIP_END_CAP_COLOR }}
								/>
								<div
									className={cn(glassStyles.zoomEndCap, glassStyles.right)}
									style={{ width: 8, opacity: 0.9, background: CLIP_END_CAP_COLOR }}
								/>
								<span className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,#ffffff08_6px,#ffffff08_12px)] pointer-events-none" />
								{isSelected && onDeleteClip && (
									<span
										role="button"
										tabIndex={-1}
										onPointerDown={stop}
										onClick={(e) => {
											e.stopPropagation();
											onDeleteClip(clip);
										}}
										className="absolute right-1 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-[#ef4444] hover:text-white"
										title={deleteLabel}
									>
										<Trash2 className="h-3 w-3" />
									</span>
								)}
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function Timeline({
	items,
	videoDurationMs,
	currentTimeMs,
	getPlaybackTimeMs,
	onSeek,
	onRangeChange,
	onSelectZoom,
	onSelectCameraFullscreen,
	onSelectAnnotation,
	onSelectBlur,
	onSelectSpeed,
	selectedZoomId,
	selectedCameraFullscreenId,
	selectedAnnotationId,
	selectedBlurId,
	selectedSpeedId,
	clips = [],
	selectedClipStartMs = null,
	onSelectClip,
	onDeleteClip,
	keyframes = [],
}: {
	items: TimelineRenderItem[];
	videoDurationMs: number;
	currentTimeMs: number;
	getPlaybackTimeMs?: () => number;
	onSeek?: (time: number) => void;
	onRangeChange?: (updater: (previous: Range) => Range) => void;
	onSelectZoom?: (id: string | null) => void;
	onSelectCameraFullscreen?: (id: string | null) => void;
	onSelectAnnotation?: (id: string | null) => void;
	onSelectBlur?: (id: string | null) => void;
	onSelectSpeed?: (id: string | null) => void;
	selectedZoomId: string | null;
	selectedCameraFullscreenId?: string | null;
	selectedAnnotationId?: string | null;
	selectedBlurId?: string | null;
	selectedSpeedId?: string | null;
	clips?: Clip[];
	selectedClipStartMs?: number | null;
	onSelectClip?: (clip: Clip | null) => void;
	onDeleteClip?: (clip: Clip) => void;
	keyframes?: { id: string; time: number }[];
}) {
	const t = useScopedT("timeline");
	const { setTimelineRef, style, sidebarWidth, range, pixelsToValue, valueToPixels } =
		useTimelineContext();
	const localTimelineRef = useRef<HTMLDivElement | null>(null);
	const isScrubbingTimelineRef = useRef(false);
	const scrubPointerIdRef = useRef<number | null>(null);

	const setRefs = useCallback(
		(node: HTMLDivElement | null) => {
			setTimelineRef(node);
			localTimelineRef.current = node;
		},
		[setTimelineRef],
	);

	const seekTimelineAtClientX = useCallback(
		(timelineElement: HTMLDivElement, clientX: number) => {
			if (!onSeek || videoDurationMs <= 0) return false;

			const rect = timelineElement.getBoundingClientRect();
			const clickX = clientX - rect.left - sidebarWidth;

			if (clickX < 0) return false;

			const relativeMs = pixelsToValue(clickX);
			const absoluteMs = Math.max(0, Math.min(range.start + relativeMs, videoDurationMs));

			onSeek(absoluteMs / 1000);
			return true;
		},
		[onSeek, videoDurationMs, sidebarWidth, pixelsToValue, range.start],
	);

	const clearTimelineSelection = useCallback(() => {
		onSelectZoom?.(null);
		onSelectCameraFullscreen?.(null);
		onSelectClip?.(null);
		onSelectAnnotation?.(null);
		onSelectBlur?.(null);
		onSelectSpeed?.(null);
	}, [
		onSelectZoom,
		onSelectCameraFullscreen,
		onSelectClip,
		onSelectAnnotation,
		onSelectBlur,
		onSelectSpeed,
	]);

	const handleTimelineClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			// Items stop propagation, so this only fires on empty space
			clearTimelineSelection();
			seekTimelineAtClientX(e.currentTarget, e.clientX);
		},
		[clearTimelineSelection, seekTimelineAtClientX],
	);

	const handleTimelinePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) {
				return;
			}

			if (!shouldStartTimelineScrub(e.target, e.currentTarget)) {
				return;
			}

			if (!seekTimelineAtClientX(e.currentTarget, e.clientX)) {
				return;
			}

			clearTimelineSelection();
			isScrubbingTimelineRef.current = true;
			scrubPointerIdRef.current = e.pointerId;
			e.currentTarget.setPointerCapture(e.pointerId);
			e.preventDefault();
		},
		[clearTimelineSelection, seekTimelineAtClientX],
	);

	const handleTimelinePointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (!isScrubbingTimelineRef.current || scrubPointerIdRef.current !== e.pointerId) {
				return;
			}

			seekTimelineAtClientX(e.currentTarget, e.clientX);
			e.preventDefault();
		},
		[seekTimelineAtClientX],
	);

	const stopTimelineScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!isScrubbingTimelineRef.current || scrubPointerIdRef.current !== e.pointerId) {
			return;
		}

		isScrubbingTimelineRef.current = false;
		scrubPointerIdRef.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	}, []);

	const handleTimelinePointerLeave = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (isScrubbingTimelineRef.current && scrubPointerIdRef.current === e.pointerId) {
				seekTimelineAtClientX(e.currentTarget, e.clientX);
			}
		},
		[seekTimelineAtClientX],
	);

	const handleTimelineLostPointerCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (scrubPointerIdRef.current === e.pointerId) {
			isScrubbingTimelineRef.current = false;
			scrubPointerIdRef.current = null;
		}
	}, []);

	const handleTimelineWheel = useCallback(
		(event: React.WheelEvent<HTMLDivElement>) => {
			if (!onRangeChange || event.ctrlKey || event.metaKey || videoDurationMs <= 0) {
				return;
			}

			const visibleMs = range.end - range.start;
			if (visibleMs <= 0 || videoDurationMs <= visibleMs) {
				return;
			}

			const dominantDelta =
				Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
			if (dominantDelta === 0) {
				return;
			}

			event.preventDefault();

			const pageWidthPx = Math.max(event.currentTarget.clientWidth - sidebarWidth, 1);
			const normalizedDeltaPx = normalizeWheelDelta(dominantDelta, event.deltaMode, pageWidthPx);
			const shiftMs = pixelsToValue(normalizedDeltaPx);

			onRangeChange((previous) => {
				const nextRange = clampVisibleRange(
					{
						start: previous.start + shiftMs,
						end: previous.end + shiftMs,
					},
					videoDurationMs,
				);

				return nextRange.start === previous.start && nextRange.end === previous.end
					? previous
					: nextRange;
			});
		},
		[onRangeChange, videoDurationMs, range.end, range.start, sidebarWidth, pixelsToValue],
	);

	const zoomItems = items.filter((item) => item.rowId === ZOOM_ROW_ID);
	const cameraFullscreenItems = items.filter((item) => item.rowId === CAMERA_ROW_ID);
	const annotationItems = items.filter((item) => item.rowId === ANNOTATION_ROW_ID);
	const blurItems = items.filter((item) => item.rowId === BLUR_ROW_ID);
	const speedItems = items.filter((item) => item.rowId === SPEED_ROW_ID);

	return (
		<div
			ref={setRefs}
			style={{ ...style, touchAction: "none" }}
			className="select-none bg-[#0b0c0f] min-h-[190px] relative cursor-pointer group"
			onClick={handleTimelineClick}
			onPointerDown={handleTimelinePointerDown}
			onPointerMove={handleTimelinePointerMove}
			onPointerUp={stopTimelineScrub}
			onPointerCancel={stopTimelineScrub}
			onPointerLeave={handleTimelinePointerLeave}
			onLostPointerCapture={handleTimelineLostPointerCapture}
			onWheel={handleTimelineWheel}
		>
			<div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px)] bg-[length:24px_100%] pointer-events-none" />
			<TimelineAxis videoDurationMs={videoDurationMs} currentTimeMs={currentTimeMs} />
			<ClipsTrack
				clips={clips}
				selectedClipStartMs={selectedClipStartMs}
				onSelectClip={onSelectClip}
				onDeleteClip={onDeleteClip}
				rangeStartMs={range.start}
				sidebarWidth={sidebarWidth}
				valueToPixels={valueToPixels}
				deleteLabel={t("buttons.deleteClip")}
			/>
			<PlaybackCursor
				currentTimeMs={currentTimeMs}
				videoDurationMs={videoDurationMs}
				getPlaybackTimeMs={getPlaybackTimeMs}
				onSeek={onSeek}
				onRangeChange={onRangeChange}
				timelineRef={localTimelineRef}
				keyframes={keyframes}
			/>

			<Row id={ZOOM_ROW_ID} isEmpty={zoomItems.length === 0} hint={t("hints.pressZoom")}>
				{zoomItems.map((item) => (
					<Item
						id={item.id}
						key={item.id}
						rowId={item.rowId}
						span={item.span}
						isSelected={item.id === selectedZoomId}
						onSelect={() => onSelectZoom?.(item.id)}
						zoomDepth={item.zoomDepth}
						zoomCustomScale={item.zoomCustomScale}
						isAutoFocus={item.isAutoFocus}
						variant="zoom"
					>
						{item.label}
					</Item>
				))}
			</Row>

			<Row
				id={CAMERA_ROW_ID}
				isEmpty={cameraFullscreenItems.length === 0}
				hint={t("hints.pressCameraFullscreen")}
			>
				{cameraFullscreenItems.map((item) => (
					<Item
						id={item.id}
						key={item.id}
						rowId={item.rowId}
						span={item.span}
						isSelected={item.id === selectedCameraFullscreenId}
						onSelect={() => onSelectCameraFullscreen?.(item.id)}
						variant="camera-fullscreen"
					>
						{item.label}
					</Item>
				))}
			</Row>

			<Row
				id={ANNOTATION_ROW_ID}
				isEmpty={annotationItems.length === 0}
				hint={t("hints.pressAnnotation")}
			>
				{annotationItems.map((item) => (
					<Item
						id={item.id}
						key={item.id}
						rowId={item.rowId}
						span={item.span}
						isSelected={item.id === selectedAnnotationId}
						onSelect={() => onSelectAnnotation?.(item.id)}
						variant="annotation"
					>
						{item.label}
					</Item>
				))}
			</Row>

			{BLUR_REGIONS_ENABLED && (
				<Row id={BLUR_ROW_ID} isEmpty={blurItems.length === 0} hint={t("hints.pressBlur")}>
					{blurItems.map((item) => (
						<Item
							id={item.id}
							key={item.id}
							rowId={item.rowId}
							span={item.span}
							isSelected={item.id === selectedBlurId}
							onSelect={() => onSelectBlur?.(item.id)}
							variant={item.variant}
						>
							{item.label}
						</Item>
					))}
				</Row>
			)}

			<Row id={SPEED_ROW_ID} isEmpty={speedItems.length === 0} hint={t("hints.pressSpeed")}>
				{speedItems.map((item) => (
					<Item
						id={item.id}
						key={item.id}
						rowId={item.rowId}
						span={item.span}
						isSelected={item.id === selectedSpeedId}
						onSelect={() => onSelectSpeed?.(item.id)}
						variant="speed"
						speedValue={item.speedValue}
					>
						{item.label}
					</Item>
				))}
			</Row>
		</div>
	);
}

export default function TimelineEditor({
	videoDuration,
	hasVideoSource = false,
	currentTime,
	getPlaybackTimeMs,
	onSeek,
	zoomRegions,
	onZoomAdded,
	autoZoomEnabled = true,
	onToggleAutoZoom,
	autoZoomEngine = "v2",
	onAutoZoomEngineChange,
	autoFocusAll = false,
	onToggleAutoFocusAll,
	onZoomSpanChange,
	onZoomDelete,
	selectedZoomId,
	onSelectZoom,
	cameraFullscreenRegions = [],
	onCameraFullscreenAdded,
	onCameraFullscreenSpanChange,
	onCameraFullscreenDelete,
	selectedCameraFullscreenId,
	onSelectCameraFullscreen,
	clips = [],
	onSplit,
	onDeleteClip,
	selectedClipStartMs = null,
	onSelectClip,
	annotationRegions = [],
	onAnnotationAdded,
	onAnnotationSpanChange,
	onAnnotationDelete,
	selectedAnnotationId,
	onSelectAnnotation,
	blurRegions = [],
	onBlurAdded,
	onBlurSpanChange,
	onBlurDelete,
	selectedBlurId,
	onSelectBlur,
	speedRegions = [],
	onSpeedAdded,
	onSpeedSpanChange,
	onSpeedDelete,
	selectedSpeedId,
	onSelectSpeed,
	aspectRatio,
	onAspectRatioChange,
	videoUrl,
	onGenerateCaptions,
	isGeneratingCaptions = false,
	captionsLabel,
}: TimelineEditorProps) {
	const t = useScopedT("timeline");
	const totalMs = useMemo(() => Math.max(0, Math.round(videoDuration * 1000)), [videoDuration]);
	const currentTimeMs = useMemo(() => Math.round(currentTime * 1000), [currentTime]);
	const timelineScale = useMemo(() => calculateTimelineScale(videoDuration), [videoDuration]);
	const safeMinDurationMs = useMemo(
		() =>
			totalMs > 0
				? Math.min(timelineScale.minItemDurationMs, totalMs)
				: timelineScale.minItemDurationMs,
		[timelineScale.minItemDurationMs, totalMs],
	);

	const [range, setRange] = useState<Range>(() => createInitialRange(totalMs));
	const [keyframes, setKeyframes] = useState<{ id: string; time: number }[]>([]);
	const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
	const [scrollLabels, setScrollLabels] = useState({
		pan: "Scroll",
		zoom: "Ctrl + Scroll",
	});
	const timelineContainerRef = useRef<HTMLDivElement>(null);
	const { shortcuts: keyShortcuts, isMac } = useShortcuts();

	useEffect(() => {
		formatShortcut(["mod", "Scroll"]).then((zoom) => {
			setScrollLabels({ pan: "Scroll", zoom });
		});
	}, []);

	const addKeyframe = useCallback(() => {
		if (totalMs === 0) return;
		const time = Math.max(0, Math.min(currentTimeMs, totalMs));
		if (keyframes.some((kf) => Math.abs(kf.time - time) < 1)) return;
		setKeyframes((prev) => [...prev, { id: uuidv4(), time }]);
	}, [currentTimeMs, totalMs, keyframes]);

	const deleteSelectedKeyframe = useCallback(() => {
		if (!selectedKeyframeId) return;
		setKeyframes((prev) => prev.filter((kf) => kf.id !== selectedKeyframeId));
		setSelectedKeyframeId(null);
	}, [selectedKeyframeId]);

	const handleKeyframeMove = useCallback(
		(id: string, newTime: number) => {
			setKeyframes((prev) =>
				prev.map((kf) =>
					kf.id === id ? { ...kf, time: Math.max(0, Math.min(newTime, totalMs)) } : kf,
				),
			);
		},
		[totalMs],
	);

	const deleteSelectedZoom = useCallback(() => {
		if (!selectedZoomId) return;
		onZoomDelete(selectedZoomId);
		onSelectZoom(null);
	}, [selectedZoomId, onZoomDelete, onSelectZoom]);

	const deleteSelectedCameraFullscreen = useCallback(() => {
		if (!selectedCameraFullscreenId || !onCameraFullscreenDelete || !onSelectCameraFullscreen) {
			return;
		}
		onCameraFullscreenDelete(selectedCameraFullscreenId);
		onSelectCameraFullscreen(null);
	}, [selectedCameraFullscreenId, onCameraFullscreenDelete, onSelectCameraFullscreen]);

	const selectedClip = useMemo(
		() => clips.find((c) => c.srcStartMs === selectedClipStartMs) ?? null,
		[clips, selectedClipStartMs],
	);
	const deleteSelectedClip = useCallback(() => {
		if (!selectedClip || !onDeleteClip) return;
		onDeleteClip(selectedClip);
	}, [selectedClip, onDeleteClip]);

	const deleteSelectedAnnotation = useCallback(() => {
		if (!selectedAnnotationId || !onAnnotationDelete || !onSelectAnnotation) return;
		onAnnotationDelete(selectedAnnotationId);
		onSelectAnnotation(null);
	}, [selectedAnnotationId, onAnnotationDelete, onSelectAnnotation]);

	const deleteSelectedBlur = useCallback(() => {
		if (!selectedBlurId || !onBlurDelete || !onSelectBlur) return;
		onBlurDelete(selectedBlurId);
		onSelectBlur(null);
	}, [selectedBlurId, onBlurDelete, onSelectBlur]);

	const deleteSelectedSpeed = useCallback(() => {
		if (!selectedSpeedId || !onSpeedDelete || !onSelectSpeed) return;
		onSpeedDelete(selectedSpeedId);
		onSelectSpeed(null);
	}, [selectedSpeedId, onSpeedDelete, onSelectSpeed]);

	useEffect(() => {
		setRange(createInitialRange(totalMs));
	}, [totalMs]);

	// Normalize regions only when timeline bounds change. Reading via refs avoids a
	// dependency loop that would re-fire on every drag and race dnd-timeline's state.
	const zoomRegionsRef = useRef(zoomRegions);
	const cameraFullscreenRegionsRef = useRef(cameraFullscreenRegions);
	const speedRegionsRef = useRef(speedRegions);
	// Sync refs in an effect (not during render) so render stays pure; defined before
	// the normalization effect below so that effect reads the freshest region values.
	useEffect(() => {
		zoomRegionsRef.current = zoomRegions;
		cameraFullscreenRegionsRef.current = cameraFullscreenRegions;
		speedRegionsRef.current = speedRegions;
	}, [zoomRegions, cameraFullscreenRegions, speedRegions]);

	useEffect(() => {
		if (totalMs === 0 || safeMinDurationMs <= 0) {
			return;
		}

		zoomRegionsRef.current.forEach((region) => {
			const clampedStart = Math.max(0, Math.min(region.startMs, totalMs));
			const minEnd = clampedStart + safeMinDurationMs;
			const clampedEnd = Math.min(totalMs, Math.max(minEnd, region.endMs));
			const normalizedStart = Math.max(0, Math.min(clampedStart, totalMs - safeMinDurationMs));
			const normalizedEnd = Math.max(minEnd, Math.min(clampedEnd, totalMs));

			if (normalizedStart !== region.startMs || normalizedEnd !== region.endMs) {
				onZoomSpanChange(region.id, { start: normalizedStart, end: normalizedEnd });
			}
		});

		cameraFullscreenRegionsRef.current.forEach((region) => {
			const clampedStart = Math.max(0, Math.min(region.startMs, totalMs));
			const minEnd = clampedStart + safeMinDurationMs;
			const clampedEnd = Math.min(totalMs, Math.max(minEnd, region.endMs));
			const normalizedStart = Math.max(0, Math.min(clampedStart, totalMs - safeMinDurationMs));
			const normalizedEnd = Math.max(minEnd, Math.min(clampedEnd, totalMs));

			if (normalizedStart !== region.startMs || normalizedEnd !== region.endMs) {
				onCameraFullscreenSpanChange?.(region.id, { start: normalizedStart, end: normalizedEnd });
			}
		});

		speedRegionsRef.current.forEach((region) => {
			const clampedStart = Math.max(0, Math.min(region.startMs, totalMs));
			const minEnd = clampedStart + safeMinDurationMs;
			const clampedEnd = Math.min(totalMs, Math.max(minEnd, region.endMs));
			const normalizedStart = Math.max(0, Math.min(clampedStart, totalMs - safeMinDurationMs));
			const normalizedEnd = Math.max(minEnd, Math.min(clampedEnd, totalMs));

			if (normalizedStart !== region.startMs || normalizedEnd !== region.endMs) {
				onSpeedSpanChange?.(region.id, { start: normalizedStart, end: normalizedEnd });
			}
		});
	}, [
		totalMs,
		safeMinDurationMs,
		onZoomSpanChange,
		onCameraFullscreenSpanChange,
		onSpeedSpanChange,
	]);

	const hasOverlap = useCallback(
		(newSpan: Span, excludeId?: string): boolean => {
			const isZoomItem = zoomRegions.some((r) => r.id === excludeId);
			const isCameraFullscreenItem = cameraFullscreenRegions.some((r) => r.id === excludeId);
			const isAnnotationItem = annotationRegions.some((r) => r.id === excludeId);
			const isBlurItem = blurRegions.some((r) => r.id === excludeId);
			const isSpeedItem = speedRegions.some((r) => r.id === excludeId);

			if (isAnnotationItem || isBlurItem) {
				return false;
			}

			const checkOverlap = (regions: (ZoomRegion | CameraFullscreenRegion | SpeedRegion)[]) => {
				return regions.some((region) => {
					if (region.id === excludeId) return false;
					// True intersection, adjacency is allowed
					return newSpan.end > region.startMs && newSpan.start < region.endMs;
				});
			};

			if (isZoomItem) {
				return checkOverlap(zoomRegions);
			}

			if (isCameraFullscreenItem) {
				return checkOverlap(cameraFullscreenRegions);
			}

			if (isSpeedItem) {
				return checkOverlap(speedRegions);
			}

			return false;
		},
		[zoomRegions, cameraFullscreenRegions, annotationRegions, blurRegions, speedRegions],
	);

	// 5% of the timeline or 1000ms, whichever is larger, so it's wide enough to grab.
	const defaultRegionDurationMs = useMemo(
		() => Math.max(1000, Math.round(totalMs * 0.05)),
		[totalMs],
	);

	const handleAddZoom = useCallback(() => {
		if (!videoDuration || videoDuration === 0 || totalMs === 0) {
			return;
		}

		const defaultDuration = Math.min(defaultRegionDurationMs, totalMs);
		if (defaultDuration <= 0) {
			return;
		}

		const startPos = Math.max(0, Math.min(currentTimeMs, totalMs));
		const { ok, gapMs } = findFreeGapAt(zoomRegions, startPos, totalMs);
		if (!ok) {
			toast.error(t("errors.cannotPlaceZoom"), {
				description: t("errors.zoomExistsAtLocation"),
			});
			return;
		}

		const actualDuration = Math.min(defaultRegionDurationMs, gapMs);
		onZoomAdded({ start: startPos, end: startPos + actualDuration });
	}, [videoDuration, totalMs, currentTimeMs, zoomRegions, onZoomAdded, defaultRegionDurationMs, t]);

	const handleAddCameraFullscreen = useCallback(() => {
		if (!videoDuration || videoDuration === 0 || totalMs === 0 || !onCameraFullscreenAdded) {
			return;
		}

		const defaultDuration = Math.min(defaultRegionDurationMs, totalMs);
		if (defaultDuration <= 0) {
			return;
		}

		const startPos = Math.max(0, Math.min(currentTimeMs, totalMs));
		const { ok, gapMs } = findFreeGapAt(cameraFullscreenRegions, startPos, totalMs);
		if (!ok) {
			toast.error(t("errors.cannotPlaceCameraFullscreen"), {
				description: t("errors.cameraFullscreenExistsAtLocation"),
			});
			return;
		}

		const actualDuration = Math.min(defaultRegionDurationMs, gapMs);
		onCameraFullscreenAdded({ start: startPos, end: startPos + actualDuration });
	}, [
		videoDuration,
		totalMs,
		currentTimeMs,
		cameraFullscreenRegions,
		onCameraFullscreenAdded,
		defaultRegionDurationMs,
		t,
	]);

	const handleAddSpeed = useCallback(() => {
		if (!videoDuration || videoDuration === 0 || totalMs === 0 || !onSpeedAdded) {
			return;
		}

		const defaultDuration = Math.min(defaultRegionDurationMs, totalMs);
		if (defaultDuration <= 0) {
			return;
		}

		const startPos = Math.max(0, Math.min(currentTimeMs, totalMs));
		const { ok, gapMs } = findFreeGapAt(speedRegions, startPos, totalMs);
		if (!ok) {
			toast.error(t("errors.cannotPlaceSpeed"), {
				description: t("errors.speedExistsAtLocation"),
			});
			return;
		}

		const actualDuration = Math.min(defaultRegionDurationMs, gapMs);
		onSpeedAdded({ start: startPos, end: startPos + actualDuration });
	}, [
		videoDuration,
		totalMs,
		currentTimeMs,
		speedRegions,
		onSpeedAdded,
		defaultRegionDurationMs,
		t,
	]);

	const handleAddAnnotation = useCallback(() => {
		if (!videoDuration || videoDuration === 0 || totalMs === 0 || !onAnnotationAdded) {
			return;
		}

		const defaultDuration = Math.min(defaultRegionDurationMs, totalMs);
		if (defaultDuration <= 0) {
			return;
		}

		// Multiple annotations can exist at the same timestamp
		const startPos = Math.max(0, Math.min(currentTimeMs, totalMs));
		const endPos = Math.min(startPos + defaultDuration, totalMs);

		onAnnotationAdded({ start: startPos, end: endPos });
	}, [videoDuration, totalMs, currentTimeMs, onAnnotationAdded, defaultRegionDurationMs]);

	const handleAddBlur = useCallback(() => {
		if (!videoDuration || videoDuration === 0 || totalMs === 0 || !onBlurAdded) {
			return;
		}

		const defaultDuration = Math.min(defaultRegionDurationMs, totalMs);
		if (defaultDuration <= 0) {
			return;
		}

		const startPos = Math.max(0, Math.min(currentTimeMs, totalMs));
		const endPos = Math.min(startPos + defaultDuration, totalMs);
		onBlurAdded({ start: startPos, end: endPos });
	}, [videoDuration, totalMs, currentTimeMs, onBlurAdded, defaultRegionDurationMs]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (isTextEditingTarget(e.target)) {
				return;
			}

			if (matchesShortcut(e, keyShortcuts.addKeyframe, isMac)) {
				addKeyframe();
			}
			if (matchesShortcut(e, keyShortcuts.addZoom, isMac)) {
				handleAddZoom();
			}
			if (matchesShortcut(e, keyShortcuts.addTrim, isMac)) {
				onSplit?.();
			}
			if (matchesShortcut(e, keyShortcuts.addAnnotation, isMac)) {
				handleAddAnnotation();
			}
			if (BLUR_REGIONS_ENABLED && matchesShortcut(e, keyShortcuts.addBlur, isMac)) {
				handleAddBlur();
			}
			if (matchesShortcut(e, keyShortcuts.addSpeed, isMac)) {
				handleAddSpeed();
			}
			if (matchesShortcut(e, keyShortcuts.addCameraFullscreen, isMac)) {
				handleAddCameraFullscreen();
			}

			// Tab cycles through overlapping annotations at the current time
			if (e.key === "Tab" && annotationRegions.length > 0) {
				const currentTimeMs = Math.round(currentTime * 1000);
				const overlapping = annotationRegions
					.filter((a) => currentTimeMs >= a.startMs && currentTimeMs <= a.endMs)
					.sort((a, b) => a.zIndex - b.zIndex);

				if (overlapping.length > 0) {
					e.preventDefault();

					if (!selectedAnnotationId || !overlapping.some((a) => a.id === selectedAnnotationId)) {
						onSelectAnnotation?.(overlapping[0].id);
					} else {
						const currentIndex = overlapping.findIndex((a) => a.id === selectedAnnotationId);
						const nextIndex = e.shiftKey
							? (currentIndex - 1 + overlapping.length) % overlapping.length // Shift+Tab steps backward
							: (currentIndex + 1) % overlapping.length;
						onSelectAnnotation?.(overlapping[nextIndex].id);
					}
				}
			}
			// Delete key or Ctrl+D / Cmd+D
			if (
				e.key === "Delete" ||
				e.key === "Backspace" ||
				matchesShortcut(e, keyShortcuts.deleteSelected, isMac)
			) {
				if (selectedKeyframeId) {
					deleteSelectedKeyframe();
				} else if (selectedZoomId) {
					deleteSelectedZoom();
				} else if (selectedCameraFullscreenId) {
					deleteSelectedCameraFullscreen();
				} else if (selectedClip) {
					deleteSelectedClip();
				} else if (selectedAnnotationId) {
					deleteSelectedAnnotation();
				} else if (selectedBlurId) {
					deleteSelectedBlur();
				} else if (selectedSpeedId) {
					deleteSelectedSpeed();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		addKeyframe,
		handleAddZoom,
		onSplit,
		handleAddAnnotation,
		handleAddBlur,
		handleAddSpeed,
		handleAddCameraFullscreen,
		deleteSelectedKeyframe,
		deleteSelectedZoom,
		deleteSelectedCameraFullscreen,
		deleteSelectedClip,
		deleteSelectedAnnotation,
		deleteSelectedBlur,
		deleteSelectedSpeed,
		selectedKeyframeId,
		selectedZoomId,
		selectedCameraFullscreenId,
		selectedClip,
		selectedAnnotationId,
		selectedBlurId,
		selectedSpeedId,
		annotationRegions,
		currentTime,
		onSelectAnnotation,
		keyShortcuts,
		isMac,
	]);

	const clampedRange = useMemo<Range>(() => {
		if (totalMs === 0) {
			return range;
		}

		return {
			start: Math.max(0, Math.min(range.start, totalMs)),
			end: Math.min(range.end, totalMs),
		};
	}, [range, totalMs]);

	const timelineItems = useMemo<TimelineRenderItem[]>(() => {
		const zooms: TimelineRenderItem[] = zoomRegions.map((region, index) => ({
			id: region.id,
			rowId: ZOOM_ROW_ID,
			span: { start: region.startMs, end: region.endMs },
			label: t("labels.zoomItem", { index: String(index + 1) }),
			zoomDepth: region.depth,
			zoomCustomScale: region.customScale,
			isAutoFocus: region.focusMode === "auto",
			variant: "zoom",
		}));

		const cameraFullscreens: TimelineRenderItem[] = cameraFullscreenRegions.map(
			(region, index) => ({
				id: region.id,
				rowId: CAMERA_ROW_ID,
				span: { start: region.startMs, end: region.endMs },
				label: t("labels.cameraFullscreenItem", { index: String(index + 1) }),
				variant: "camera-fullscreen",
			}),
		);

		const annotations: TimelineRenderItem[] = annotationRegions.map((region) => {
			let label: string;

			if (region.type === "text") {
				const preview = region.content.trim() || t("labels.emptyText");
				label = preview.length > 20 ? `${preview.substring(0, 20)}...` : preview;
			} else if (region.type === "image") {
				label = t("labels.imageItem");
			} else {
				label = t("labels.annotationItem");
			}

			return {
				id: region.id,
				rowId: ANNOTATION_ROW_ID,
				span: { start: region.startMs, end: region.endMs },
				label,
				variant: "annotation",
			};
		});

		const blurs: TimelineRenderItem[] = blurRegions.map((region, index) => ({
			id: region.id,
			rowId: BLUR_ROW_ID,
			span: { start: region.startMs, end: region.endMs },
			label: t("labels.blurItem", { index: String(index + 1) }),
			variant: "blur",
		}));

		const speeds: TimelineRenderItem[] = speedRegions.map((region, index) => ({
			id: region.id,
			rowId: SPEED_ROW_ID,
			span: { start: region.startMs, end: region.endMs },
			label: t("labels.speedItem", { index: String(index + 1) }),
			speedValue: region.speed,
			variant: "speed",
		}));

		return [...zooms, ...cameraFullscreens, ...annotations, ...blurs, ...speeds];
	}, [zoomRegions, cameraFullscreenRegions, annotationRegions, blurRegions, speedRegions, t]);

	// Spans that participate in overlap resolution (clampToNeighbours). Annotation
	// and blur are excluded since they may overlap and shouldn't constrain a drag.
	const allRegionSpans = useMemo(() => {
		const zooms = zoomRegions.map((r) => ({ id: r.id, start: r.startMs, end: r.endMs }));
		const cameraFullscreens = cameraFullscreenRegions.map((r) => ({
			id: r.id,
			start: r.startMs,
			end: r.endMs,
		}));
		const speeds = speedRegions.map((r) => ({ id: r.id, start: r.startMs, end: r.endMs }));
		return [...zooms, ...cameraFullscreens, ...speeds];
	}, [zoomRegions, cameraFullscreenRegions, speedRegions]);

	// Snap targets whose edges pull during a snap but don't push anyone away.
	const softSnapSpans = useMemo(() => {
		const annotations = annotationRegions.map((r) => ({
			id: r.id,
			start: r.startMs,
			end: r.endMs,
		}));
		const blurs = blurRegions.map((r) => ({ id: r.id, start: r.startMs, end: r.endMs }));
		return [...annotations, ...blurs];
	}, [annotationRegions, blurRegions]);

	const keyframeTimesMs = useMemo(() => keyframes.map((kf) => kf.time), [keyframes]);

	const handleItemSpanChange = useCallback(
		(id: string, span: Span) => {
			if (zoomRegions.some((r) => r.id === id)) {
				onZoomSpanChange(id, span);
			} else if (cameraFullscreenRegions.some((r) => r.id === id)) {
				onCameraFullscreenSpanChange?.(id, span);
			} else if (speedRegions.some((r) => r.id === id)) {
				onSpeedSpanChange?.(id, span);
			} else if (annotationRegions.some((r) => r.id === id)) {
				onAnnotationSpanChange?.(id, span);
			} else if (blurRegions.some((r) => r.id === id)) {
				onBlurSpanChange?.(id, span);
			}
		},
		[
			zoomRegions,
			cameraFullscreenRegions,
			speedRegions,
			annotationRegions,
			blurRegions,
			onZoomSpanChange,
			onCameraFullscreenSpanChange,
			onSpeedSpanChange,
			onAnnotationSpanChange,
			onBlurSpanChange,
		],
	);

	if (!videoDuration || videoDuration === 0) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center rounded-lg bg-[#09090b] gap-3">
				<div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center">
					<Plus className="w-6 h-6 text-slate-600" />
				</div>
				<div className="text-center">
					<p className="text-sm font-medium text-slate-300">
						{hasVideoSource ? "Loading Timeline" : "No Video Loaded"}
					</p>
					<p className="text-xs text-slate-500 mt-1">
						{hasVideoSource
							? "Video opened, waiting for duration metadata"
							: "Drag and drop a video to start editing"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 flex flex-col bg-[#09090b] overflow-hidden">
			<div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-[#08090b]/95">
				<div className="flex items-center gap-0.5 rounded-xl border border-white/[0.06] bg-white/[0.025] p-0.5">
					<Button
						onClick={handleAddZoom}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-brand hover:bg-brand/10 transition-all"
						title={t("buttons.addZoom")}
					>
						<ZoomIn className="w-4 h-4" />
					</Button>
					<Button
						onClick={handleAddCameraFullscreen}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#38bdf8] hover:bg-[#38bdf8]/10 transition-all"
						title={t("buttons.addCameraFullscreen")}
					>
						<Maximize className="w-4 h-4" />
					</Button>
					<Button
						onClick={() => onToggleAutoZoom?.(!autoZoomEnabled)}
						variant="ghost"
						size="icon"
						aria-pressed={autoZoomEnabled}
						className={cn(
							"h-7 w-7 rounded-lg transition-all hover:bg-brand/10 hover:text-brand",
							autoZoomEnabled ? "bg-brand/15 text-brand" : "text-slate-400",
						)}
						title={autoZoomEnabled ? t("buttons.autoZoomOn") : t("buttons.autoZoomOff")}
					>
						<WandSparkles className="w-4 h-4" />
					</Button>
					<Button
						onClick={() => onAutoZoomEngineChange?.(autoZoomEngine === "v2" ? "legacy" : "v2")}
						variant="ghost"
						size="icon"
						aria-pressed={autoZoomEngine === "v2"}
						className={cn(
							"h-7 w-7 rounded-lg transition-all hover:bg-brand/10 hover:text-brand",
							autoZoomEngine === "v2" ? "bg-brand/15 text-brand" : "text-slate-400",
						)}
						title={
							autoZoomEngine === "v2"
								? t("buttons.autoZoomEngineV2")
								: t("buttons.autoZoomEngineLegacy")
						}
					>
						<FlaskConical className="w-4 h-4" />
					</Button>
					<Button
						onClick={() => onToggleAutoFocusAll?.(!autoFocusAll)}
						variant="ghost"
						size="icon"
						aria-pressed={autoFocusAll}
						className={cn(
							"h-7 w-7 rounded-lg transition-all hover:bg-brand/10 hover:text-brand",
							autoFocusAll ? "bg-brand/15 text-brand" : "text-slate-400",
						)}
						title={autoFocusAll ? t("buttons.autoFocusAllOn") : t("buttons.autoFocusAllOff")}
					>
						<ScanEye className="w-4 h-4" />
					</Button>
					<Button
						onClick={() => onSplit?.()}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-brand hover:bg-brand/10 transition-all"
						title={t("buttons.split")}
					>
						<Scissors className="w-4 h-4" />
					</Button>
					<Button
						onClick={deleteSelectedClip}
						disabled={!selectedClip}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#ef4444] hover:bg-[#ef4444]/10 transition-all disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:bg-transparent"
						title={t("buttons.deleteClip")}
					>
						<Trash2 className="w-4 h-4" />
					</Button>
					<Button
						onClick={handleAddAnnotation}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#FACC15] hover:bg-[#FACC15]/10 transition-all"
						title={t("buttons.addAnnotation")}
					>
						<MessageSquare className="w-4 h-4" />
					</Button>
					{BLUR_REGIONS_ENABLED && (
						<Button
							onClick={handleAddBlur}
							variant="ghost"
							size="icon"
							className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#7dd3fc] hover:bg-[#7dd3fc]/10 transition-all"
							title={t("buttons.addBlur")}
						>
							<svg
								className="w-4 h-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
							>
								<circle cx="8" cy="12" r="3" />
								<circle cx="16" cy="12" r="3" />
								<path d="M6 6h12M6 18h12" />
							</svg>
						</Button>
					)}
					<Button
						onClick={handleAddSpeed}
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#d97706] hover:bg-[#d97706]/10 transition-all"
						title={t("buttons.addSpeed")}
					>
						<Gauge className="w-4 h-4" />
					</Button>
					{onGenerateCaptions && (
						<Button
							onClick={onGenerateCaptions}
							disabled={isGeneratingCaptions || !videoUrl}
							variant="ghost"
							size="icon"
							className="h-7 w-7 rounded-lg text-slate-400 hover:text-[#a78bfa] hover:bg-[#a78bfa]/10 transition-all"
							title={captionsLabel}
						>
							<Captions className="w-4 h-4" />
						</Button>
					)}
				</div>
				<div className="flex items-center gap-1.5 min-w-0">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.07] transition-all gap-1"
							>
								<span className="font-medium">{getAspectRatioLabel(aspectRatio)}</span>
								<ChevronDown className="w-3 h-3" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="bg-[#1a1a1a] border-white/10">
							{ASPECT_RATIOS.map((ratio) => (
								<DropdownMenuItem
									key={ratio}
									onClick={() => onAspectRatioChange(ratio)}
									className="text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3"
								>
									<span>{getAspectRatioLabel(ratio)}</span>
									{aspectRatio === ratio && <Check className="w-3 h-3 text-brand" />}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<div className="flex-1" />
				<div className="hidden md:flex items-center gap-3 text-[10px] text-slate-500 font-medium">
					<span className="flex items-center gap-1.5">
						<kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-brand font-sans">
							{scrollLabels.pan}
						</kbd>
						<span>{t("labels.pan")}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-brand font-sans">
							{scrollLabels.zoom}
						</kbd>
						<span>{t("labels.zoom")}</span>
					</span>
				</div>
			</div>
			<div
				ref={timelineContainerRef}
				className="flex-1 min-h-0 overflow-auto custom-scrollbar bg-[#09090b] relative"
				onClick={() => setSelectedKeyframeId(null)}
			>
				<TimelineWrapper
					range={clampedRange}
					videoDuration={videoDuration}
					hasOverlap={hasOverlap}
					onRangeChange={setRange}
					minItemDurationMs={timelineScale.minItemDurationMs}
					minVisibleRangeMs={timelineScale.minVisibleRangeMs}
					onItemSpanChange={handleItemSpanChange}
					allRegionSpans={allRegionSpans}
					softSnapSpans={softSnapSpans}
					currentTimeMs={currentTimeMs}
					keyframeTimesMs={keyframeTimesMs}
				>
					<KeyframeMarkers
						keyframes={keyframes}
						selectedKeyframeId={selectedKeyframeId}
						setSelectedKeyframeId={setSelectedKeyframeId}
						onKeyframeMove={handleKeyframeMove}
						videoDurationMs={totalMs}
						timelineRef={timelineContainerRef}
					/>
					<Timeline
						items={timelineItems}
						videoDurationMs={totalMs}
						currentTimeMs={currentTimeMs}
						getPlaybackTimeMs={getPlaybackTimeMs}
						onSeek={onSeek}
						onRangeChange={setRange}
						onSelectZoom={onSelectZoom}
						onSelectCameraFullscreen={onSelectCameraFullscreen}
						onSelectAnnotation={onSelectAnnotation}
						onSelectBlur={onSelectBlur}
						onSelectSpeed={onSelectSpeed}
						selectedZoomId={selectedZoomId}
						selectedCameraFullscreenId={selectedCameraFullscreenId}
						selectedAnnotationId={selectedAnnotationId}
						selectedBlurId={selectedBlurId}
						selectedSpeedId={selectedSpeedId}
						clips={clips}
						selectedClipStartMs={selectedClipStartMs}
						onSelectClip={onSelectClip}
						onDeleteClip={onDeleteClip}
						keyframes={keyframes}
					/>
				</TimelineWrapper>
			</div>
		</div>
	);
}
