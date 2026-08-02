import { app, type BrowserWindow } from "electron";

/**
 * macOS Dock presence.
 *
 * Screenly is a menu-bar app: the HUD recorder, the countdown and the source
 * picker are overlays that have no business owning a Dock tile, so the app runs
 * as an "accessory" (LSUIElement-style) process by default — tray only.
 *
 * The editor is an ordinary document window, so while one is open we flip to
 * "regular", which is what puts the icon in the Dock and hands us the app menu
 * bar (and with it ⌘Q, ⌘C, ⌘V…). The notes window registers too: it is a real
 * text-editing window, and without the menu bar its editing shortcuts are dead.
 */

const isMac = process.platform === "darwin";

/** Window ids that currently justify a Dock tile. */
const dockOwners = new Set<number>();

let appliedRegular: boolean | null = null;

function apply(regular: boolean) {
	if (regular) {
		app.setActivationPolicy("regular");
		void app.dock?.show();
		return;
	}

	app.setActivationPolicy("accessory");
	// Ignored if another hide() happened less than a second ago — the policy
	// call above is the one that actually holds the state.
	app.dock?.hide();
}

function sync() {
	if (!isMac) return;

	const regular = dockOwners.size > 0;
	if (regular === appliedRegular) return;
	appliedRegular = regular;
	apply(regular);

	if (regular) return;

	// setVisibleOnAllWorkspaces() — which the HUD calls as it is recreated right
	// after the editor closes — resurfaces the Dock tile
	// (electron/electron#25368). Re-assert the policy once the overlay has been
	// built.
	setTimeout(() => {
		if (appliedRegular === false) app.setActivationPolicy("accessory");
	}, 0);
}

/**
 * Puts the app in the Dock for as long as `window` is alive. Safe to call on
 * every platform; a no-op off macOS.
 */
export function claimDockIcon(window: BrowserWindow) {
	if (!isMac) return;

	dockOwners.add(window.id);
	window.once("closed", () => {
		dockOwners.delete(window.id);
		sync();
	});
	sync();
}

/** Starts the app out of the Dock. Call once, on app ready. */
export function initDockVisibility() {
	if (!isMac) return;

	appliedRegular = false;
	apply(false);
}
