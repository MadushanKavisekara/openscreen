import { Download, Film, Image, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import {
	calculateEffectiveSourceDimensions,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
} from "@/lib/exporter";
import { cn } from "@/lib/utils";
import { getTestId } from "@/utils/getTestId";
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_GIF_SETTINGS } from "./editorDefaults";
import type { CropRegion } from "./types";

/** Short-side targets each MP4 quality preset renders at. */
const MP4_EXPORT_SHORT_SIDES = {
	medium: 720,
	good: 1080,
} as const;

function formatSourceDimensions(videoElement?: HTMLVideoElement | null, cropRegion?: CropRegion) {
	const width = videoElement?.videoWidth ?? 0;
	const height = videoElement?.videoHeight ?? 0;

	if (width <= 0 || height <= 0) {
		return null;
	}

	const dimensions = calculateEffectiveSourceDimensions(width, height, cropRegion);
	return { ...dimensions, shortSide: Math.min(dimensions.width, dimensions.height) };
}

interface ExportSettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	/** Starts the export. The caller shows the progress dialog. */
	onExport: () => void;
	videoElement?: HTMLVideoElement | null;
	cropRegion?: CropRegion;
	exportFormat?: ExportFormat;
	onExportFormatChange?: (format: ExportFormat) => void;
	exportQuality?: ExportQuality;
	onExportQualityChange?: (quality: ExportQuality) => void;
	gifFrameRate?: GifFrameRate;
	onGifFrameRateChange?: (rate: GifFrameRate) => void;
	gifSizePreset?: GifSizePreset;
	onGifSizePresetChange?: (preset: GifSizePreset) => void;
	gifLoop?: boolean;
	onGifLoopChange?: (loop: boolean) => void;
	gifOutputDimensions?: { width: number; height: number };
	/** A finished render still waiting for the user to pick a save location. */
	unsavedExport?: {
		arrayBuffer: ArrayBuffer;
		fileName: string;
		format: string;
	} | null;
	onSaveUnsavedExport?: () => void;
}

/**
 * Pre-export overlay: pick format and quality before the render starts. These controls
 * used to live in a tab of the settings rail; the editor now reaches them from the
 * title bar's Export action instead.
 */
