import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	ipcMain,
	Menu,
	nativeImage,
	session,
	shell,
	systemPreferences,
	Tray,
} from "electron";
import { ShortcutBinding } from "../src/lib/shortcuts";
import { isDiagnosticModeEnabled, mainLogBuffer } from "./diagnostics/main-log-buffer";
import {
	loadAndRegisterGlobalShortcut,
	registerOpenAppShortcut,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";
import {
	getMainLocale,
	getMainLocaleName,
	MAIN_SUPPORTED_LOCALES,
	mainT,
	setMainLocale,
} from "./i18n";
import { getSelectedDesktopSource, registerIpcHandlers } from "./ipc/handlers";
import { claimDockIcon, initDockVisibility } from "./macActivation";
import { acquireStableInstanceLock } from "./singleInstanceLock";
import {
	createCountdownOverlayWindow,
	createEditorWindow,
	createHudOverlayWindow,
	createNotesWindow,
	createSourceSelectorWindow,
} from "./windows";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use Screen & System Audio Recording permissions instead of the CoreAudio Tap API on macOS.
// Tap needs NSAudioCaptureUsageDescription in the parent app's Info.plist, which breaks when
// running from a terminal/IDE during dev.
if (process.platform === "darwin") {
	app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare");
}

// Wayland support for screen capture and window management on Wayland compositors.
if (process.platform === "linux") {
	const isWayland =
		process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY !== undefined;
	if (isWayland) {
		app.commandLine.appendSwitch("ozone-platform", "wayland");
		// Enable WebRTCPipeWireCapturer for screen capture on Wayland
		app.commandLine.appendSwitch("enable-features", "WaylandWindowDrag,WebRTCPipeWireCapturer");
		// Chromium's Wayland Ozone backend can't use Vulkan. When it tries, the WebRTC
		// PipeWire capturer fails to import DMA-BUF frames into EGL (EGL_BAD_MATCH), the
		// stream renegotiates, and screen recording yields no usable frames. Force the
		// GL/EGL path so DMA-BUF import works. (Chromium itself logs this suggestion:
		// "'--ozone-platform=wayland' is not compatible with Vulkan ... disabling Vulkan".)
		app.commandLine.appendSwitch("disable-features", "Vulkan");
	}
}

export const RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings");

async function ensureRecordingsDir() {
	try {
		await fs.mkdir(RECORDINGS_DIR, { recursive: true });
		console.log("RECORDINGS_DIR:", RECORDINGS_DIR);
		console.log("User Data Path:", app.getPath("userData"));
	} catch (error) {
		console.error("Failed to create recordings directory:", error);
	}
}

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
	? path.join(process.env.APP_ROOT, "public")
	: RENDERER_DIST;

// Window references
let mainWindow: BrowserWindow | null = null;
let sourceSelectorWindow: BrowserWindow | null = null;
let countdownOverlayWindow: BrowserWindow | null = null;
let notesWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let selectedSourceName = "";
const isMac = process.platform === "darwin";
const trayIconSize = isMac ? 16 : 24;

// Tray Icons. macOS gets the template mark so it tracks the menu bar's appearance;
// the Windows/Linux tray does no tinting of its own, so it keeps the colour mark.
const defaultTrayIcon = isMac
	? getMenuBarTemplateIcon("screenlyTemplate.png")
	: getTrayIcon("screenly.png", trayIconSize);
const recordingTrayIcon = getTrayIcon("rec-button.png", trayIconSize);

function createWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		return;
	}

	mainWindow = createHudOverlayWindow();
}

function showMainWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
		return;
	}

	createWindow();
}

const stableInstanceLock = acquireStableInstanceLock();
const hasElectronSingleInstanceLock = app.requestSingleInstanceLock();
const hasSingleInstanceLock = Boolean(stableInstanceLock && hasElectronSingleInstanceLock);

if (hasSingleInstanceLock) {
	app.on("second-instance", () => {
		showMainWindow();
	});
} else {
	stableInstanceLock?.release();
	app.quit();
}

function isEditorWindow(window: BrowserWindow) {
	return window.webContents.getURL().includes("windowType=editor");
}

/**
 * Applies a locale chosen from the native Language menu: updates the main-process
 * copy (menu + tray labels), rebuilds the menu so the radio state and labels follow,
 * and tells every open renderer to switch. Renderers persist it themselves.
 */
