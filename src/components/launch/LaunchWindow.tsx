import {
	ChevronDown,
	Circle,
	CircleX,
	Clapperboard,
	Columns3,
	FileVideo,
	FolderOpen,
	GripVertical,
	Loader2,
	Mic,
	MicOff,
	Minus,
	Monitor,
	MousePointer2,
	NotepadText,
	Pause,
	Play,
	RotateCcw,
	Rows3,
	Square,
	Video,
	VideoOff,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { getLocaleName } from "@/i18n/loader";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import { useCameraDevices } from "../../hooks/useCameraDevices";
import { useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import { requestCameraAccess } from "../../lib/requestCameraAccess";
import { formatTimePadded } from "../../utils/timeUtils";
import { AudioLevelMeter } from "../ui/audio-level-meter";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import styles from "./LaunchWindow.module.css";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";

const ICON_SIZE = 18;

// Vertical tray gap (px): bar's `bottom-5` (20px) plus an 8px gap.
const HUD_DEVICE_POPUP_GAP = 28;
// Horizontal layout: mirrors the `bottom-[68px]` class on the popup element.
const HUD_DEVICE_POPUP_HORIZONTAL_BOTTOM = 68;

// Unified on Lucide (thin, SF Symbols-adjacent strokes) so every HUD glyph shares
// one visual weight, matching the macOS screen-recording control.
const ICON_CONFIG = {
	drag: { icon: GripVertical, size: ICON_SIZE },
	monitor: { icon: Monitor, size: ICON_SIZE },
	volumeOn: { icon: Volume2, size: ICON_SIZE },
	volumeOff: { icon: VolumeX, size: ICON_SIZE },
	micOn: { icon: Mic, size: ICON_SIZE },
	micOff: { icon: MicOff, size: ICON_SIZE },
	webcamOn: { icon: Video, size: ICON_SIZE },
	webcamOff: { icon: VideoOff, size: ICON_SIZE },
	cursor: { icon: MousePointer2, size: ICON_SIZE },
	pause: { icon: Pause, size: ICON_SIZE },
	resume: { icon: Play, size: ICON_SIZE },
	stop: { icon: Square, size: 15 },
	restart: { icon: RotateCcw, size: ICON_SIZE },
	cancel: { icon: CircleX, size: ICON_SIZE },
	record: { icon: Circle, size: 15 },
	videoFile: { icon: FileVideo, size: ICON_SIZE },
	folder: { icon: FolderOpen, size: ICON_SIZE },
	minimize: { icon: Minus, size: ICON_SIZE },
	close: { icon: X, size: ICON_SIZE },
	spinner: { icon: Loader2, size: ICON_SIZE },
} as const;

type IconName = keyof typeof ICON_CONFIG;

/** Renders the configured icon for a HUD control. */
function getIcon(name: IconName, className?: string) {
	const { icon: Icon, size } = ICON_CONFIG[name];
	return <Icon size={size} className={className} />;
}

const hudDisabledClasses =
	"disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none";

const hudGroupClasses = `flex items-center gap-0.5 rounded-xl border border-white/[0.07] bg-white/[0.045] transition-colors duration-150 hover:bg-white/[0.075] ${hudDisabledClasses}`;

const hudIconBtnClasses = `flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150 cursor-pointer text-white hover:bg-white/10 active:scale-95 ${hudDisabledClasses}`;

// Native "on" affordance: a soft accent-tinted segment (like a macOS Control Center
// toggle) rather than a neon glow, paired with a brand-colored icon.
const hudToggleActiveClasses = "bg-brand/15 ring-1 ring-inset ring-brand/30";

const hudAuxIconBtnClasses = `flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-150 text-white/55 hover:bg-white/10 ${hudDisabledClasses}`;

const windowBtnClasses = `flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150 cursor-pointer opacity-50 hover:opacity-90 hover:bg-white/[0.08] ${hudDisabledClasses}`;

// Frosted-glass material shared by the HUD bar, its popups and the editor's floating
// surfaces. Defined once as `.frosted-panel` in index.css.
const hudFrostedSurface = "frosted-panel";

const hudSidebarClasses = "ml-0.5 pl-1.5 border-l border-white/10 flex items-center gap-0.5";
const hudSidebarVerticalClasses =
	"mt-0.5 pt-1.5 border-t border-white/10 flex flex-col items-center gap-0.5";

/** Launches the floating recording HUD and its recorder controls. */
export function LaunchWindow() {
	const t = useScopedT("launch");
	// Locale is chosen from the native OS menu bar, so the HUD only surfaces the
	// one-time "use your system language?" suggestion.
	const { systemLocaleSuggestion, acceptSystemLocaleSuggestion, dismissSystemLocaleSuggestion } =
		useI18n();
	const suggestedLanguageName = systemLocaleSuggestion ? getLocaleName(systemLocaleSuggestion) : "";

	const {
		recording,
		paused,
		saving,
		elapsedSeconds,
		toggleRecording,
		togglePaused,
		canPauseRecording,
		restartRecording,
		cancelRecording,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		setMicrophoneDeviceName,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		setWebcamDeviceName,
		cursorCaptureMode,
		setCursorCaptureMode,
		softwareEncoderFallbackNoticeVisible,
		dismissSoftwareEncoderFallbackNotice,
	} = useScreenRecorder();

	const showMicControls = microphoneEnabled && !recording;
	const showWebcamControls = webcamEnabled && !recording;

	const [isMicHovered, setIsMicHovered] = useState(false);
	const [isMicFocused, setIsMicFocused] = useState(false);
	const micExpanded = isMicHovered || isMicFocused;

	const [isWebcamHovered, setIsWebcamHovered] = useState(false);
	const [isWebcamFocused, setIsWebcamFocused] = useState(false);
	const webcamExpanded = isWebcamHovered || isWebcamFocused;
	const [trayLayout, setTrayLayout] = useState<"horizontal" | "vertical">(
		() => loadUserPreferences().trayLayout,
	);
	const [supportsCursorModeToggle, setSupportsCursorModeToggle] = useState(false);
	const [isLinuxHud, setIsLinuxHud] = useState(false);
	const hudBarRef = useRef<HTMLDivElement | null>(null);
	const deviceSelectorRef = useRef<HTMLDivElement | null>(null);
	const systemLocalePromptRef = useRef<HTMLDivElement | null>(null);
	const softwareFallbackNoticeRef = useRef<HTMLDivElement | null>(null);
	// Measured bar height, anchors the popups above the tall vertical tray so they don't overlap it.
	const [hudBarHeight, setHudBarHeight] = useState(0);

	const {
		devices: micDevices,
		selectedDeviceId: selectedMicId,
		setSelectedDeviceId: setSelectedMicId,
	} = useMicrophoneDevices(microphoneEnabled);
	const {
		devices: cameraDevices,
		selectedDeviceId: selectedCameraId,
		setSelectedDeviceId: setSelectedCameraId,
		isLoading: isCameraDevicesLoading,
		error: cameraDevicesError,
	} = useCameraDevices(webcamEnabled);

	const selectedMicLabel =
		micDevices.find((d) => d.deviceId === (microphoneDeviceId || selectedMicId))?.label ||
		t("audio.defaultMicrophone");
	const selectedCameraDevice = cameraDevices.find(
		(d) => d.deviceId === (webcamDeviceId || selectedCameraId),
	);
	const selectedCameraLabel = isCameraDevicesLoading
		? t("webcam.searching")
		: cameraDevicesError
			? t("webcam.unavailable")
			: cameraDevices.length === 0
				? t("webcam.noneFound")
				: selectedCameraDevice?.label || t("webcam.defaultCamera");

	const { level } = useAudioLevelMeter({
		enabled: showMicControls,
		deviceId: microphoneDeviceId,
	});

	useEffect(() => {
		if (selectedMicId && selectedMicId !== "default") {
			setMicrophoneDeviceId(selectedMicId);
			setMicrophoneDeviceName(micDevices.find((d) => d.deviceId === selectedMicId)?.label);
		}
	}, [selectedMicId, micDevices, setMicrophoneDeviceId, setMicrophoneDeviceName]);

	useEffect(() => {
		if (selectedCameraId) {
			setWebcamDeviceId(selectedCameraId);
			setWebcamDeviceName(cameraDevices.find((d) => d.deviceId === selectedCameraId)?.label);
		}
	}, [selectedCameraId, cameraDevices, setWebcamDeviceId, setWebcamDeviceName]);

	useEffect(() => {
		let cancelled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!cancelled) {
					setSupportsCursorModeToggle(platform === "win32" || platform === "darwin");
					setIsLinuxHud(platform === "linux");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSupportsCursorModeToggle(false);
					setIsLinuxHud(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!import.meta.env.DEV) {
			return;
		}

		void requestCameraAccess().catch((error) => {
			console.warn("Failed to trigger camera access request during development:", error);
		});
	}, []);

	// Resize the overlay window to fit content, else the taller vertical tray gets clipped
	// and scrolls. Measure from the window's bottom-centre (the anchor the main process
	// preserves) so fixed bottom/centre offsets keep this stable and it doesn't oscillate.
	const lastHudSizeRef = useRef({ width: 0, height: 0 });
	const isDraggingHudRef = useRef(false);
	const measureHudSize = useCallback(() => {
		const barEl = hudBarRef.current;
		if (!barEl || !window.electronAPI?.setHudOverlaySize) return;
		// While the user is dragging the HUD, ignore content-size measurements. A
		// ResizeObserver-driven resize (hud-overlay-set-size) re-centres the window from
		// its own bottom-centre anchor, which fights the position "hud-overlay-move-by" is
		// actively applying frame-by-frame -- the two IPC channels racing is what produces
		// the reported drift. Content size is re-measured once the drag ends instead.
		if (isDraggingHudRef.current) return;

		// Breathing room so the drop shadow isn't clipped. TOP_MARGIN must also exceed the
		// slack in the bar's `max-h: calc(100vh - 2.5rem)` cap (40px reserved - 20px bottom
		// gap = 20px) so the window stays tall enough that the cap never engages and adds a scrollbar.
		const SIDE_MARGIN = 24;
		const TOP_MARGIN = 24;
		// Wide enough that the language menu (11rem) never clips, even when the bar is narrow.
		const MIN_WIDTH = 220;

		const viewportHeight = window.innerHeight;
		const centerX = window.innerWidth / 2;

		// Use natural (scroll) size, not the clipped box: vertical mode's max-h cap is a
		// small-screen fallback, and reading clipped height would pin the window to it.
		// scrollHeight gives full content height; the cap only engages when the main process clamps to screen.
		let topFromBottom = viewportHeight - barEl.getBoundingClientRect().bottom + barEl.scrollHeight;
		let halfWidth = barEl.scrollWidth / 2;

		// Popups drive both dimensions too. Their vertical anchor depends on bar height,
		// which is fed back through React state and lags by a frame, so derive their top
		// edge from the bar's natural height instead of the stale rendered position. Keeps
		// one measurement pass authoritative and avoids a feedback re-measure.
		if (deviceSelectorRef.current) {
			const rect = deviceSelectorRef.current.getBoundingClientRect();
			if (rect.width !== 0 || rect.height !== 0) {
				const popupBottomOffset =
					trayLayout === "vertical"
						? barEl.scrollHeight + HUD_DEVICE_POPUP_GAP
						: HUD_DEVICE_POPUP_HORIZONTAL_BOTTOM;
				topFromBottom = Math.max(topFromBottom, popupBottomOffset + rect.height);
				halfWidth = Math.max(halfWidth, rect.width / 2);
			}
		}

		// Prompt sits at `fixed top-8`; grow the window to fit it so its buttons don't clip (issue #30).
		if (systemLocalePromptRef.current) {
			const rect = systemLocalePromptRef.current.getBoundingClientRect();
			const promptHeight = rect.height || systemLocalePromptRef.current.scrollHeight;
			if (promptHeight > 0) {
				topFromBottom = Math.max(topFromBottom, rect.top + promptHeight);
			}
			halfWidth = Math.max(halfWidth, centerX - rect.left, rect.right - centerX);
		}

		// The software-encoder fallback notice shares the prompt's fixed top-8 slot and needs
		// the same treatment so its buttons stay clickable.
		if (softwareFallbackNoticeRef.current) {
			const rect = softwareFallbackNoticeRef.current.getBoundingClientRect();
			const noticeHeight = rect.height || softwareFallbackNoticeRef.current.scrollHeight;
			if (noticeHeight > 0) {
				topFromBottom = Math.max(topFromBottom, rect.top + noticeHeight);
			}
			halfWidth = Math.max(halfWidth, centerX - rect.left, rect.right - centerX);
		}

		setHudBarHeight((prev) => {
			const next = Math.round(barEl.scrollHeight);
			return Math.abs(prev - next) > 1 ? next : prev;
		});

		const width = Math.max(MIN_WIDTH, Math.ceil(halfWidth * 2) + SIDE_MARGIN);
		const height = Math.ceil(topFromBottom) + TOP_MARGIN;
		if (width === lastHudSizeRef.current.width && height === lastHudSizeRef.current.height) {
			return;
		}
		lastHudSizeRef.current = { width, height };
		window.electronAPI.setHudOverlaySize(width, height);
	}, [trayLayout]);

	// One persistent observer; elements wire themselves up via callback refs as they
	// mount/unmount so measurement re-runs without recreating it or threading mount state through deps.
	const hudResizeObserverRef = useRef<ResizeObserver | null>(null);
	useEffect(() => {
		const observer = new ResizeObserver(() => measureHudSize());
		hudResizeObserverRef.current = observer;
		if (hudBarRef.current) observer.observe(hudBarRef.current);
		if (deviceSelectorRef.current) observer.observe(deviceSelectorRef.current);
		// Backfill refs set before the observer existed (e.g. the notices).
		if (systemLocalePromptRef.current) observer.observe(systemLocalePromptRef.current);
		if (softwareFallbackNoticeRef.current) observer.observe(softwareFallbackNoticeRef.current);
		measureHudSize();
		return () => {
			observer.disconnect();
			hudResizeObserverRef.current = null;
		};
	}, [measureHudSize]);

	const observeHudElement = useCallback(
		<T extends HTMLElement>(el: T | null, ref: React.MutableRefObject<T | null>) => {
			const observer = hudResizeObserverRef.current;
			if (ref.current && observer) observer.unobserve(ref.current);
			ref.current = el;
			if (el && observer) observer.observe(el);
			measureHudSize();
		},
		[measureHudSize],
	);
	const setHudBarEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudBarRef),
		[observeHudElement],
	);
	const setDeviceSelectorEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, deviceSelectorRef),
		[observeHudElement],
	);
	const setSystemLocalePromptEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, systemLocalePromptRef),
		[observeHudElement],
	);
	const setSoftwareFallbackNoticeEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, softwareFallbackNoticeRef),
		[observeHudElement],
	);

	const hudIgnoreMouseEventsRef = useRef<boolean | undefined>(undefined);
	const setHudMouseEventsEnabled = useCallback(
		(enabled: boolean) => {
			const shouldIgnoreMouseEvents = !enabled && !isLinuxHud;
			if (hudIgnoreMouseEventsRef.current === shouldIgnoreMouseEvents) {
				return;
			}
			hudIgnoreMouseEventsRef.current = shouldIgnoreMouseEvents;
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(shouldIgnoreMouseEvents);
		},
		[isLinuxHud],
	);

	useEffect(() => {
		setHudMouseEventsEnabled(false);
		return () => {
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(false);
		};
	}, [setHudMouseEventsEnabled]);

	const defaultSourceName = t("sourceSelector.defaultSourceName");
	const [selectedSource, setSelectedSource] = useState(defaultSourceName);
	const [hasSelectedSource, setHasSelectedSource] = useState(false);
	const [, setRecordPointerDownCount] = useState(0);
	const recordAfterSourceSelectionRef = useRef(false);

	const applySelectedSource = useCallback(
		(source: ProcessedDesktopSource | null) => {
			if (source) {
				setSelectedSource(source.name);
				setHasSelectedSource(true);
				return;
			}

			setSelectedSource(defaultSourceName);
			setHasSelectedSource(false);
		},
		[defaultSourceName],
	);

	useEffect(() => {
		const checkSelectedSource = async () => {
			if (!window.electronAPI) {
				return;
			}

			try {
				const source = await window.electronAPI.getSelectedSource();
				applySelectedSource(source);
			} catch (error) {
				console.warn("Failed to refresh selected source:", error);
			}
		};

		checkSelectedSource();

		const interval = setInterval(checkSelectedSource, 500);
		return () => clearInterval(interval);
	}, [applySelectedSource]);

	useEffect(() => {
		const cleanupSourceChanged = window.electronAPI?.onSelectedSourceChanged?.((source) => {
			applySelectedSource(source);
			if (!recordAfterSourceSelectionRef.current || recording) {
				return;
			}

			recordAfterSourceSelectionRef.current = false;
			toggleRecording();
		});
		const cleanupSelectorClosed = window.electronAPI?.onSourceSelectorClosed?.(() => {
			recordAfterSourceSelectionRef.current = false;
		});

		return () => {
			cleanupSourceChanged?.();
			cleanupSelectorClosed?.();
		};
	}, [applySelectedSource, recording, toggleRecording]);

	const openSourceSelector = async () => {
		if (window.electronAPI) {
			return await openSourceSelectorWithPermissionRetry({
				openSourceSelector: () => window.electronAPI.openSourceSelector(),
				requestScreenAccess: () => window.electronAPI.requestScreenAccess(),
			});
		}

		return { opened: false, reason: "electron-api-unavailable" };
	};

	const handleRecordButtonClick = () => {
		if (saving) {
			return;
		}
		if (!hasSelectedSource && !recording) {
			recordAfterSourceSelectionRef.current = true;
			void openSourceSelector()
				.then((result) => {
					if (!result.opened) {
						recordAfterSourceSelectionRef.current = false;
					}
				})
				.catch(() => {
					recordAfterSourceSelectionRef.current = false;
				});
			return;
		}

		toggleRecording();
	};

	const sendHudOverlayHide = () => {
		if (window.electronAPI && window.electronAPI.hudOverlayHide) {
			window.electronAPI.hudOverlayHide();
		}
	};
	const sendHudOverlayClose = () => {
		if (window.electronAPI && window.electronAPI.hudOverlayClose) {
			window.electronAPI.hudOverlayClose();
		}
	};
	/** Switches the HUD between horizontal and vertical tray layouts. */
	const toggleTrayLayout = () => {
		const nextLayout = trayLayout === "horizontal" ? "vertical" : "horizontal";
		setTrayLayout(nextLayout);
		saveUserPreferences({ trayLayout: nextLayout });
	};

	const toggleMicrophone = () => {
		if (!recording && !saving) {
			setMicrophoneEnabled(!microphoneEnabled);
		}
	};
	const dragLastPositionRef = useRef<{ x: number; y: number } | null>(null);
	const dragAnimationFrameRef = useRef<number | null>(null);
	const pendingDragDeltaRef = useRef({ x: 0, y: 0 });
	const flushHudDragMove = useCallback(() => {
		dragAnimationFrameRef.current = null;
		const { x, y } = pendingDragDeltaRef.current;
		pendingDragDeltaRef.current = { x: 0, y: 0 };
		if (x === 0 && y === 0) return;
		window.electronAPI?.moveHudOverlayBy?.(x, y);
	}, []);
	const scheduleHudDragMove = useCallback(
		(deltaX: number, deltaY: number) => {
			pendingDragDeltaRef.current = {
				x: pendingDragDeltaRef.current.x + deltaX,
				y: pendingDragDeltaRef.current.y + deltaY,
			};

			if (dragAnimationFrameRef.current === null) {
				dragAnimationFrameRef.current = window.requestAnimationFrame(flushHudDragMove);
			}
		},
		[flushHudDragMove],
	);
	const flushPendingHudDragMove = useCallback(() => {
		if (dragAnimationFrameRef.current !== null) {
			window.cancelAnimationFrame(dragAnimationFrameRef.current);
			dragAnimationFrameRef.current = null;
		}
		const { x, y } = pendingDragDeltaRef.current;
		pendingDragDeltaRef.current = { x: 0, y: 0 };
		if (x === 0 && y === 0) return;
		window.electronAPI?.moveHudOverlayBy?.(x, y);
	}, []);
	useEffect(() => {
		return () => {
			if (dragAnimationFrameRef.current !== null) {
				window.cancelAnimationFrame(dragAnimationFrameRef.current);
			}
		};
	}, []);
	const handleHudDragPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.stopPropagation();
		setHudMouseEventsEnabled(true);
		event.currentTarget.setPointerCapture(event.pointerId);
		dragLastPositionRef.current = { x: event.screenX, y: event.screenY };
		isDraggingHudRef.current = true;
	};
	const handleHudDragPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const lastPosition = dragLastPositionRef.current;
		if (!lastPosition) return;
		const deltaX = event.screenX - lastPosition.x;
		const deltaY = event.screenY - lastPosition.y;
		dragLastPositionRef.current = { x: event.screenX, y: event.screenY };
		scheduleHudDragMove(deltaX, deltaY);
	};
	const handleHudDragPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
		dragLastPositionRef.current = null;
		flushPendingHudDragMove();
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		setHudMouseEventsEnabled(false);
		isDraggingHudRef.current = false;
		measureHudSize();
	};

	return (
		// Avoid w-screen/h-screen: 100vw can exceed the inner layout width when scrollbars
		// affect the viewport (Windows), causing a horizontal scrollbar (issue #305).
		<div
			className={`h-full w-full min-w-0 max-w-full overflow-x-hidden overflow-y-hidden bg-transparent ${styles.electronDrag}`}
			onPointerMove={(event) => {
				const target = event.target as HTMLElement | null;
				setHudMouseEventsEnabled(Boolean(target?.closest("[data-hud-interactive='true']")));
			}}
			onPointerLeave={() => {
				setHudMouseEventsEnabled(false);
			}}
		>
			{/* Top-center notices share one fixed column so they stack instead of overlapping */}
			{(systemLocaleSuggestion || softwareEncoderFallbackNoticeVisible) && (
				<div className="fixed top-8 left-1/2 z-30 flex w-[calc(100vw-1rem)] max-w-[520px] -translate-x-1/2 flex-col gap-2">
					{systemLocaleSuggestion && (
						<div
							ref={setSystemLocalePromptEl}
							data-hud-interactive="true"
							className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
						>
							<div className="text-[13px] font-semibold text-white">
								{t("systemLanguagePrompt.title")}
							</div>
							<div className="mt-1 text-[11px] leading-relaxed text-white/75">
								{t("systemLanguagePrompt.description", {
									language: suggestedLanguageName,
								})}
							</div>
							<div className="mt-3 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={dismissSystemLocaleSuggestion}
									className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
								>
									{t("systemLanguagePrompt.keepDefault")}
								</Button>
								<Button
									type="button"
									size="sm"
									onClick={acceptSystemLocaleSuggestion}
									className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
								>
									{t("systemLanguagePrompt.switch", {
										language: suggestedLanguageName,
									})}
								</Button>
							</div>
						</div>
					)}

					{softwareEncoderFallbackNoticeVisible && (
						<div
							ref={setSoftwareFallbackNoticeEl}
							data-hud-interactive="true"
							className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
						>
							<div className="text-[13px] font-semibold text-white">
								{t("softwareEncoderFallback.title")}
							</div>
							<div className="mt-1 text-[11px] leading-relaxed text-white/75">
								{t("softwareEncoderFallback.description")}
							</div>
							<div className="mt-3 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => dismissSoftwareEncoderFallbackNotice(true)}
									className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
								>
									{t("softwareEncoderFallback.dontShowAgain")}
								</Button>
								<Button
									type="button"
									size="sm"
									onClick={() => dismissSoftwareEncoderFallbackNotice()}
									className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
								>
									{t("softwareEncoderFallback.dismiss")}
								</Button>
							</div>
						</div>
					)}
				</div>
			)}

			{/* Device selectors, fixed above HUD bar, viewport-relative, never clipped */}
			{(showMicControls || showWebcamControls) && (
				<div
					ref={setDeviceSelectorEl}
					data-hud-interactive="true"
					className={`fixed left-1/2 -translate-x-1/2 flex items-center gap-2 animate-mic-panel-in ${trayLayout === "vertical" ? "" : "bottom-[68px]"} ${styles.electronNoDrag}`}
					style={
						trayLayout === "vertical"
							? // Sit above the tall vertical tray, anchored to the measured bar
								// height. Matches the offset in measureHudSize.
								{ bottom: hudBarHeight + HUD_DEVICE_POPUP_GAP }
							: undefined
					}
				>
					{/* Mic selector */}
					{showMicControls && (
						<div
							className={`flex h-9 items-center gap-2 overflow-hidden rounded-xl border border-white/[0.18] ${hudFrostedSurface} px-3 py-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.5)] transition-all duration-300 ${!micExpanded ? "opacity-85 grayscale-[0.25]" : "opacity-100"}`}
							onMouseEnter={() => setIsMicHovered(true)}
							onMouseLeave={() => setIsMicHovered(false)}
							onFocus={() => setIsMicFocused(true)}
							onBlur={() => setIsMicFocused(false)}
							style={{
								width: micExpanded ? "240px" : "140px",
								transition: "width 300ms ease",
							}}
						>
							<div className="relative flex-1 min-w-0">
								{!micExpanded && (
									<div className="text-white/60 text-[10px] font-medium truncate">
										{selectedMicLabel}
									</div>
								)}
								<select
									value={microphoneDeviceId || selectedMicId}
									onChange={(e) => {
										const selectedDevice = micDevices.find((d) => d.deviceId === e.target.value);
										setSelectedMicId(e.target.value);
										setMicrophoneDeviceId(e.target.value);
										setMicrophoneDeviceName(selectedDevice?.label);
									}}
									className={`w-full appearance-none bg-white/5 text-white text-[11px] rounded-lg pl-2 pr-6 py-1 border border-white/10 outline-none hover:bg-white/10 transition-colors cursor-pointer ${!micExpanded ? "sr-only" : ""}`}
								>
									{micDevices.map((device) => (
										<option key={device.deviceId} value={device.deviceId} className="bg-[#1c1c24]">
											{device.label}
										</option>
									))}
								</select>
								{micExpanded && (
									<ChevronDown
										size={12}
										className="absolute right-1.5 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none"
									/>
								)}
							</div>
							<AudioLevelMeter
								level={level}
								className={`${micExpanded ? "w-16" : "w-8"} h-2 transition-all duration-300`}
							/>
						</div>
					)}

					{/* Webcam selector */}
					{showWebcamControls && (
						<div
							className={`flex h-9 items-center gap-2 overflow-hidden rounded-xl border border-white/[0.18] ${hudFrostedSurface} px-3 py-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.5)] transition-all duration-300 ${!webcamExpanded ? "opacity-85 grayscale-[0.25]" : "opacity-100"}`}
							onMouseEnter={() => setIsWebcamHovered(true)}
							onMouseLeave={() => setIsWebcamHovered(false)}
							onFocus={() => setIsWebcamFocused(true)}
							onBlur={() => setIsWebcamFocused(false)}
							style={{
								width: webcamExpanded ? "240px" : "140px",
								transition: "width 300ms ease",
							}}
						>
							<div className="relative flex-1 min-w-0">
								{!webcamExpanded && (
									<div className="text-white/60 text-[10px] font-medium truncate">
										{selectedCameraLabel}
									</div>
								)}
								{webcamExpanded &&
									(isCameraDevicesLoading ? (
										<span className="text-white/40 text-[10px] italic">
											{t("webcam.searching")}
										</span>
									) : cameraDevicesError ? (
										<span className="text-white/40 text-[10px] italic">
											{t("webcam.unavailable")}
										</span>
									) : cameraDevices.length === 0 ? (
										<span className="text-white/40 text-[10px] italic">
											{t("webcam.noneFound")}
										</span>
									) : (
										<>
											<select
												value={webcamDeviceId || selectedCameraId}
												onChange={(e) => {
													const device = cameraDevices.find(
														(item) => item.deviceId === e.target.value,
													);
													setSelectedCameraId(e.target.value);
													setWebcamDeviceId(e.target.value);
													setWebcamDeviceName(device?.label);
												}}
												className="w-full appearance-none bg-white/5 text-white text-[11px] rounded-lg pl-2 pr-6 py-1 border border-white/10 outline-none hover:bg-white/10 transition-colors cursor-pointer"
											>
												{cameraDevices.map((device) => (
													<option
														key={device.deviceId}
														value={device.deviceId}
														className="bg-[#1c1c24]"
													>
														{device.label}
													</option>
												))}
											</select>
											<ChevronDown
												size={12}
												className="absolute right-1.5 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none"
											/>
										</>
									))}
								{(!webcamExpanded || cameraDevices.length === 0) && (
									<select
										value={webcamDeviceId || selectedCameraId}
										onChange={(e) => {
											const device = cameraDevices.find((item) => item.deviceId === e.target.value);
											setSelectedCameraId(e.target.value);
											setWebcamDeviceId(e.target.value);
											setWebcamDeviceName(device?.label);
										}}
										className="sr-only"
									>
										{cameraDevices.map((device) => (
											<option key={device.deviceId} value={device.deviceId}>
												{device.label}
											</option>
										))}
									</select>
								)}
							</div>
						</div>
					)}
				</div>
			)}

			{/* HUD bar, fixed at bottom center, viewport-relative, never moves */}
			<div
				ref={setHudBarEl}
				data-hud-interactive="true"
				data-tray-layout={trayLayout}
				className={`fixed bottom-5 left-1/2 -translate-x-1/2 flex font-sans antialiased squircle rounded-[17px] border border-white/[0.18] ${hudFrostedSurface} shadow-[0_16px_50px_rgba(0,0,0,0.55),0_3px_10px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.14)] ${
					trayLayout === "vertical"
						? "max-h-[calc(100vh-2.5rem)] flex-col items-center gap-1 overflow-y-auto px-1 py-1.5"
						: "items-center gap-1.5 px-2 py-1.5"
				}`}
				onPointerEnter={() => setHudMouseEventsEnabled(true)}
				onPointerDown={() => setHudMouseEventsEnabled(true)}
				onMouseEnter={() => setHudMouseEventsEnabled(true)}
				onMouseLeave={() => setHudMouseEventsEnabled(false)}
			>
				{/* Drag handle */}
				<div
					data-testid="hud-drag-handle"
					className={`flex ${trayLayout === "vertical" ? "h-6 w-8" : "h-8 w-7"} cursor-grab items-center justify-center active:cursor-grabbing ${styles.electronNoDrag}`}
					onPointerDown={handleHudDragPointerDown}
					onPointerMove={handleHudDragPointerMove}
					onPointerUp={handleHudDragPointerEnd}
					onPointerCancel={handleHudDragPointerEnd}
				>
					{getIcon("drag", "text-white/30")}
				</div>

				<Tooltip
					content={
						trayLayout === "horizontal"
							? t("tooltips.useVerticalTray")
							: t("tooltips.useHorizontalTray")
					}
				>
					<button
						data-testid="launch-tray-layout-button"
						type="button"
						aria-label={
							trayLayout === "horizontal"
								? t("tooltips.useVerticalTray")
								: t("tooltips.useHorizontalTray")
						}
						aria-pressed={trayLayout === "vertical"}
						className={`${hudIconBtnClasses} ${styles.electronNoDrag}`}
						onClick={toggleTrayLayout}
					>
						{trayLayout === "horizontal" ? (
							<Columns3 size={ICON_SIZE} className="text-white/60" />
						) : (
							<Rows3 size={ICON_SIZE} className="text-white/60" />
						)}
					</button>
				</Tooltip>

				{/* Source selector */}
				<button
					data-testid="launch-source-selector-button"
					className={`${hudGroupClasses} h-8 ${trayLayout === "vertical" ? "w-8 justify-center px-0" : "px-2.5"} ${styles.electronNoDrag}`}
					onClick={openSourceSelector}
					disabled={recording || saving}
					title={selectedSource}
					aria-label={selectedSource}
				>
					{getIcon("monitor", "text-white/80")}
					<span
						className={`${trayLayout === "vertical" ? "sr-only" : "max-w-[86px]"} truncate text-[11px] font-medium text-white/75`}
					>
						{selectedSource}
					</span>
				</button>

				{/* Audio controls group */}
				<div
					className={`${hudGroupClasses} ${trayLayout === "vertical" ? "flex-col py-1" : ""} ${styles.electronNoDrag}`}
				>
					<button
						data-testid="launch-system-audio-button"
						className={`${hudIconBtnClasses} ${systemAudioEnabled ? hudToggleActiveClasses : ""}`}
						onClick={() => !(recording || saving) && setSystemAudioEnabled(!systemAudioEnabled)}
						disabled={recording || saving}
						title={
							systemAudioEnabled ? t("audio.disableSystemAudio") : t("audio.enableSystemAudio")
						}
					>
						{systemAudioEnabled
							? getIcon("volumeOn", "text-brand")
							: getIcon("volumeOff", "text-white/40")}
					</button>
					<button
						data-testid="launch-microphone-button"
						className={`${hudIconBtnClasses} ${microphoneEnabled ? hudToggleActiveClasses : ""}`}
						onClick={toggleMicrophone}
						disabled={recording || saving}
						title={microphoneEnabled ? t("audio.disableMicrophone") : t("audio.enableMicrophone")}
						onPointerDown={() => {
							setRecordPointerDownCount((count) => count + 1);
						}}
					>
						{microphoneEnabled
							? getIcon("micOn", "text-brand")
							: getIcon("micOff", "text-white/40")}
					</button>
					<button
						data-testid="launch-webcam-button"
						className={`${hudIconBtnClasses} ${webcamEnabled ? hudToggleActiveClasses : ""}`}
						onClick={async () => {
							await setWebcamEnabled(!webcamEnabled);
						}}
						disabled={recording || saving}
						title={webcamEnabled ? t("webcam.disableWebcam") : t("webcam.enableWebcam")}
					>
						{webcamEnabled
							? getIcon("webcamOn", "text-brand")
							: getIcon("webcamOff", "text-white/40")}
					</button>
					{supportsCursorModeToggle && (
						<button
							data-testid="launch-cursor-mode-button"
							className={`${hudIconBtnClasses} ${
								cursorCaptureMode === "editable-overlay" ? hudToggleActiveClasses : ""
							}`}
							onClick={() =>
								!(recording || saving) &&
								setCursorCaptureMode(
									cursorCaptureMode === "editable-overlay" ? "system" : "editable-overlay",
								)
							}
							disabled={recording || saving}
							title={
								cursorCaptureMode === "editable-overlay"
									? t("cursor.useSystemCursor")
									: t("cursor.useEditableCursor")
							}
						>
							{getIcon(
								"cursor",
								cursorCaptureMode === "editable-overlay" ? "text-brand" : "text-white/40",
							)}
						</button>
					)}
				</div>

				{/* Record/Stop group */}
				<Tooltip
					content={
						saving
							? t("recording.saving")
							: hasSelectedSource || recording
								? selectedSource
								: t("recording.selectSource")
					}
				>
					<button
						data-testid="launch-record-button"
						disabled={saving}
						className={`flex items-center justify-center rounded-full p-2 transition-[min-width,background-color] duration-150 ${recording || saving ? "min-w-[78px]" : "min-w-[36px]"} ${trayLayout === "vertical" ? "min-h-9" : ""} ${styles.electronNoDrag} ${
							saving
								? "bg-white/[0.06] opacity-60 cursor-not-allowed"
								: recording
									? paused
										? "bg-amber-500/10 hover:bg-amber-500/15"
										: "bg-red-500/12 hover:bg-red-500/16"
									: hasSelectedSource
										? "bg-white/[0.08] ring-1 ring-inset ring-white/[0.12] hover:bg-white/[0.12]"
										: "bg-white/[0.035] hover:bg-white/[0.08]"
						}`}
						onClick={handleRecordButtonClick}
						title={
							saving
								? t("recording.saving")
								: hasSelectedSource || recording
									? selectedSource
									: t("recording.selectSource")
						}
						aria-label={
							saving
								? t("recording.saving")
								: hasSelectedSource || recording
									? selectedSource
									: t("recording.selectSource")
						}
						style={{ flex: "0 0 auto" }}
					>
						<div
							className={`flex items-center justify-center ${recording || saving ? "gap-1.5" : ""}`}
						>
							{saving ? (
								<div className="animate-spin flex items-center justify-center">
									{getIcon("spinner", "text-white/80")}
								</div>
							) : recording ? (
								getIcon(
									"stop",
									paused ? "fill-current text-amber-400" : "fill-current text-red-500",
								)
							) : (
								getIcon(
									"record",
									hasSelectedSource ? "fill-current text-red-500" : "fill-current text-white/30",
								)
							)}
							{saving && (
								<span className="text-white/80 text-xs font-semibold select-none">
									{t("recording.saving")}
								</span>
							)}
							{recording && (
								<span
									className={`${paused ? "text-amber-400" : "text-red-400"} inline-block w-[34px] text-left text-xs font-semibold tabular-nums`}
								>
									{formatTimePadded(elapsedSeconds)}
								</span>
							)}
						</div>
					</button>
				</Tooltip>

				{recording && (
					<div
						className={`flex items-center gap-0.5 ${trayLayout === "vertical" ? "flex-col" : ""} ${styles.electronNoDrag}`}
					>
						{canPauseRecording && (
							<Tooltip
								content={paused ? t("tooltips.resumeRecording") : t("tooltips.pauseRecording")}
							>
								<button
									className={hudAuxIconBtnClasses}
									onClick={() => !saving && togglePaused()}
									disabled={saving}
								>
									{getIcon(
										paused ? "resume" : "pause",
										paused ? "text-amber-400" : "text-white/60",
									)}
								</button>
							</Tooltip>
						)}
						<Tooltip content={t("tooltips.restartRecording")}>
							<button
								className={hudAuxIconBtnClasses}
								onClick={() => !saving && restartRecording()}
								disabled={saving}
							>
								{getIcon("restart", "text-white/60")}
							</button>
						</Tooltip>
						<Tooltip content={t("tooltips.cancelRecording")}>
							<button
								className={hudAuxIconBtnClasses}
								onClick={() => !saving && cancelRecording()}
								disabled={saving}
							>
								{getIcon("cancel", "text-white/60")}
							</button>
						</Tooltip>
					</div>
				)}

				{!isLinuxHud && (
					<Tooltip content={t("tooltips.openNotes")}>
						<button
							type="button"
							aria-label={t("tooltips.openNotes")}
							disabled={saving}
							className={`${hudIconBtnClasses} ${styles.electronNoDrag} ${saving ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
							onClick={() => !saving && window.electronAPI.openNotes()}
						>
							<NotepadText size={ICON_SIZE} className="text-white/60" />
						</button>
					</Tooltip>
				)}

				{!recording && (
					<Tooltip content={t("tooltips.openStudio")}>
						<button
							data-testid="launch-open-studio-button"
							disabled={saving}
							className={`${hudIconBtnClasses} ${styles.electronNoDrag} ${saving ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
							onClick={() => !saving && window.electronAPI.switchToEditor()}
						>
							<Clapperboard size={ICON_SIZE} className="text-white/60" />
						</button>
					</Tooltip>
				)}

				{/* Right sidebar controls */}
				<div
					className={`${trayLayout === "vertical" ? hudSidebarVerticalClasses : hudSidebarClasses} ${styles.electronNoDrag}`}
				>
					{/* Window controls */}
					<div
						className={`flex items-center gap-0.5 ${trayLayout === "vertical" ? "flex-col" : ""}`}
					>
						<button
							className={windowBtnClasses}
							title={t("tooltips.hideHUD")}
							onClick={sendHudOverlayHide}
							disabled={saving}
						>
							{getIcon("minimize", "text-white")}
						</button>
						<button
							className={windowBtnClasses}
							title={t("tooltips.closeApp")}
							onClick={sendHudOverlayClose}
							disabled={saving}
						>
							{getIcon("close", "text-white")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
