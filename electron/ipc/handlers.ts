import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

import type { DesktopCapturerSource } from "electron";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	dialog,
	ipcMain,
	screen,
	shell,
	systemPreferences,
} from "electron";
import {
	type CursorTelemetryPoint,
	createCursorTelemetryBuffer,
} from "../../src/lib/cursorTelemetryBuffer";
import type { NativeWindowsRecordingRequest } from "../../src/lib/nativeWindowsRecording";
import {
	type CursorCaptureMode,
	normalizeCursorCaptureMode,
	normalizeProjectMedia,
	normalizeRecordingSession,
	type ProjectMedia,
	type RecordingSession,
	type StoreRecordedSessionInput,
} from "../../src/lib/recordingSession";
import type { CursorRecordingData, CursorRecordingSample } from "../../src/native/contracts";
import { mainT } from "../i18n";
import { RECORDINGS_DIR } from "../main";
import { WindowsNativeRecordingSession } from "../native-bridge/cursor/recording/windowsNativeRecordingSession";

const PROJECT_FILE_EXTENSION = "openscreen";
const SHORTCUTS_FILE = path.join(app.getPath("userData"), "shortcuts.json");
const RECORDING_SESSION_SUFFIX = ".session.json";
const ALLOWED_IMPORT_VIDEO_EXTENSIONS = new Set([".webm", ".mp4", ".mov", ".avi", ".mkv"]);

/**
 * Paths explicitly approved by the user via file picker dialogs or project loads.
 * These are added at runtime when the user selects files from outside the default directories.
 */
const approvedPaths = new Set<string>();

function approveFilePath(filePath: string): void {
	approvedPaths.add(path.resolve(filePath));
}

function getAllowedReadDirs(): string[] {
	return [RECORDINGS_DIR];
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	if (approvedPaths.has(resolved)) return true;
	return getAllowedReadDirs().some((dir) => isPathWithinDir(resolved, dir));
}

/**
 * Helper function to build dialog options with a parent window only when it's valid.
 * This prevents passing stale or destroyed BrowserWindow references to dialog calls.
 */
function buildDialogOptions<T extends Electron.OpenDialogOptions | Electron.SaveDialogOptions>(
	baseOptions: T,
	parentWindow: BrowserWindow | null,
): T & { parent?: BrowserWindow } {
	const mainWindow = parentWindow;
	if (mainWindow && !mainWindow.isDestroyed()) {
		return { ...baseOptions, parent: mainWindow };
	}
	return baseOptions;
}

function hasAllowedImportVideoExtension(filePath: string): boolean {
	return ALLOWED_IMPORT_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function approveReadableVideoPath(
	filePath?: string | null,
	trustedDirs?: string[],
): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (!normalizedPath) {
		return null;
	}

	if (isPathAllowed(normalizedPath)) {
		return normalizedPath;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath)) {
		return null;
	}

	// When called with trustedDirs (e.g. from project load), only auto-approve
	// paths within those directories. This prevents malicious project files from
	// approving reads to arbitrary filesystem locations.
	if (trustedDirs) {
		const resolved = path.resolve(normalizedPath);
		const withinTrusted = trustedDirs.some((dir) => isPathWithinDir(resolved, dir));
		if (!withinTrusted) {
			return null;
		}
	}

	try {
		const stats = await fs.stat(normalizedPath);
		if (!stats.isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	approveFilePath(normalizedPath);
	return normalizedPath;
}

function resolveRecordingOutputPath(fileName: string): string {
	const trimmed = fileName.trim();
	if (!trimmed) {
		throw new Error("Invalid recording file name");
	}

	const parsedPath = path.parse(trimmed);
	const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === "..");
	const isNestedPath =
		parsedPath.dir !== "" ||
		path.isAbsolute(trimmed) ||
		trimmed.includes("/") ||
		trimmed.includes("\\");
	if (hasTraversalSegments || isNestedPath || parsedPath.base !== trimmed) {
		throw new Error("Recording file name must not contain path segments");
	}

	return path.join(RECORDINGS_DIR, parsedPath.base);
}

async function getApprovedProjectSession(
	project: unknown,
	projectFilePath?: string,
): Promise<RecordingSession | null> {
	if (!project || typeof project !== "object") {
		return null;
	}

	const rawProject = project as { media?: unknown; videoPath?: unknown };
	const media: ProjectMedia | null =
		normalizeProjectMedia(rawProject.media) ??
		(typeof rawProject.videoPath === "string"
			? {
					screenVideoPath: normalizeVideoSourcePath(rawProject.videoPath) ?? rawProject.videoPath,
				}
			: null);

	if (!media) {
		return null;
	}

	// Only auto-approve media paths within the project's directory or RECORDINGS_DIR.
	// This prevents crafted project files from approving reads to arbitrary locations.
	const trustedDirs = [RECORDINGS_DIR];
	if (projectFilePath) {
		trustedDirs.push(path.dirname(path.resolve(projectFilePath)));
	}

	const screenVideoPath = await approveReadableVideoPath(media.screenVideoPath, trustedDirs);
	if (!screenVideoPath) {
		throw new Error("Project references an invalid or unsupported screen video path");
	}

	const webcamVideoPath = media.webcamVideoPath
		? await approveReadableVideoPath(media.webcamVideoPath, trustedDirs)
		: undefined;
	if (media.webcamVideoPath && !webcamVideoPath) {
		throw new Error("Project references an invalid or unsupported webcam video path");
	}

	return webcamVideoPath
		? { screenVideoPath, webcamVideoPath, createdAt: Date.now() }
		: { screenVideoPath, createdAt: Date.now() };
}

type SelectedSource = {
	name: string;
	[key: string]: unknown;
};

let selectedSource: SelectedSource | null = null;
let selectedDesktopSource: DesktopCapturerSource | null = null;
let lastEnumeratedSources = new Map<string, DesktopCapturerSource>();
let currentProjectPath: string | null = null;
let currentRecordingSession: RecordingSession | null = null;

/**
 * Returns the exact DesktopCapturerSource chosen during enumeration. On Windows
 * this lets Electron's display-media handler use the selected source without
 * opening the OS picker or changing non-Windows capture behavior.
 */
export function getSelectedDesktopSource(): DesktopCapturerSource | null {
	return selectedDesktopSource;
}

function normalizePath(filePath: string) {
	return path.resolve(filePath);
}

function normalizeVideoSourcePath(videoPath?: string | null): string | null {
	if (typeof videoPath !== "string") {
		return null;
	}

	const trimmed = videoPath.trim();
	if (!trimmed) {
		return null;
	}

	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			// Fall through and keep best-effort string path below.
		}
	}

	return trimmed;
}

function isTrustedProjectPath(filePath?: string | null) {
	if (!filePath || !currentProjectPath) {
		return false;
	}
	return normalizePath(filePath) === normalizePath(currentProjectPath);
}

function setCurrentRecordingSessionState(session: RecordingSession | null) {
	currentRecordingSession = session;
}