export function ExportSettingsDialog({
	isOpen,
	onClose,
	onExport,
	videoElement,
	cropRegion,
	exportFormat = DEFAULT_EXPORT_SETTINGS.format,
	onExportFormatChange,
	exportQuality = DEFAULT_EXPORT_SETTINGS.quality,
	onExportQualityChange,
	gifFrameRate = DEFAULT_GIF_SETTINGS.frameRate,
	onGifFrameRateChange,
	gifSizePreset = DEFAULT_GIF_SETTINGS.sizePreset,
	onGifSizePresetChange,
	gifLoop = DEFAULT_GIF_SETTINGS.loop,
	onGifLoopChange,
	gifOutputDimensions = DEFAULT_GIF_SETTINGS.outputDimensions,
	unsavedExport,
	onSaveUnsavedExport,
}: ExportSettingsDialogProps) {
	const t = useScopedT("settings");
	const tc = useScopedT("common");

	if (!isOpen) return null;

	const sourceDimensions = formatSourceDimensions(videoElement, cropRegion);

	return (
		<>
			<div
				className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 animate-in fade-in duration-200"
				onClick={onClose}
			/>
			<div className="fixed top-1/2 left-1/2 z-[60] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-[#09090b] p-6 shadow-2xl animate-in zoom-in-95 duration-200">
				<div className="mb-5 flex items-center justify-between">
					<h2 className="text-base font-semibold text-slate-200">{tc("actions.export")}</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label={tc("actions.close")}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="mb-3 flex items-center gap-2">
					<button
						data-testid={getTestId("mp4-format-button")}
						onClick={() => onExportFormatChange?.("mp4")}
						className={cn(
							"flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium",
							exportFormat === "mp4"
								? "bg-brand/10 border-brand/50 text-white"
								: "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200",
						)}
					>
						<Film className="w-3.5 h-3.5" />
						{t("exportFormat.mp4")}
					</button>
					<button
						data-testid={getTestId("gif-format-button")}
						onClick={() => onExportFormatChange?.("gif")}
						className={cn(
							"flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium",
							exportFormat === "gif"
								? "bg-brand/10 border-brand/50 text-white"
								: "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200",
						)}
					>
						<Image className="w-3.5 h-3.5" />
						{t("exportFormat.gif")}
					</button>
				</div>

				{exportFormat === "mp4" && (
					<div className="mb-3 space-y-1.5">
						{sourceDimensions && (
							<div className="flex items-center justify-between px-0.5 text-[10px] leading-none text-slate-500">
								<span>{t("exportQuality.title")}</span>
								<span>
									Source {sourceDimensions.width}x{sourceDimensions.height}
								</span>
							</div>
						)}
						<div className="bg-white/5 border border-white/5 p-0.5 w-full grid grid-cols-3 h-9 rounded-lg">
							<button
								onClick={() => onExportQualityChange?.("medium")}
								className={cn(
									"rounded-md transition-all text-[10px] font-medium flex flex-col items-center justify-center leading-none gap-0.5",
									exportQuality === "medium"
										? "bg-white text-black"
										: "text-slate-400 hover:text-slate-200",
								)}
							>
								<span>{t("exportQuality.low")}</span>
								{sourceDimensions && sourceDimensions.shortSide < MP4_EXPORT_SHORT_SIDES.medium && (
									<span
										className={cn(
											"text-[8px] font-medium",
											exportQuality === "medium" ? "text-black/55" : "text-amber-300/80",
										)}
									>
										Upscale
									</span>
								)}
							</button>
							<button
								onClick={() => onExportQualityChange?.("good")}
								className={cn(
									"rounded-md transition-all text-[10px] font-medium flex flex-col items-center justify-center leading-none gap-0.5",
									exportQuality === "good"
										? "bg-white text-black"
										: "text-slate-400 hover:text-slate-200",
								)}
							>
								<span>{t("exportQuality.medium")}</span>
								{sourceDimensions && sourceDimensions.shortSide < MP4_EXPORT_SHORT_SIDES.good && (
									<span
										className={cn(
											"text-[8px] font-medium",
											exportQuality === "good" ? "text-black/55" : "text-amber-300/80",
										)}
									>
										Upscale
									</span>
								)}
							</button>
							<button
								onClick={() => onExportQualityChange?.("source")}
								className={cn(
									"rounded-md transition-all text-[10px] font-medium flex flex-col items-center justify-center leading-none gap-0.5",
									exportQuality === "source"
										? "bg-white text-black"
										: "text-slate-400 hover:text-slate-200",
								)}
							>
								<span>{t("exportQuality.high")}</span>
								{sourceDimensions && (
									<span
										className={cn(
											"text-[8px] font-medium",
											exportQuality === "source" ? "text-black/55" : "text-slate-500",
										)}
									>
										{sourceDimensions.shortSide}p
									</span>
								)}
							</button>
						</div>
					</div>
				)}

				{exportFormat === "gif" && (
					<div className="mb-3 space-y-2">
						<div className="flex items-center gap-2">
							<div className="flex-1 bg-white/5 border border-white/5 p-0.5 grid grid-cols-4 h-7 rounded-lg">
								{GIF_FRAME_RATES.map((rate) => (
									<button
										key={rate.value}
										onClick={() => onGifFrameRateChange?.(rate.value)}
										className={cn(
											"rounded-md transition-all text-[10px] font-medium",
											gifFrameRate === rate.value
												? "bg-white text-black"
												: "text-slate-400 hover:text-slate-200",
										)}
									>
										{rate.value}
									</button>
								))}
							</div>
							<div className="flex-1 bg-white/5 border border-white/5 p-0.5 grid grid-cols-3 h-7 rounded-lg">
								{Object.entries(GIF_SIZE_PRESETS).map(([key, _preset]) => (
									<button
										key={key}
										data-testid={getTestId(`gif-size-button-${key}`)}
										onClick={() => onGifSizePresetChange?.(key as GifSizePreset)}
										className={cn(
											"rounded-md transition-all text-[10px] font-medium",
											gifSizePreset === key
												? "bg-white text-black"
												: "text-slate-400 hover:text-slate-200",
										)}
									>
										{key === "original" ? "Orig" : key.charAt(0).toUpperCase() + key.slice(1, 3)}
									</button>
								))}
							</div>
						</div>
						<div className="flex items-center justify-between">
							<span className="text-[10px] text-slate-500">
								{gifOutputDimensions.width} × {gifOutputDimensions.height}px
							</span>
							<div className="flex items-center gap-2">
								<span className="text-[10px] text-slate-400">{t("gifSettings.loop")}</span>
								<Switch
									checked={gifLoop}
									onCheckedChange={onGifLoopChange}
									className="data-[state=checked]:bg-brand scale-75"
								/>
							</div>
						</div>
					</div>
				)}

				{unsavedExport && (
					<Button
						type="button"
						size="lg"
						onClick={onSaveUnsavedExport}
						className="w-full mb-2 py-5 text-sm font-semibold flex items-center justify-center gap-2 bg-indigo-500 text-white rounded-xl shadow-lg shadow-indigo-500/20 hover:bg-indigo-500/90 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
					>
						<Download className="w-4 h-4" />
						{t("export.chooseSaveLocation")}
					</Button>
				)}
				<Button
					data-testid={getTestId("export-button")}
					type="button"
					size="lg"
					onClick={() => {
						onClose();
						onExport();
					}}
					className="w-full py-5 text-sm font-semibold flex items-center justify-center gap-2 bg-brand text-white rounded-xl shadow-lg shadow-brand/20 hover:bg-[#5B93FF] hover:scale-[1.01] active:scale-[0.99] transition-all duration-200"
				>
					<Download className="w-4 h-4" />
					{exportFormat === "gif" ? t("export.gifButton") : t("export.videoButton")}
				</Button>
			</div>
		</>
	);
}

export default ExportSettingsDialog;