function applyLocaleFromMenu(locale: string) {
	setMainLocale(locale);
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send("menu-set-locale", locale);
		}
	}
	setupApplicationMenu();
	updateTrayMenu();
}

const GITHUB_REPO_URL = "https://github.com/MadushanKavisekara/screenly";
const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new/choose`;

function sendEditorMenuAction(
	channel:
		| "menu-load-project"
		| "menu-save-project"
		| "menu-save-project-as"
		| "menu-new-project"
		| "menu-new-recording"
		| "menu-save-diagnostics",
) {
	let targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

	if (!targetWindow || targetWindow.isDestroyed() || !isEditorWindow(targetWindow)) {
		createEditorWindowWrapper();
		targetWindow = mainWindow;
		if (!targetWindow || targetWindow.isDestroyed()) return;

		targetWindow.webContents.once("did-finish-load", () => {
			if (!targetWindow || targetWindow.isDestroyed()) return;
			targetWindow.webContents.send(channel);
		});
		return;
	}

	targetWindow.webContents.send(channel);
}

function setupApplicationMenu() {
	const isMac = process.platform === "darwin";
	const template: Electron.MenuItemConstructorOptions[] = [];

	if (isMac) {
		template.push({
			label: app.name,
			submenu: [
				{
					role: "about",
					label: mainT("common", "actions.about") || "About Screenly",
				},
				{ type: "separator" },
				{
					role: "services",
					label: mainT("common", "actions.services") || "Services",
				},
				{ type: "separator" },
				{
					role: "hide",
					label: mainT("common", "actions.hide") || "Hide Screenly",
				},
				{
					role: "hideOthers",
					label: mainT("common", "actions.hideOthers") || "Hide Others",
				},
				{
					role: "unhide",
					label: mainT("common", "actions.unhide") || "Show All",
				},
				{ type: "separator" },
				{ role: "quit", label: mainT("common", "actions.quit") || "Quit" },
			],
		});
	}

	template.push(
		{
			label: mainT("common", "actions.file") || "File",
			submenu: [
				{
					label: mainT("dialogs", "unsavedChanges.newProject") || "New Project",
					accelerator: "CmdOrCtrl+N",
					click: () => sendEditorMenuAction("menu-new-project"),
				},
				{
					label: mainT("editor", "newRecording.title") || "New Recording",
					click: () => sendEditorMenuAction("menu-new-recording"),
				},
				{ type: "separator" as const },
				{
					label: mainT("dialogs", "unsavedChanges.loadProject") || "Load Project…",
					accelerator: "CmdOrCtrl+O",
					click: () => sendEditorMenuAction("menu-load-project"),
				},
				{
					label: mainT("dialogs", "unsavedChanges.saveProject") || "Save Project…",
					accelerator: "CmdOrCtrl+S",
					click: () => sendEditorMenuAction("menu-save-project"),
				},
				{
					label: mainT("dialogs", "unsavedChanges.saveProjectAs") || "Save Project As…",
					accelerator: "CmdOrCtrl+Shift+S",
					click: () => sendEditorMenuAction("menu-save-project-as"),
				},
				...(isMac
					? []
					: [
							{ type: "separator" as const },
							{
								role: "quit" as const,
								label: mainT("common", "actions.quit") || "Quit",
							},
						]),
			],
		},
		{
			label: mainT("common", "actions.edit") || "Edit",
			submenu: [
				{ role: "undo", label: mainT("common", "actions.undo") || "Undo" },
				{ role: "redo", label: mainT("common", "actions.redo") || "Redo" },
				{ type: "separator" },
				{ role: "cut", label: mainT("common", "actions.cut") || "Cut" },
				{ role: "copy", label: mainT("common", "actions.copy") || "Copy" },
				{ role: "paste", label: mainT("common", "actions.paste") || "Paste" },
				{
					role: "selectAll",
					label: mainT("common", "actions.selectAll") || "Select All",
				},
			],
		},
		{
			label: mainT("common", "actions.view") || "View",
			submenu: [
				{
					role: "reload",
					label: mainT("common", "actions.reload") || "Reload",
				},
				{
					role: "forceReload",
					label: mainT("common", "actions.forceReload") || "Force Reload",
				},
				{
					role: "toggleDevTools",
					label: mainT("common", "actions.toggleDevTools") || "Toggle Developer Tools",
				},
				{ type: "separator" },
				{
					role: "resetZoom",
					label: mainT("common", "actions.actualSize") || "Actual Size",
				},
				{
					role: "zoomIn",
					label: mainT("common", "actions.zoomIn") || "Zoom In",
				},
				{
					role: "zoomOut",
					label: mainT("common", "actions.zoomOut") || "Zoom Out",
				},
				{ type: "separator" },
				{
					role: "togglefullscreen",
					label: mainT("common", "actions.toggleFullScreen") || "Toggle Full Screen",
				},
			],
		},
		{
			// Locale switching lives in the OS menu bar rather than in-app chrome.
			label: mainT("launch", "language") || "Language",
			submenu: MAIN_SUPPORTED_LOCALES.map((locale) => ({
				label: getMainLocaleName(locale),
				type: "radio" as const,
				checked: locale === getMainLocale(),
				click: () => applyLocaleFromMenu(locale),
			})),
		},
		{
			label: mainT("common", "actions.window") || "Window",
			submenu: isMac
				? [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{ role: "zoom" },
						{ type: "separator" },
						{ role: "front" },
					]
				: [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{
							role: "close",
							label: mainT("common", "actions.close") || "Close",
						},
					],
		},
		{
			// Support links moved out of the editor's settings panel into the OS menu bar.
			role: "help",
			label: mainT("common", "actions.help") || "Help",
			submenu: [
				{
					label: mainT("settings", "support.reportBug") || "Report Bug",
					click: () => {
						void shell.openExternal(GITHUB_NEW_ISSUE_URL);
					},
				},
				{
					label: mainT("settings", "support.saveDiagnostics") || "Save Diagnostics",
					click: () => sendEditorMenuAction("menu-save-diagnostics"),
				},
				{ type: "separator" },
				{
					label: mainT("settings", "support.starOnGithub") || "Star on GitHub",
					click: () => {
						void shell.openExternal(GITHUB_REPO_URL);
					},
				},
			],
		},
	);

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function createTray() {
	tray = new Tray(defaultTrayIcon);
	tray.on("click", () => {
		showMainWindow();
	});
	tray.on("double-click", () => {
		showMainWindow();
	});
}

function trayIconPath(filename: string) {
	return path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename);
}

function getTrayIcon(filename: string, size: number) {
	return nativeImage.createFromPath(trayIconPath(filename)).resize({
		width: size,
		height: size,
		quality: "best",
	});
}

/**
 * A macOS menu bar mark. Template images are drawn from their alpha channel alone:
 * the system tints them for the light or dark menu bar and inverts them while the
 * menu is open, which is why the artwork is authored as a flat white silhouette and
 * must not carry a colour of its own.
 *
 * No resize here — the PNG is already a 16pt tile and nativeImage pulls its "@2x"
 * sibling in from the same path, so resizing would flatten it back to one blurry
 * representation. (The recording indicator stays a normal image: it has to keep its
 * red to read as a status, which a template can't do.)
 */
function getMenuBarTemplateIcon(filename: string) {
	const image = nativeImage.createFromPath(trayIconPath(filename));
	image.setTemplateImage(true);
	return image;
}

function updateTrayMenu(recording: boolean = false) {
	if (!tray) return;
	const trayIcon = recording ? recordingTrayIcon : defaultTrayIcon;
	const trayToolTip = recording
		? mainT("common", "actions.recordingStatus", {
				source: selectedSourceName,
			}) || `Recording: ${selectedSourceName}`
		: "Screenly";
	const menuTemplate = recording
		? [
				{
					label: mainT("common", "actions.stopRecording") || "Stop Recording",
					click: () => {
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send("stop-recording-from-tray");
						}
					},
				},
			]
		: [
				{
					label: mainT("common", "actions.open") || "Open",
					click: () => {
						showMainWindow();
					},
				},
				{
					label: mainT("common", "actions.quit") || "Quit",
					click: () => {
						app.quit();
					},
				},
			];
	tray.setImage(trayIcon);
	tray.setToolTip(trayToolTip);
	tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

let editorHasUnsavedChanges = false;
let isForceClosing = false;
let isCloseConfirmInFlight = false;
// Set once the app is genuinely on its way out (⌘Q, tray Quit, logout), so the
// window teardown below knows not to bounce back to the recorder.
let isQuitting = false;
// A quit that is parked behind the editor's unsaved-changes prompt: vetoing the
// close cancels app.quit() outright, so we re-issue it once the user answers.
let quitAfterEditorClose = false;

app.on("before-quit", () => {
	isQuitting = true;
});

ipcMain.on("set-has-unsaved-changes", (_, hasChanges: boolean) => {
	editorHasUnsavedChanges = hasChanges;
});

// Quit requested from the editor's in-app File menu. Mirrors the native
// menu's role:"quit" so the unsaved-changes close flow still runs.
ipcMain.on("app-quit", () => {
	app.quit();
});

function forceCloseEditorWindow(windowToClose: BrowserWindow | null) {
	if (!windowToClose || windowToClose.isDestroyed()) return;

	isForceClosing = true;
	setImmediate(() => {
		try {
			if (!windowToClose.isDestroyed()) {
				windowToClose.close();
			}
		} finally {
			isForceClosing = false;
		}
	});
}

function createEditorWindowWrapper() {
	if (mainWindow) {
		isForceClosing = true;
		mainWindow.close();
		isForceClosing = false;
		mainWindow = null;
	}
	const editorWindow = createEditorWindow();
	mainWindow = editorWindow;
	editorHasUnsavedChanges = false;

	// The editor is the one window that earns a Dock tile; it is released again
	// when the window closes.
	claimDockIcon(editorWindow);

	editorWindow.on("close", (event) => {
		if (isForceClosing || !editorHasUnsavedChanges || isCloseConfirmInFlight) return;

		event.preventDefault();
		isCloseConfirmInFlight = true;
		// Vetoing the close already cancelled any in-flight app.quit(); remember
		// whether we owe the user one after they answer the prompt.
		quitAfterEditorClose = isQuitting;
		isQuitting = false;

		if (editorWindow.isDestroyed()) return;

		// Ask renderer to show the in-app close dialog.
		editorWindow.webContents.send("request-close-confirm");

		ipcMain.once("close-confirm-response", (event, choice: "save" | "discard" | "cancel") => {
			if (event.sender.id !== editorWindow.webContents.id) return;
			isCloseConfirmInFlight = false;
			if (editorWindow.isDestroyed()) return;

			if (choice === "save") {
				// Save first, then close when the renderer reports done.
				editorWindow.webContents.send("request-save-before-close");
				ipcMain.once("save-before-close-done", (event, shouldClose: boolean) => {
					if (event.sender.id !== editorWindow.webContents.id) return;
					if (!shouldClose) return;
					forceCloseEditorWindow(editorWindow);
				});
			} else if (choice === "discard") {
				forceCloseEditorWindow(editorWindow);
			} else {
				// "cancel": window stays open, so the parked quit is off too.
				quitAfterEditorClose = false;
			}
		});
	});

	editorWindow.on("closed", () => {
		// Something already replaced this window (Return to Recorder, or a second
		// editor); that flow owns whatever comes next.
		if (mainWindow !== editorWindow) return;
		mainWindow = null;

		if (quitAfterEditorClose) {
			quitAfterEditorClose = false;
			app.quit();
			return;
		}
		if (isQuitting) return;

		// Closing the editor is not "I'm done" — like any Mac app, Screenly stays
		// alive. It drops back to the recorder, which is its home screen.
		showMainWindow();
	});
}

function createSourceSelectorWindowWrapper() {
	sourceSelectorWindow = createSourceSelectorWindow();
	sourceSelectorWindow.on("closed", () => {
		sourceSelectorWindow = null;
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("source-selector-closed");
		}
	});
	return sourceSelectorWindow;
}

function createNotesWindowWrapper() {
	{
		notesWindow = createNotesWindow();
		// Notes is an ordinary text-editing window: "accessory" apps get no menu
		// bar on macOS, and without it ⌘C/⌘V/⌘Z are dead inside the note. Holding
		// the Dock tile while it is open keeps the app "regular".
		claimDockIcon(notesWindow);
		notesWindow.on("closed", () => {
			notesWindow = null;
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("notes-window-closed");
			}
		});
		return notesWindow;
	}
}

function createCountdownOverlayWindowWrapper() {
	if (countdownOverlayWindow && !countdownOverlayWindow.isDestroyed()) {
		return countdownOverlayWindow;
	}

	countdownOverlayWindow = createCountdownOverlayWindow();
	countdownOverlayWindow.on("closed", () => {
		countdownOverlayWindow = null;
	});
	return countdownOverlayWindow;
}

app.on("window-all-closed", () => {
	// macOS: closing the last window never quits an app. Screenly stays in the
	// menu bar and comes back via the tray, the global shortcut, or the Dock icon
	// when one is showing; ⌘Q and the tray's Quit are what actually exit.
	// Elsewhere there is no such convention, so the last window closing ends it.
	if (process.platform === "darwin") return;

	app.quit();
});

app.on("activate", () => {
	// On macOS, re-open a window when the dock icon is clicked and none are open.
	const hasVisibleWindow = BrowserWindow.getAllWindows().some((window) => {
		if (window.isDestroyed() || !window.isVisible()) {
			return false;
		}

		const url = window.webContents.getURL();
		const isCountdownOverlayWindow = url.includes("windowType=countdown-overlay");
		return !isCountdownOverlayWindow;
	});
	if (!hasVisibleWindow) {
		showMainWindow();
	}
});

app.on("will-quit", () => {
	unregisterAllGlobalShortcuts();
	stableInstanceLock?.release();
});

const appReady = hasSingleInstanceLock ? app.whenReady() : null;

appReady?.then(async () => {
	if (isDiagnosticModeEnabled()) {
		mainLogBuffer.install();
		console.info("[diagnostic] SCREENLY_DIAGNOSTIC=1, capturing console.* into ring buffer");
	}

	// Menu-bar app until an editor window opens. See ./macActivation.
	initDockVisibility();

	session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
		const allowed = [
			"media",
			"audioCapture",
			"microphone",
			"videoCapture",
			"camera",
			"screen",
			"display-capture",
		];
		return allowed.includes(permission);
	});

	session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		const allowed = [
			"media",
			"audioCapture",
			"microphone",
			"videoCapture",
			"camera",
			"screen",
			"display-capture",
		];
		callback(allowed.includes(permission));
	});

	session.defaultSession.setDisplayMediaRequestHandler(
		(request, callback) => {
			const source = getSelectedDesktopSource();
			if (!request.videoRequested || !source) {
				callback({});
				return;
			}

			callback({
				video: source,
				...(request.audioRequested && process.platform === "win32" ? { audio: "loopback" } : {}),
			});
		},
		{ useSystemPicker: false },
	);

	// Request mic permission now. Screen Recording is requested lazily from the
	// source-picker action so its prompt isn't hidden behind the selector window.
	if (process.platform === "darwin") {
		const micStatus = systemPreferences.getMediaAccessStatus("microphone");
		if (micStatus !== "granted") {
			await systemPreferences.askForMediaAccess("microphone");
		}
	}

	ipcMain.on("hud-overlay-close", (event) => {
		// The recorder's close button dismisses the window, it does not end the
		// app — that is what the tray's Quit and ⌘Q are for. Hiding rather than
		// destroying keeps the tray's "Open" instant.
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		if (process.platform === "darwin" && senderWindow && !senderWindow.isDestroyed()) {
			senderWindow.hide();
			return;
		}

		app.quit();
	});
	ipcMain.handle("set-locale", (_, locale: string) => {
		setMainLocale(locale);
		setupApplicationMenu();
		updateTrayMenu();
	});

	ipcMain.handle("update-global-shortcut", (_, binding: ShortcutBinding) => {
		const success = registerOpenAppShortcut(binding, showMainWindow);
		return { success };
	});

	createTray();
	updateTrayMenu();
	setupApplicationMenu();
	await ensureRecordingsDir();

	function switchToHudWrapper() {
		if (mainWindow) {
			isForceClosing = true;
			mainWindow.close();
			isForceClosing = false;
			mainWindow = null;
		}
		showMainWindow();
	}

	registerIpcHandlers(
		createEditorWindowWrapper,
		createSourceSelectorWindowWrapper,
		createCountdownOverlayWindowWrapper,
		createNotesWindowWrapper,
		() => mainWindow,
		() => sourceSelectorWindow,
		() => notesWindow,
		() => countdownOverlayWindow,
		(recording: boolean, sourceName: string) => {
			selectedSourceName = sourceName;
			if (!tray) createTray();
			updateTrayMenu(recording);
			if (!recording) {
				showMainWindow();
			}
		},
		switchToHudWrapper,
	);

	await loadAndRegisterGlobalShortcut(showMainWindow);

	createWindow();
});