function getSessionManifestPathForVideo(videoPath: string) {
	const parsed = path.parse(videoPath);
	const baseName = parsed.name.endsWith("-webcam")
		? parsed.name.slice(0, -"-webcam".length)
		: parsed.name;
	return path.join(parsed.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

async function loadRecordedSessionForVideoPath(
	videoPath: string,
): Promise<RecordingSession | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	try {
		const manifestPath = getSessionManifestPathForVideo(normalizedVideoPath);
		const content = await fs.readFile(manifestPath, "utf-8");
		const session = normalizeRecordingSession(JSON.parse(content));
		if (!session) {
			return null;
		}

		const normalizedSession: RecordingSession = {
			...session,
			screenVideoPath: normalizeVideoSourcePath(session.screenVideoPath) ?? session.screenVideoPath,
			...(session.webcamVideoPath
				? {
						webcamVideoPath:
							normalizeVideoSourcePath(session.webcamVideoPath) ?? session.webcamVideoPath,
					}
				: {}),
		};

		const targetPath = normalizePath(normalizedVideoPath);
		const screenMatches = normalizePath(normalizedSession.screenVideoPath) === targetPath;
		const webcamMatches = normalizedSession.webcamVideoPath
			? normalizePath(normalizedSession.webcamVideoPath) === targetPath
			: false;

		return screenMatches || webcamMatches ? normalizedSession : null;
	} catch {
		return null;
	}
}

async function storeRecordedSessionFiles(payload: StoreRecordedSessionInput) {
	const createdAt =
		typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
			? payload.createdAt
			: Date.now();
	const cursorCaptureMode = normalizeCursorCaptureMode(payload.cursorCaptureMode);
	const screenVideoPath = resolveRecordingOutputPath(payload.screen.fileName);
	await fs.writeFile(screenVideoPath, Buffer.from(payload.screen.videoData));

	let webcamVideoPath: string | undefined;
	if (payload.webcam) {
		webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
		await fs.writeFile(webcamVideoPath, Buffer.from(payload.webcam.videoData));
	}

	const session: RecordingSession = webcamVideoPath
		? {
				screenVideoPath,
				webcamVideoPath,
				createdAt,
				...(cursorCaptureMode ? { cursorCaptureMode } : {}),
			}
		: { screenVideoPath, createdAt, ...(cursorCaptureMode ? { cursorCaptureMode } : {}) };
	setCurrentRecordingSessionState(session);
	currentProjectPath = null;

	const telemetryPath = `${screenVideoPath}.cursor.json`;
	const pendingBatch = cursorTelemetryBuffer.takeNextBatch();
	const pendingClicks = takeCursorClickTimestamps();
	if ((pendingBatch && pendingBatch.samples.length > 0) || pendingClicks.length > 0) {
		try {
			await fs.writeFile(
				telemetryPath,
				JSON.stringify(
					{
						version: CURSOR_TELEMETRY_VERSION,
						samples: pendingBatch?.samples ?? [],
						clicks: pendingClicks,
					},
					null,
					2,
				),
				"utf-8",
			);
		} catch (err) {
			if (pendingBatch) cursorTelemetryBuffer.prependBatch(pendingBatch);
			throw err;
		}
	}

	const sessionManifestPath = path.join(
		RECORDINGS_DIR,
		`${path.parse(payload.screen.fileName).name}${RECORDING_SESSION_SUFFIX}`,
	);
	await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");

	return {
		success: true,
		path: screenVideoPath,
		session,
		message: "Recording session stored successfully",
	};
}

const CURSOR_TELEMETRY_VERSION = 1;
const CURSOR_SAMPLE_INTERVAL_MS = 100;
const MAX_CURSOR_SAMPLES = 60 * 60 * 10; // 1 hour @ 10Hz
const NATIVE_CURSOR_SAMPLE_INTERVAL_MS = 33;
const MAX_NATIVE_CURSOR_SAMPLES = 60 * 60 * 30; // 1 hour @ ~30Hz

let cursorCaptureInterval: NodeJS.Timeout | null = null;
let cursorCaptureStartTimeMs = 0;
const cursorTelemetryBuffer = createCursorTelemetryBuffer({
	maxActiveSamples: MAX_CURSOR_SAMPLES,
});
let nativeCursorRecordingSession: WindowsNativeRecordingSession | null = null;
let pendingNativeCursorRecordingData: CursorRecordingData | null = null;
let nativeWindowsCaptureProcess: ChildProcessWithoutNullStreams | null = null;
let nativeWindowsCaptureOutput = "";
let nativeWindowsCaptureTargetPath: string | null = null;
let nativeWindowsCaptureWebcamTargetPath: string | null = null;
let nativeWindowsCaptureRecordingId: number | null = null;
let nativeWindowsCaptureCursorMode: CursorCaptureMode = "editable-overlay";
let nativeWindowsCursorOffsetMs = 0;
const NATIVE_WINDOWS_CAPTURE_STOP_TIMEOUT_MS = 15_000;

// Mouse click timestamps (macOS only — uiohook-napi behind Accessibility).
const MAX_CURSOR_CLICKS = 60 * 60 * 60; // ~1 click/sec for an hour
let cursorClickTimestampsMs: number[] = [];
let uioHookInstance: {
	start: () => void;
	stop: () => void;
	on: (...a: unknown[]) => void;
	off?: (...a: unknown[]) => void;
	removeListener?: (...a: unknown[]) => void;
} | null = null;
let uioHookMouseDownHandler: ((event: { time?: number }) => void) | null = null;
let uioHookFailureLogged = false;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function loadUioHookForClicks(): typeof uioHookInstance {
	try {
		// Dynamic require + try/catch so a broken native binary doesn't crash startup.
		const mod = nodeRequire("uiohook-napi");
		const candidate = mod.uIOhook ?? mod.default?.uIOhook ?? mod.uiohook ?? mod.default;
		if (candidate && typeof candidate.start === "function" && typeof candidate.on === "function") {
			return candidate;
		}
		return null;
	} catch (error) {
		if (!uioHookFailureLogged) {
			uioHookFailureLogged = true;
			console.warn("[clickCapture] uiohook-napi unavailable:", error);
		}
		return null;
	}
}

function startClickCapture() {
	if (process.platform !== "darwin") return;
	if (uioHookInstance) return;

	// Passive check — the prompt fires from the renderer when the user toggles
	// "Only on clicks" so it doesn't stack with the screen-recording prompt.
	try {
		if (!systemPreferences.isTrustedAccessibilityClient(false)) {
			if (!uioHookFailureLogged) {
				uioHookFailureLogged = true;
				console.warn(
					"[clickCapture] Accessibility permission not granted — click capture disabled.",
				);
			}
			return;
		}
	} catch {
		// fall through; uiohook will fail defensively below
	}

	const hook = loadUioHookForClicks();
	if (!hook) return;

	uioHookMouseDownHandler = (event) => {
		const elapsed = Math.max(0, Date.now() - cursorCaptureStartTimeMs);
		void event;
		if (cursorClickTimestampsMs.length >= MAX_CURSOR_CLICKS) return;
		cursorClickTimestampsMs.push(elapsed);
	};

	try {
		hook.on("mousedown", uioHookMouseDownHandler);
		hook.start();
		uioHookInstance = hook;
	} catch (error) {
		if (!uioHookFailureLogged) {
			uioHookFailureLogged = true;
			console.warn("[clickCapture] failed to start uiohook:", error);
		}
		uioHookMouseDownHandler = null;
	}
}

function stopClickCapture() {
	if (!uioHookInstance) return;
	try {
		if (uioHookMouseDownHandler) {
			if (typeof uioHookInstance.off === "function") {
				uioHookInstance.off("mousedown", uioHookMouseDownHandler);
			} else if (typeof uioHookInstance.removeListener === "function") {
				uioHookInstance.removeListener("mousedown", uioHookMouseDownHandler);
			}
		}
		uioHookInstance.stop();
	} catch (error) {
		console.warn("[clickCapture] failed to stop uiohook:", error);
	}
	uioHookInstance = null;
	uioHookMouseDownHandler = null;
}

function takeCursorClickTimestamps(): number[] {
	const out = cursorClickTimestampsMs;
	cursorClickTimestampsMs = [];
	return out;
}

function stopCursorCapture() {
	if (cursorCaptureInterval) {
		clearInterval(cursorCaptureInterval);
		cursorCaptureInterval = null;
	}
	stopClickCapture();
}

function sampleCursorPoint() {
	const cursor = screen.getCursorScreenPoint();
	const sourceDisplayId = Number(selectedSource?.display_id);
	const sourceDisplay = Number.isFinite(sourceDisplayId)
		? (screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null)
		: null;
	const display = sourceDisplay ?? screen.getDisplayNearestPoint(cursor);
	const bounds = display.bounds;
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);

	const cx = clamp((cursor.x - bounds.x) / width, 0, 1);
	const cy = clamp((cursor.y - bounds.y) / height, 0, 1);

	cursorTelemetryBuffer.push({
		timeMs: Math.max(0, Date.now() - cursorCaptureStartTimeMs),
		cx,
		cy,
	});
}

