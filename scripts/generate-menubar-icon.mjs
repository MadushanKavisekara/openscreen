#!/usr/bin/env node
/**
 * Renders the macOS menu bar icon from icons/source/MenuBarIcon.svg.
 *
 * Outputs a *template image*: macOS ignores the artwork's colour and uses only its
 * alpha, tinting the result for the light or dark menu bar and inverting it while
 * the menu is open. That is why the source is a flat white silhouette and why the
 * app must never ship a coloured menu bar mark — a fixed colour is invisible in one
 * of the two appearances.
 *
 * Two sizes, named for Electron's HiDPI convention: nativeImage.createFromPath()
 * picks up the "@2x" sibling automatically, so the tray gets both representations
 * from a single path.
 *
 *   public/screenlyTemplate.png     16x16  (1x)
 *   public/screenlyTemplate@2x.png  32x32  (2x)
 *
 * The app icon is a separate pipeline — see scripts/generate-icons.mjs.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "icons", "source", "MenuBarIcon.svg");
const PUBLIC_DIR = path.join(ROOT, "public");

/** 16pt tile, as the menu bar expects, at 1x and 2x. */
const OUTPUTS = [
	["screenlyTemplate.png", 16],
	["screenlyTemplate@2x.png", 32],
];

async function main() {
	for (const [name, size] of OUTPUTS) {
		const dest = path.join(PUBLIC_DIR, name);
		await sharp(SOURCE, { density: 1200 })
			.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png()
			.toFile(dest);
		console.log(`  ${path.relative(ROOT, dest)} (${size}x${size})`);
	}
}

console.log(`Menu bar template icon from ${path.relative(ROOT, SOURCE)}:`);
main().catch((error) => {
	console.error(`generate-menubar-icon: ${error.message}`);
	process.exit(1);
});