function normalizeCursorRecordingSample(sample: unknown): CursorRecordingSample | null {
	if (!sample || typeof sample !== "object") return null;
	const point = sample as Partial<CursorRecordingSample>;
	const timeMs =
		typeof point.timeMs === "number" && Number.isFinite(point.timeMs)
			? Math.max(0, point.timeMs)
			: 0;
	const cx = typeof point.cx === "number" && Number.isFinite(point.cx) ? point.cx : 0.5;
	const cy = typeof point.cy === "number" && Number.isFinite(point.cy) ? point.cy : 0.5;
	const interactionType =
		point.interactionType === "click" ||
		point.interactionType === "mouseup" ||
		point.interactionType === "move"
			? point.interactionType
			: undefined;

	return {
		timeMs,
		cx,
		cy,
		...(typeof point.assetId === "string" || point.assetId === null
			? { assetId: point.assetId }
			: {}),
		...(typeof point.visible === "boolean" ? { visible: point.visible } : {}),
		...(typeof point.cursorType === "string" || point.cursorType === null
			? { cursorType: point.cursorType }
			: {}),
		...(interactionType ? { interactionType } : {}),
	};
}

function normalizeCursorRecordingData(parsed: unknown): CursorRecordingData {
	const source = parsed && typeof parsed === "object" ? parsed : {};
	const rawSamples = Array.isArray(parsed)
		? parsed
		: Array.isArray((source as { samples?: unknown }).samples)
			? (source as { samples: unknown[] }).samples
			: [];
	const rawAssets = Array.isArray((source as { assets?: unknown }).assets)
		? (source as { assets: unknown[] }).assets
		: [];

	const samples = rawSamples
		.map(normalizeCursorRecordingSample)
		.filter((sample): sample is CursorRecordingSample => Boolean(sample))
		.sort((a, b) => a.timeMs - b.timeMs);
	const assets = rawAssets
		.filter((asset): asset is Partial<CursorRecordingData["assets"][number]> =>
			Boolean(asset && typeof asset === "object"),
		)
		.map((asset) => ({
			id: typeof asset.id === "string" ? asset.id : "",
			platform:
				asset.platform === "darwin" || asset.platform === "linux" || asset.platform === "win32"
					? asset.platform
					: "win32",
			imageDataUrl: typeof asset.imageDataUrl === "string" ? asset.imageDataUrl : "",
			width:
				typeof asset.width === "number" && Number.isFinite(asset.width)
					? Math.max(1, asset.width)
					: 1,
			height:
				typeof asset.height === "number" && Number.isFinite(asset.height)
					? Math.max(1, asset.height)
					: 1,
			hotspotX:
				typeof asset.hotspotX === "number" && Number.isFinite(asset.hotspotX) ? asset.hotspotX : 0,
			hotspotY:
				typeof asset.hotspotY === "number" && Number.isFinite(asset.hotspotY) ? asset.hotspotY : 0,
			...(typeof asset.scaleFactor === "number" && Number.isFinite(asset.scaleFactor)
				? { scaleFactor: asset.scaleFactor }
				: {}),
			...(typeof asset.cursorType === "string" || asset.cursorType === null
				? { cursorType: asset.cursorType }
				: {}),
		}))
		.filter((asset) => asset.id && asset.imageDataUrl);

	const hasNativeAssets = assets.length > 0 && samples.some((sample) => sample.assetId);
	return {
		version:
			typeof (source as { version?: unknown }).version === "number"
				? (source as { version: number }).version
				: Array.isArray(parsed)
					? CURSOR_TELEMETRY_VERSION
					: 2,
		provider: hasNativeAssets ? "native" : "none",
		samples,
		assets,
	};
}

async function readCursorRecordingData(videoPath: string): Promise<CursorRecordingData | null> {
	const telemetryPath = `${videoPath}.cursor.json`;
	const content = await fs.readFile(telemetryPath, "utf-8");
	return normalizeCursorRecordingData(JSON.parse(content));
}

async function startNativeCursorRecording(sourceId?: string | null, startTimeMs?: number) {
	if (nativeCursorRecordingSession) {
		pendingNativeCursorRecordingData = await nativeCursorRecordingSession.stop();
		nativeCursorRecordingSession = null;
	}

	pendingNativeCursorRecordingData = null;
	if (process.platform !== "win32") {
		return;
	}

	const session = new WindowsNativeRecordingSession({
		getDisplayBounds: getSelectedSourceBounds,
		maxSamples: MAX_NATIVE_CURSOR_SAMPLES,
		sampleIntervalMs: NATIVE_CURSOR_SAMPLE_INTERVAL_MS,
		sourceId,
		startTimeMs,
	});
	nativeCursorRecordingSession = session;

	try {
		await session.start();
	} catch (error) {
		console.error("Failed to start native Windows cursor recording:", error);
		nativeCursorRecordingSession = null;
	}
}

async function stopNativeCursorRecording() {
	if (!nativeCursorRecordingSession) {
		return;
	}

	try {
		pendingNativeCursorRecordingData = await nativeCursorRecordingSession.stop();
	} catch (error) {
		console.error("Failed to stop native Windows cursor recording:", error);
		pendingNativeCursorRecordingData = null;
	} finally {
		nativeCursorRecordingSession = null;
	}
}

async function writePendingNativeCursorRecording(videoPath: string) {
	const data = pendingNativeCursorRecordingData;
	pendingNativeCursorRecordingData = null;
	if (!data || data.samples.length === 0) {
		return;
	}

	await fs.writeFile(`${videoPath}.cursor.json`, JSON.stringify(data, null, 2), "utf-8");
}

function shiftPendingNativeCursorRecording(offsetMs: number) {
	if (!pendingNativeCursorRecordingData || !Number.isFinite(offsetMs) || offsetMs <= 0) {
		return;
	}

	pendingNativeCursorRecordingData = {
		...pendingNativeCursorRecordingData,
		samples: pendingNativeCursorRecordingData.samples
			.map((sample) => ({
				...sample,
				timeMs: Math.max(0, sample.timeMs - offsetMs),
			}))
			.sort((a, b) => a.timeMs - b.timeMs),
	};
}

function getSelectedDisplay() {
	const sourceDisplayId = Number(selectedSource?.display_id);
	if (!Number.isFinite(sourceDisplayId)) {
		return null;
	}

	return screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null;
}

function getSelectedSourceBounds() {
	const display =
		getSelectedDisplay() ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	return display.bounds;
}

function resolveUnpackedAppPath(...segments: string[]) {
	const resolved = path.join(app.getAppPath(), ...segments);
	if (app.isPackaged) {
		return resolved.replace(/\.asar([/\\])/, ".asar.unpacked$1");
	}

	return resolved;
}

function resolvePackagedResourcePath(...segments: string[]) {
	if (!app.isPackaged) {
		return null;
	}

	return path.join(process.resourcesPath, ...segments);
}

function getNativeWindowsCaptureHelperCandidates() {
	const envPath = process.env.OPENSCREEN_WGC_CAPTURE_EXE?.trim();
	const archTag = process.arch === "arm64" ? "win32-arm64" : "win32-x64";
	return [
		envPath,
		resolveUnpackedAppPath(
			"electron",
			"native",
			"wgc-capture",
			"build",
			"Release",
			"wgc-capture.exe",
		),
		resolveUnpackedAppPath("electron", "native", "wgc-capture", "build", "wgc-capture.exe"),
		resolveUnpackedAppPath("electron", "native", "bin", archTag, "wgc-capture.exe"),
		resolvePackagedResourcePath("electron", "native", "bin", archTag, "wgc-capture.exe"),
	].filter((candidate): candidate is string => Boolean(candidate));
}

async function findNativeWindowsCaptureHelperPath() {
	if (process.platform !== "win32") {
		return null;
	}

	for (const candidate of getNativeWindowsCaptureHelperCandidates()) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next configured helper location.
		}
	}

	return null;
}

function isWindowsGraphicsCaptureOsSupported() {
	if (process.platform !== "win32") {
		return false;
	}

	const [, , build] = process.getSystemVersion().split(".").map(Number);
	return Number.isFinite(build) && build >= 19041;
}

function normalizeNativeDeviceName(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreNativeDeviceName(candidateName: string, candidateId: string, requestedName?: string) {
	const candidate = normalizeNativeDeviceName(candidateName);
	const id = normalizeNativeDeviceName(candidateId);
	const requested = normalizeNativeDeviceName(requestedName ?? "");
	if (!requested) {
		return 0;
	}
	if (candidate === requested) {
		return 1000;
	}
	if (candidate.includes(requested) || requested.includes(candidate)) {
		return 900;
	}
	if (id.includes(requested) || requested.includes(id)) {
		return 800;
	}

	return requested
		.split(/\s+/)
		.filter((word) => word.length > 1 && !["camera", "webcam", "video", "input"].includes(word))
		.reduce((score, word) => {
			if (candidate.includes(word)) return score + 100;
			if (id.includes(word)) return score + 50;
			return score;
		}, 0);
}

function queryDirectShowVideoInputRegistry() {
	return new Promise<string>((resolve) => {
		const proc = spawn(
			"reg.exe",
			["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
			{ windowsHide: true },
		);
		let stdout = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf16le").includes("\u0000")
				? chunk.toString("utf16le")
				: chunk.toString();
		});
		proc.on("close", () => resolve(stdout));
		proc.on("error", () => resolve(""));
	});
}

async function resolveDirectShowWebcamClsid(deviceName?: string) {
	if (process.platform !== "win32" || !deviceName?.trim()) {
		return null;
	}

	const output = await queryDirectShowVideoInputRegistry();
	let current: { friendlyName?: string; clsid?: string } = {};
	const entries: Array<{ friendlyName?: string; clsid?: string }> = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best: { clsid: string; friendlyName?: string; score: number } | null = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreNativeDeviceName(entry.friendlyName ?? "", entry.clsid, deviceName);
		if (!best || score > best.score) {
			best = { clsid: entry.clsid, friendlyName: entry.friendlyName, score };
		}
	}

	if (!best || best.score <= 0) {
		return null;
	}

	console.info("[native-wgc] resolved DirectShow webcam filter", {
		requestedName: deviceName,
		filterName: best.friendlyName,
		clsid: best.clsid,
		score: best.score,
	});
	return best.clsid;
}

function waitForNativeWindowsCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native Windows capture to start"));
		}, 12_000);

		const onOutput = (chunk: Buffer) => {
			nativeWindowsCaptureOutput += chunk.toString();
			if (nativeWindowsCaptureOutput.includes("Recording started")) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					nativeWindowsCaptureOutput.trim() ||
						`Native Windows capture exited before recording started (code=${code ?? "unknown"})`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout.off("data", onOutput);
			proc.stderr.off("data", onOutput);
			proc.off("error", onError);
			proc.off("exit", onExit);
		};

		proc.stdout.on("data", onOutput);
		proc.stderr.on("data", onOutput);
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

function waitForNativeWindowsCaptureStop(proc: ChildProcessWithoutNullStreams) {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			if (!proc.killed) {
				proc.kill();
			}
			reject(
				new Error(
					`Timed out waiting for native Windows capture to stop. Output path: ${
						nativeWindowsCaptureTargetPath ?? "unknown"
					}. Output: ${nativeWindowsCaptureOutput.trim()}`,
				),
			);
		}, NATIVE_WINDOWS_CAPTURE_STOP_TIMEOUT_MS);
		const onOutput = (chunk: Buffer) => {
			nativeWindowsCaptureOutput += chunk.toString();
		};
		const onClose = (code: number | null) => {
			cleanup();
			const match = nativeWindowsCaptureOutput.match(/Recording stopped\. Output path: (.+)/);
			if (match?.[1]) {
				resolve(match[1].trim());
				return;
			}
			if (code === 0 && nativeWindowsCaptureTargetPath) {
				resolve(nativeWindowsCaptureTargetPath);
				return;
			}
			reject(
				new Error(
					nativeWindowsCaptureOutput.trim() ||
						`Native Windows capture exited with code=${code ?? "unknown"}`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout.off("data", onOutput);
			proc.stderr.off("data", onOutput);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		proc.stdout.on("data", onOutput);
		proc.stderr.on("data", onOutput);
		proc.once("close", onClose);
		proc.once("error", onError);
	});
}

export function registerIpcHandlers(
	createEditorWindow: () => void,
	createSourceSelectorWindow: () => BrowserWindow,
	createCountdownOverlayWindow: () => BrowserWindow,
	getMainWindow: () => BrowserWindow | null,
	getSourceSelectorWindow: () => BrowserWindow | null,
	getCountdownOverlayWindow: () => BrowserWindow | null,
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
	switchToHud?: () => void,
) {
	const supportsWindowOpacity = process.platform !== "linux";
	const countdownOverlayState = {
		visible: false,
		value: null as number | null,
		activeRunId: null as number | null,
		hideCommitId: 0,
		hideCommitTimer: null as ReturnType<typeof setTimeout> | null,
	};
	const COUNTDOWN_OVERLAY_HIDE_DEBOUNCE_MS = 1200;

	const clearCountdownOverlayHideCommit = () => {
		if (countdownOverlayState.hideCommitTimer) {
			clearTimeout(countdownOverlayState.hideCommitTimer);
			countdownOverlayState.hideCommitTimer = null;
		}
	};

	const commitCountdownOverlayHide = (win: BrowserWindow, hideCommitId: number) => {
		if (win.isDestroyed()) {
			return;
		}

		if (countdownOverlayState.visible || countdownOverlayState.hideCommitId !== hideCommitId) {
			return;
		}

		win.hide();
		if (supportsWindowOpacity) {
			// Reset baseline opacity for the next show cycle.
			win.setOpacity(1);
		}
	};

	const flushCountdownOverlayState = (win: BrowserWindow) => {
		if (win.isDestroyed()) {
			return;
		}

		clearCountdownOverlayHideCommit();
		win.webContents.send("countdown-overlay-value", countdownOverlayState.value);
		if (!countdownOverlayState.visible) {
			return;
		}

		if (win.isVisible()) {
			if (supportsWindowOpacity) {
				win.setOpacity(1);
			}
			return;
		}

		setTimeout(() => {
			if (!win.isDestroyed() && countdownOverlayState.visible && !win.isVisible()) {
				if (supportsWindowOpacity) {
					win.setOpacity(0);
				}
				win.showInactive();

				if (supportsWindowOpacity) {
					setTimeout(() => {
						if (!win.isDestroyed() && countdownOverlayState.visible && win.isVisible()) {
							win.setOpacity(1);
						}
					}, 0);
				}
			}
		}, 16);
	};

	ipcMain.handle("countdown-overlay-show", (_, value: number, runId: number) => {
		countdownOverlayState.activeRunId = runId;
		countdownOverlayState.visible = true;
		countdownOverlayState.value = value;

		const win = getCountdownOverlayWindow() ?? createCountdownOverlayWindow();
		if (win.isDestroyed()) {
			return;
		}

		if (win.webContents.isLoading()) {
			win.webContents.once("did-finish-load", () => {
				if (!win.isDestroyed()) {
					flushCountdownOverlayState(win);
				}
			});
		} else {
			flushCountdownOverlayState(win);
		}
	});

	ipcMain.handle("countdown-overlay-set-value", (_, value: number, runId: number) => {
		if (countdownOverlayState.activeRunId !== runId || !countdownOverlayState.visible) {
			return;
		}

		countdownOverlayState.value = value;

		const win = getCountdownOverlayWindow();
		if (!win || win.isDestroyed()) {
			return;
		}

		if (win.webContents.isLoading()) {
			return;
		}

		win.webContents.send("countdown-overlay-value", value);
	});

	ipcMain.handle("countdown-overlay-hide", (_, runId: number) => {
		if (countdownOverlayState.activeRunId !== runId) {
			return;
		}

		countdownOverlayState.visible = false;
		countdownOverlayState.hideCommitId += 1;
		const hideCommitId = countdownOverlayState.hideCommitId;
		clearCountdownOverlayHideCommit();

		const win = getCountdownOverlayWindow();
		if (!win || win.isDestroyed()) {
			countdownOverlayState.value = null;
			return;
		}

		if (supportsWindowOpacity) {
			// Hide visually immediately to avoid hide/show compositor flashes on rapid restart.
			win.setOpacity(0);
		}

		countdownOverlayState.value = null;
		if (!win.webContents.isLoading()) {
			win.webContents.send("countdown-overlay-value", countdownOverlayState.value);
		}

		if (!supportsWindowOpacity) {
			win.hide();
			return;
		}

		countdownOverlayState.hideCommitTimer = setTimeout(() => {
			countdownOverlayState.hideCommitTimer = null;
			commitCountdownOverlayHide(win, hideCommitId);
		}, COUNTDOWN_OVERLAY_HIDE_DEBOUNCE_MS);
	});

	ipcMain.handle("switch-to-hud", () => {
		if (switchToHud) switchToHud();
	});
	ipcMain.handle("start-new-recording", () => {
		try {
			setCurrentRecordingSessionState(null);
			if (switchToHud) {
				switchToHud();
			}
			return { success: true };
		} catch (error) {
			console.error("Failed to start new recording:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("get-sources", async (_, opts) => {
		const ownWindowSourceIds = new Set(
			BrowserWindow.getAllWindows()
				.map((win) => {
					try {
						return win.getMediaSourceId();
					} catch {
						return null;
					}
				})
				.filter((id): id is string => Boolean(id)),
		);
		const sources = await desktopCapturer.getSources(opts);
		const visibleSources = sources
			.filter((source) => !ownWindowSourceIds.has(source.id))
			.map((source) => source);
		lastEnumeratedSources = new Map(visibleSources.map((source) => [source.id, source]));
		return visibleSources.map((source) => ({
			id: source.id,
			name: source.name,
			display_id: source.display_id,
			thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
			appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
		}));
	});

	ipcMain.handle("select-source", async (_, source: SelectedSource) => {
		selectedSource = source;
		selectedDesktopSource =
			typeof source.id === "string" ? (lastEnumeratedSources.get(source.id) ?? null) : null;

		if (!selectedDesktopSource && typeof source.id === "string") {
			try {
				const sources = await desktopCapturer.getSources({
					types: ["screen", "window"],
					thumbnailSize: { width: 0, height: 0 },
					fetchWindowIcons: true,
				});
				lastEnumeratedSources = new Map(sources.map((candidate) => [candidate.id, candidate]));
				selectedDesktopSource = lastEnumeratedSources.get(source.id) ?? null;
			} catch {
				selectedDesktopSource = null;
			}
		}

		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.close();
		}
		return selectedSource;
	});

	ipcMain.handle("get-selected-source", () => {
		return selectedSource;
	});

	ipcMain.handle("request-camera-access", async () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("camera");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			if (status === "not-determined") {
				const granted = await systemPreferences.askForMediaAccess("camera");
				return {
					success: true,
					granted,
					status: granted ? "granted" : systemPreferences.getMediaAccessStatus("camera"),
				};
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request camera access:", error);
			return {
				success: false,
				granted: false,
				status: "unknown",
				error: String(error),
			};
		}
	});

	ipcMain.handle("request-screen-access", async () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("screen");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			// Screen recording has no askForMediaAccess equivalent — the TCC prompt
			// is triggered by desktopCapturer.getSources(). Fire it and return so
			// the renderer can re-check status after the user responds.
			if (status === "not-determined") {
				desktopCapturer.getSources({ types: ["screen"] }).catch(() => {
					// The permission prompt is best-effort; the renderer re-checks status.
				});
				return { success: true, granted: false, status: "not-determined" };
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request screen access:", error);
			return { success: false, granted: false, status: "unknown", error: String(error) };
		}
	});

	// macOS Accessibility prompt for global click capture. First call shows the
	// system dialog; the user has to toggle the app in System Settings (no
	// programmatic grant exists for Accessibility).
	ipcMain.handle("request-accessibility-access", () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true };
		}
		try {
			const granted = systemPreferences.isTrustedAccessibilityClient(true);
			return { success: true, granted };
		} catch (error) {
			console.error("Failed to request accessibility access:", error);
			return { success: false, granted: false, error: String(error) };
		}
	});

	ipcMain.handle("open-source-selector", () => {
		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.focus();
			return;
		}
		createSourceSelectorWindow();
	});

	ipcMain.handle("switch-to-editor", () => {
		const mainWin = getMainWindow();
		if (mainWin) {
			mainWin.close();
		}
		createEditorWindow();
	});

	ipcMain.handle("is-native-windows-capture-available", async () => {
		if (!isWindowsGraphicsCaptureOsSupported()) {
			return { success: true, available: false, reason: "unsupported-os" };
		}

		const helperPath = await findNativeWindowsCaptureHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle(
		"start-native-windows-recording",
		async (_, request: NativeWindowsRecordingRequest) => {
			try {
				if (!isWindowsGraphicsCaptureOsSupported()) {
					return {
						success: false,
						error: "Windows Graphics Capture requires Windows 10 build 19041 or newer.",
					};
				}
				if (nativeWindowsCaptureProcess) {
					return { success: false, error: "Native Windows capture is already running." };
				}

				const helperPath = await findNativeWindowsCaptureHelperPath();
				if (!helperPath) {
					return { success: false, error: "Native Windows capture helper is not available." };
				}

				if (!request?.source?.sourceId) {
					return {
						success: false,
						error: "Native Windows capture request is missing a source.",
					};
				}

				const recordingId =
					typeof request.recordingId === "number" && Number.isFinite(request.recordingId)
						? request.recordingId
						: Date.now();
				const outputPath = path.join(RECORDINGS_DIR, `recording-${recordingId}.mp4`);
				const webcamOutputPath = path.join(RECORDINGS_DIR, `recording-${recordingId}-webcam.mp4`);
				const cursorCaptureMode =
					normalizeCursorCaptureMode(request.cursor?.mode) ?? "editable-overlay";
				const sourceDisplay =
					request.source.type === "display" && typeof request.source.displayId === "number"
						? (screen.getAllDisplays().find((display) => display.id === request.source.displayId) ??
							null)
						: getSelectedDisplay();
				const bounds = sourceDisplay?.bounds ?? getSelectedSourceBounds();
				const displayId =
					typeof request.source.displayId === "number" && Number.isFinite(request.source.displayId)
						? request.source.displayId
						: Number(selectedSource?.display_id);
				const webcamDirectShowClsid = request.webcam.enabled
					? await resolveDirectShowWebcamClsid(request.webcam.deviceName)
					: null;
				const config = {
					schemaVersion: 2,
					recordingId,
					outputPath,
					sourceType: request.source.type,
					sourceId: request.source.sourceId,
					displayId: Number.isFinite(displayId) ? displayId : 0,
					windowHandle: request.source.windowHandle ?? null,
					fps: request.video.fps,
					videoWidth: request.video.width,
					videoHeight: request.video.height,
					displayX: bounds.x,
					displayY: bounds.y,
					displayW: bounds.width,
					displayH: bounds.height,
					hasDisplayBounds: true,
					captureSystemAudio: request.audio.system.enabled,
					captureMic: request.audio.microphone.enabled,
					microphoneDeviceId: request.audio.microphone.deviceId ?? null,
					microphoneDeviceName: request.audio.microphone.deviceName ?? null,
					microphoneGain: request.audio.microphone.gain,
					webcamEnabled: request.webcam.enabled,
					webcamDeviceId: request.webcam.deviceId ?? null,
					webcamDeviceName: request.webcam.deviceName ?? null,
					webcamDirectShowClsid,
					webcamWidth: request.webcam.width,
					webcamHeight: request.webcam.height,
					webcamFps: request.webcam.fps,
					captureCursor: cursorCaptureMode === "system",
					cursorCaptureMode,
					outputs: {
						screenPath: outputPath,
						webcamPath: webcamOutputPath,
					},
					source: {
						type: request.source.type,
						sourceId: request.source.sourceId,
						displayId: Number.isFinite(displayId) ? displayId : null,
						windowHandle: request.source.windowHandle ?? null,
						bounds,
					},
					video: request.video,
					audio: request.audio,
					webcam: request.webcam,
					cursor: {
						mode: cursorCaptureMode,
					},
				};

				console.info("[native-wgc] starting Windows capture", {
					helperPath,
					source: request.source,
					audio: request.audio,
					webcam: request.webcam,
					bounds,
					outputPath,
				});

				await fs.mkdir(RECORDINGS_DIR, { recursive: true });
				nativeWindowsCaptureOutput = "";
				nativeWindowsCaptureTargetPath = outputPath;
				nativeWindowsCaptureWebcamTargetPath = request.webcam.enabled ? webcamOutputPath : null;
				nativeWindowsCaptureRecordingId = recordingId;
				nativeWindowsCaptureCursorMode = cursorCaptureMode;
				nativeWindowsCursorOffsetMs = 0;

				const cursorStartTimeMs = Date.now();
				if (cursorCaptureMode === "editable-overlay") {
					await startNativeCursorRecording(request.source.sourceId, cursorStartTimeMs);
				}

				const proc = spawn(helperPath, [JSON.stringify(config)], {
					cwd: RECORDINGS_DIR,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				nativeWindowsCaptureProcess = proc;

				await waitForNativeWindowsCaptureStart(proc);
				nativeWindowsCursorOffsetMs =
					cursorCaptureMode === "editable-overlay"
						? Math.max(0, Date.now() - cursorStartTimeMs)
						: 0;

				const source = selectedSource || { name: "Screen" };
				if (onRecordingStateChange) {
					onRecordingStateChange(true, source.name);
				}

				return {
					success: true,
					recordingId,
					path: outputPath,
					helperPath,
				};
			} catch (error) {
				console.error("Failed to start native Windows recording:", error);
				nativeWindowsCaptureProcess?.kill();
				nativeWindowsCaptureProcess = null;
				nativeWindowsCaptureTargetPath = null;
				nativeWindowsCaptureWebcamTargetPath = null;
				nativeWindowsCaptureRecordingId = null;
				nativeWindowsCursorOffsetMs = 0;
				pendingNativeCursorRecordingData = null;
				await stopNativeCursorRecording();
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("stop-native-windows-recording", async (_, discard?: boolean) => {
		const proc = nativeWindowsCaptureProcess;
		const preferredPath = nativeWindowsCaptureTargetPath;
		const preferredWebcamPath = nativeWindowsCaptureWebcamTargetPath;
		const recordingId = nativeWindowsCaptureRecordingId ?? Date.now();

		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}

		try {
			const stoppedPathPromise = waitForNativeWindowsCaptureStop(proc);
			proc.stdin.write("stop\n");
			const stoppedPath = await stoppedPathPromise;
			const screenVideoPath = stoppedPath || preferredPath;
			if (!screenVideoPath) {
				throw new Error("Native Windows capture did not return an output path.");
			}

			await stopNativeCursorRecording();
			if (discard) {
				pendingNativeCursorRecordingData = null;
				await Promise.all([
					fs.rm(screenVideoPath, { force: true }),
					fs.rm(`${screenVideoPath}.cursor.json`, { force: true }),
					preferredWebcamPath ? fs.rm(preferredWebcamPath, { force: true }) : Promise.resolve(),
				]);
				return { success: true, discarded: true };
			}

			if (nativeWindowsCaptureCursorMode === "editable-overlay") {
				shiftPendingNativeCursorRecording(nativeWindowsCursorOffsetMs);
				await writePendingNativeCursorRecording(screenVideoPath);
			} else {
				pendingNativeCursorRecordingData = null;
			}

			let webcamVideoPath: string | undefined;
			if (preferredWebcamPath) {
				try {
					await fs.access(preferredWebcamPath, fsConstants.R_OK);
					webcamVideoPath = preferredWebcamPath;
				} catch {
					webcamVideoPath = undefined;
				}
			}

			const session: RecordingSession = webcamVideoPath
				? {
						screenVideoPath,
						webcamVideoPath,
						createdAt: recordingId,
						cursorCaptureMode: nativeWindowsCaptureCursorMode,
					}
				: {
						screenVideoPath,
						createdAt: recordingId,
						cursorCaptureMode: nativeWindowsCaptureCursorMode,
					};
			setCurrentRecordingSessionState(session);
			currentProjectPath = null;

			const sessionManifestPath = path.join(
				RECORDINGS_DIR,
				`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
			);
			await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");

			return {
				success: true,
				path: screenVideoPath,
				session,
				message: "Native Windows recording session stored successfully",
			};
		} catch (error) {
			console.error("Failed to stop native Windows recording:", error);
			await stopNativeCursorRecording();
			return { success: false, error: String(error) };
		} finally {
			nativeWindowsCaptureProcess = null;
			nativeWindowsCaptureTargetPath = null;
			nativeWindowsCaptureWebcamTargetPath = null;
			nativeWindowsCaptureRecordingId = null;
			nativeWindowsCaptureCursorMode = "editable-overlay";
			nativeWindowsCursorOffsetMs = 0;
			const source = selectedSource || { name: "Screen" };
			if (onRecordingStateChange) {
				onRecordingStateChange(false, source.name);
			}
		}
	});

	ipcMain.handle("store-recorded-session", async (_, payload: StoreRecordedSessionInput) => {
		try {
			return await storeRecordedSessionFiles(payload);
		} catch (error) {
			console.error("Failed to store recording session:", error);
			return {
				success: false,
				message: "Failed to store recording session",
				error: String(error),
			};
		}
	});

	ipcMain.handle("store-recorded-video", async (_, videoData: ArrayBuffer, fileName: string) => {
		try {
			return await storeRecordedSessionFiles({
				screen: { videoData, fileName },
				createdAt: Date.now(),
			});
		} catch (error) {
			console.error("Failed to store recorded video:", error);
			return {
				success: false,
				message: "Failed to store recorded video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-recorded-video-path", async () => {
		try {
			if (currentRecordingSession?.screenVideoPath) {
				return { success: true, path: currentRecordingSession.screenVideoPath };
			}

			const files = await fs.readdir(RECORDINGS_DIR);
			const videoFiles = files.filter(
				(file) =>
					(file.endsWith(".webm") || file.endsWith(".mp4")) &&
					!file.endsWith("-webcam.webm") &&
					!file.endsWith("-webcam.mp4"),
			);

			if (videoFiles.length === 0) {
				return { success: false, message: "No recorded video found" };
			}

			// Sort by most recently modified to reliably get the latest recording.
			// Lexicographic sort is unreliable (e.g. recording-9.webm > recording-10.webm).
			let latestVideo: string | null = null;
			let latestMtimeMs = 0;
			for (const file of videoFiles) {
				try {
					const stat = await fs.stat(path.join(RECORDINGS_DIR, file));
					if (stat.mtimeMs > latestMtimeMs) {
						latestMtimeMs = stat.mtimeMs;
						latestVideo = file;
					}
				} catch {
					// Skip inaccessible files.
				}
			}
			if (!latestVideo) {
				return { success: false, message: "No recorded video found" };
			}
			const videoPath = path.join(RECORDINGS_DIR, latestVideo);

			return { success: true, path: videoPath };
		} catch (error) {
			console.error("Failed to get video path:", error);
			return { success: false, message: "Failed to get video path", error: String(error) };
		}
	});

	ipcMain.handle("read-binary-file", async (_, inputPath: string) => {
		try {
			const normalizedPath = normalizeVideoSourcePath(inputPath);
			if (!normalizedPath) {
				return { success: false, message: "Invalid file path" };
			}

			if (!isPathAllowed(normalizedPath)) {
				console.warn(
					"[read-binary-file] Rejected path outside allowed directories:",
					normalizedPath,
				);
				return { success: false, message: "Access denied: path outside allowed directories" };
			}

			const data = await fs.readFile(normalizedPath);
			return {
				success: true,
				data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to read binary file:", error);
			return {
				success: false,
				message: "Failed to read binary file",
				error: String(error),
			};
		}
	});

	ipcMain.handle("set-recording-state", (_, recording: boolean, recordingId?: number) => {
		if (recording) {
			stopCursorCapture();
			// The renderer is the source of truth for the recording id (it
			// uses the same id as the saved fileName). Fall back to a
			// timestamp only if the renderer didn't supply one, so the
			// buffer always has a stable key per session.
			const id = typeof recordingId === "number" ? recordingId : Date.now();
			cursorTelemetryBuffer.startSession(id);
			cursorCaptureStartTimeMs = Date.now();
			cursorClickTimestampsMs = [];
			startClickCapture();
			sampleCursorPoint();
			cursorCaptureInterval = setInterval(sampleCursorPoint, CURSOR_SAMPLE_INTERVAL_MS);
		} else {
			stopCursorCapture();
			cursorTelemetryBuffer.endSession();
		}

		const source = selectedSource || { name: "Screen" };
		if (onRecordingStateChange) {
			onRecordingStateChange(recording, source.name);
		}
	});

	ipcMain.handle("discard-cursor-telemetry", (_, recordingId: number) => {
		cursorTelemetryBuffer.discardBatch(recordingId);
	});

	ipcMain.handle("get-cursor-telemetry", async (_, videoPath?: string) => {
		const targetVideoPath = normalizeVideoSourcePath(
			videoPath ?? currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return { success: true, samples: [] };
		}

		if (!isPathAllowed(targetVideoPath)) {
			console.warn(
				"[get-cursor-telemetry] Rejected path outside allowed directories:",
				targetVideoPath,
			);
			return { success: true, samples: [] };
		}

		try {
			const parsed = JSON.parse(await fs.readFile(`${targetVideoPath}.cursor.json`, "utf-8"));
			const recordingData = normalizeCursorRecordingData(parsed);
			const samples: CursorTelemetryPoint[] = (recordingData?.samples ?? [])
				.filter((point) => point.visible !== false)
				.map((point) => ({
					timeMs: point.timeMs,
					cx: clamp(point.cx, 0, 1),
					cy: clamp(point.cy, 0, 1),
				}))
				.sort((a, b) => a.timeMs - b.timeMs);

			const legacyClicks = Array.isArray(parsed?.clicks) ? parsed.clicks : [];
			const clicks: number[] =
				legacyClicks.length > 0
					? legacyClicks
							.map((value: unknown) =>
								typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null,
							)
							.filter((v: number | null): v is number => v !== null)
							.sort((a: number, b: number) => a - b)
					: (recordingData?.samples ?? [])
							.filter((sample) => sample.visible !== false)
							.filter((sample) => sample.interactionType === "click")
							.map((sample) => sample.timeMs)
							.sort((a, b) => a - b);

			return { success: true, samples, clicks };
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") {
				return { success: true, samples: [], clicks: [] };
			}
			console.error("Failed to load cursor telemetry:", error);
			return {
				success: false,
				message: "Failed to load cursor telemetry",
				error: String(error),
				samples: [],
				clicks: [],
			};
		}
	});

	ipcMain.handle("get-cursor-recording-data", async (_, videoPath?: string) => {
		const targetVideoPath = normalizeVideoSourcePath(
			videoPath ?? currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return { success: true, data: null };
		}

		if (!isPathAllowed(targetVideoPath)) {
			console.warn(
				"[get-cursor-recording-data] Rejected path outside allowed directories:",
				targetVideoPath,
			);
			return { success: true, data: null };
		}

		try {
			const data = await readCursorRecordingData(targetVideoPath);
			return { success: true, data };
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") {
				return { success: true, data: null };
			}
			console.error("Failed to load cursor recording data:", error);
			return {
				success: false,
				message: "Failed to load cursor recording data",
				error: String(error),
				data: null,
			};
		}
	});

	ipcMain.handle("open-external-url", async (_, url: string) => {
		try {
			const ALLOWED_SCHEMES = ["http:", "https:", "mailto:"];
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return { success: false, error: "Invalid URL" };
			}

			if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
				return { success: false, error: `Unsupported URL scheme: ${parsed.protocol}` };
			}

			await shell.openExternal(parsed.toString());
			return { success: true };
		} catch (error) {
			console.error("Failed to open URL:", error);
			return { success: false, error: String(error) };
		}
	});

	/**
	 * Handles saving an exported video file.
	 * Shows a save dialog, normalizes the file path for the current OS,
	 * ensures the directory exists, and writes the video data.
	 * @param _ - Unused event parameter.
	 * @param videoData - The exported video as an ArrayBuffer.
	 * @param fileName - Suggested filename for the save dialog.
	 * @returns Object with success status, optional file path, and error details.
	 */

	ipcMain.handle("pick-export-save-path", async (_, fileName: string, exportFolder?: string) => {
		try {
			const isGif = fileName.toLowerCase().endsWith(".gif");
			const filters = isGif
				? [{ name: mainT("dialogs", "fileDialogs.gifImage"), extensions: ["gif"] }]
				: [{ name: mainT("dialogs", "fileDialogs.mp4Video"), extensions: ["mp4"] }];

			// Prefer the user's last export folder if it still exists, otherwise fall
			// back to ~/Downloads. Validation must happen here because the renderer
			// can't stat the filesystem.
			let defaultDir = app.getPath("downloads");
			if (exportFolder) {
				try {
					const stats = await fs.stat(exportFolder);
					if (stats.isDirectory()) {
						defaultDir = exportFolder;
					}
				} catch (err) {
					console.warn(
						`Could not access remembered export folder "${exportFolder}", falling back to Downloads:`,
						err,
					);
				}
			}
			const dialogOptions = buildDialogOptions(
				{
					title: isGif
						? mainT("dialogs", "fileDialogs.saveGif")
						: mainT("dialogs", "fileDialogs.saveVideo"),
					defaultPath: path.join(defaultDir, fileName),
					filters,
					properties: ["createDirectory", "showOverwriteConfirmation"],
				},
				getMainWindow(),
			);
			const result = await dialog.showSaveDialog(dialogOptions);

			if (result.canceled || !result.filePath) {
				return { success: false, canceled: true, message: "Export canceled" };
			}

			return { success: true, path: path.normalize(result.filePath) };
		} catch (error) {
			console.error("Failed to show save dialog:", error);
			return {
				success: false,
				message: "Failed to show save dialog",
				error: String(error),
			};
		}
	});

	ipcMain.handle("write-export-to-path", async (_, videoData: ArrayBuffer, filePath: string) => {
		try {
			// Sanity-check the path. The renderer is trusted (contextIsolation is on),
			// but a stale state bug shouldn't be able to clobber arbitrary files.
			if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
				return { success: false, message: "Invalid path" };
			}
			const lower = filePath.toLowerCase();
			if (!lower.endsWith(".mp4") && !lower.endsWith(".gif")) {
				return { success: false, message: "Invalid file type" };
			}

			const normalizedPath = path.normalize(filePath);
			await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
			await fs.writeFile(normalizedPath, Buffer.from(videoData));

			return {
				success: true,
				path: normalizedPath,
				message: "Video exported successfully",
			};
		} catch (error) {
			console.error("Failed to write exported video:", error);
			return {
				success: false,
				message: "Failed to save exported video",
				error: String(error),
			};
		}
	});
	ipcMain.handle("open-video-file-picker", async () => {
		try {
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.selectVideo"),
					defaultPath: RECORDINGS_DIR,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.videoFiles"),
							extensions: ["webm", "mp4", "mov", "avi", "mkv"],
						},
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}

			const approvedPath = await approveReadableVideoPath(result.filePaths[0]);
			if (!approvedPath) {
				return {
					success: false,
					message: "Selected file is not a supported video",
				};
			}
			currentProjectPath = null;
			return {
				success: true,
				path: approvedPath,
			};
		} catch (error) {
			console.error("Failed to open file picker:", error);
			return {
				success: false,
				message: "Failed to open file picker",
				error: String(error),
			};
		}
	});

	ipcMain.handle("reveal-in-folder", async (_, filePath: string) => {
		try {
			// shell.showItemInFolder doesn't return a value, it throws on error
			shell.showItemInFolder(filePath);
			return { success: true };
		} catch (error) {
			console.error(`Error revealing item in folder: ${filePath}`, error);
			// Fallback to open the directory if revealing the item fails
			// This might happen if the file was moved or deleted after export,
			// or if the path is somehow invalid for showItemInFolder
			try {
				const openPathResult = await shell.openPath(path.dirname(filePath));
				if (openPathResult) {
					// openPath returned an error message
					return { success: false, error: openPathResult };
				}
				return { success: true, message: "Could not reveal item, but opened directory." };
			} catch (openError) {
				console.error(`Error opening directory: ${path.dirname(filePath)}`, openError);
				return { success: false, error: String(error) };
			}
		}
	});

	ipcMain.handle(
		"save-project-file",
		async (_, projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
			try {
				const trustedExistingProjectPath = isTrustedProjectPath(existingProjectPath)
					? existingProjectPath
					: null;

				if (trustedExistingProjectPath) {
					await fs.writeFile(
						trustedExistingProjectPath,
						JSON.stringify(projectData, null, 2),
						"utf-8",
					);
					currentProjectPath = trustedExistingProjectPath;
					return {
						success: true,
						path: trustedExistingProjectPath,
						message: "Project saved successfully",
					};
				}

				const safeName = (suggestedName || `project-${Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, "_");
				const defaultName = safeName.endsWith(`.${PROJECT_FILE_EXTENSION}`)
					? safeName
					: `${safeName}.${PROJECT_FILE_EXTENSION}`;

				const dialogOptions = buildDialogOptions(
					{
						title: mainT("dialogs", "fileDialogs.saveProject"),
						defaultPath: path.join(RECORDINGS_DIR, defaultName),
						filters: [
							{
								name: mainT("dialogs", "fileDialogs.openscreenProject"),
								extensions: [PROJECT_FILE_EXTENSION],
							},
							{ name: "JSON", extensions: ["json"] },
						],
						properties: ["createDirectory", "showOverwriteConfirmation"],
					},
					getMainWindow(),
				);
				const result = await dialog.showSaveDialog(dialogOptions);

				if (result.canceled || !result.filePath) {
					return {
						success: false,
						canceled: true,
						message: "Save project canceled",
					};
				}

				await fs.writeFile(result.filePath, JSON.stringify(projectData, null, 2), "utf-8");
				currentProjectPath = result.filePath;

				return {
					success: true,
					path: result.filePath,
					message: "Project saved successfully",
				};
			} catch (error) {
				console.error("Failed to save project file:", error);
				return {
					success: false,
					message: "Failed to save project file",
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("load-project-file", async () => {
		try {
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.openProject"),
					defaultPath: RECORDINGS_DIR,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							extensions: [PROJECT_FILE_EXTENSION],
						},
						{ name: "JSON", extensions: ["json"] },
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true, message: "Open project canceled" };
			}

			const filePath = result.filePaths[0];
			const content = await fs.readFile(filePath, "utf-8");
			const project = JSON.parse(content);
			const session = await getApprovedProjectSession(project, filePath);
			currentProjectPath = filePath;
			setCurrentRecordingSessionState(session);

			return {
				success: true,
				path: filePath,
				project,
			};
		} catch (error) {
			console.error("Failed to load project file:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	});

	ipcMain.handle("load-current-project-file", async () => {
		try {
			if (!currentProjectPath) {
				return { success: false, message: "No active project" };
			}

			const content = await fs.readFile(currentProjectPath, "utf-8");
			const project = JSON.parse(content);
			const session = await getApprovedProjectSession(project, currentProjectPath);
			setCurrentRecordingSessionState(session);
			return {
				success: true,
				path: currentProjectPath,
				project,
			};
		} catch (error) {
			console.error("Failed to load current project file:", error);
			return {
				success: false,
				message: "Failed to load current project file",
				error: String(error),
			};
		}
	});
	ipcMain.handle("set-current-recording-session", (_, session: RecordingSession | null) => {
		const normalized = normalizeRecordingSession(session);
		setCurrentRecordingSessionState(normalized);
		currentProjectPath = null;
		return { success: true, session: normalized ?? undefined };
	});

	ipcMain.handle("get-current-recording-session", () => {
		return currentRecordingSession
			? { success: true, session: currentRecordingSession }
			: { success: false };
	});

	ipcMain.handle("set-current-video-path", async (_, path: string) => {
		const normalizedPath = normalizeVideoSourcePath(path);
		if (!normalizedPath || !isPathAllowed(normalizedPath)) {
			return { success: false, message: "Video path has not been approved" };
		}

		const restoredSession = await loadRecordedSessionForVideoPath(normalizedPath);
		if (restoredSession) {
			// Approve all media paths from the restored session so they can be read later
			approveFilePath(restoredSession.screenVideoPath);
			if (restoredSession.webcamVideoPath) {
				approveFilePath(restoredSession.webcamVideoPath);
			}
			setCurrentRecordingSessionState(restoredSession);
		} else {
			setCurrentRecordingSessionState({
				screenVideoPath: normalizedPath,
				createdAt: Date.now(),
			});
		}
		currentProjectPath = null;
		return { success: true };
	});

	ipcMain.handle("get-current-video-path", () => {
		return currentRecordingSession?.screenVideoPath
			? { success: true, path: currentRecordingSession.screenVideoPath }
			: { success: false };
	});

	ipcMain.handle("clear-current-video-path", () => {
		setCurrentRecordingSessionState(null);
		return { success: true };
	});

	ipcMain.handle("get-platform", () => {
		return process.platform;
	});

	ipcMain.handle("get-shortcuts", async () => {
		try {
			const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
			return JSON.parse(data);
		} catch {
			return null;
		}
	});

	ipcMain.handle("save-shortcuts", async (_, shortcuts: unknown) => {
		try {
			await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), "utf-8");
			return { success: true };
		} catch (error) {
			console.error("Failed to save shortcuts:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		"save-diagnostic",
		async (
			_,
			payload: { error: string; stack?: string; projectState: unknown; logs: string[] },
		) => {
			const { filePath, canceled } = await dialog.showSaveDialog({
				title: "Save Diagnostic File",
				defaultPath: `openscreen-diagnostic-${Date.now()}.json`,
				filters: [{ name: "JSON", extensions: ["json"] }],
			});

			if (canceled || !filePath) return { success: false, canceled: true };

			const diagnostic = {
				timestamp: new Date().toISOString(),
				appVersion: app.getVersion(),
				platform: process.platform,
				arch: process.arch,
				osRelease: os.release(),
				osVersion: os.version(),
				totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
				nodeVersion: process.versions.node,
				electronVersion: process.versions.electron,
				chromeVersion: process.versions.chrome,
				error: payload.error,
				stack: payload.stack,
				projectState: payload.projectState,
				recentLogs: payload.logs,
			};

			try {
				await fs.writeFile(filePath, JSON.stringify(diagnostic, null, 2), "utf-8");
				return { success: true, path: filePath };
			} catch (error) {
				console.error("Failed to write diagnostic file:", error);
				return { success: false, error: String(error) };
			}
		},
	);
}
