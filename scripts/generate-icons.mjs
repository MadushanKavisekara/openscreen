#!/usr/bin/env node
/**
 * Regenerates every packaged icon from a single authored source in icons/source/.
 *
 * Source precedence:
 *   1. icons/source/AppIcon.icns  — exported from Icon Composer (keeps Apple's own
 *      multi-representation data, so this is what ships as the macOS icon verbatim)
 *   2. icons/source/AppIcon.png   — a flat 1024x1024 master, converted to .icns here
 *
 * Outputs:
 *   icons/generated/mac/icon.icns   macOS (electron-builder mac.icon)
 *   icons/generated/win/icon.ico    Windows (electron-builder win.icon)
 *   icons/generated/png/<n>x<n>.png Linux (electron-builder linux.icon)
 *
 * public/screenly.png is deliberately not generated here — the menu bar needs its own
 * minimal mark, not a scaled-down app icon.
 *
 * The dynamic Liquid Glass variant is a separate concern: scripts/after-pack-icon.cjs
 * compiles icons/source/AppIcon.icon at package time when actool is available.
 *
 * Only uses tools present on a stock macOS (sips, iconutil) — no ImageMagick, no sharp.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "icons", "source");
const MAC_DIR = path.join(ROOT, "icons", "generated", "mac");
const WIN_DIR = path.join(ROOT, "icons", "generated", "win");
const PNG_DIR = path.join(ROOT, "icons", "generated", "png");

/** Sizes electron-builder expects under linux.icon. */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** ICO stores width/height in a single byte, so 256 is the ceiling. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** iconutil's fixed .iconset naming, mapped to the pixel size we render. */
const ICONSET_ENTRIES = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];

function run(cmd, args) {
	return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** Resize `src` into a square `size`x`size` PNG at `dest`. */
function resize(src, dest, size) {
	run("sips", ["-s", "format", "png", "-z", String(size), String(size), src, "--out", dest]);
}

/**
 * Minimal ICO container: the header plus one embedded PNG per size. Windows has
 * accepted PNG-compressed ICO entries since Vista, which is well below Electron's floor.
 */
function buildIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // 1 = icon
	header.writeUInt16LE(images.length, 4);

	const directory = Buffer.alloc(16 * images.length);
	let offset = header.length + directory.length;

	images.forEach(({ size, data }, index) => {
		const entry = 16 * index;
		directory.writeUInt8(size >= 256 ? 0 : size, entry + 0); // 0 encodes 256
		directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		directory.writeUInt8(0, entry + 2); // palette size (0 = truecolor)
		directory.writeUInt8(0, entry + 3); // reserved
		directory.writeUInt16LE(1, entry + 4); // color planes
		directory.writeUInt16LE(32, entry + 6); // bits per pixel
		directory.writeUInt32LE(data.length, entry + 8);
		directory.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});

	return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

async function resolveSource() {
	const icns = path.join(SOURCE_DIR, "AppIcon.icns");
	const png = path.join(SOURCE_DIR, "AppIcon.png");

	if (existsSync(icns)) {
		return { kind: "icns", file: icns };
	}
	if (existsSync(png)) {
		return { kind: "png", file: png };
	}

	throw new Error(
		`No icon source found. Export from Icon Composer and place it at one of:\n` +
			`  ${path.relative(ROOT, icns)}  (preferred)\n` +
			`  ${path.relative(ROOT, png)}   (flat 1024x1024 master)`,
	);
}

/** Produce the 1024px master PNG that every raster output is derived from. */
async function extractMaster(source, workDir) {
	const master = path.join(workDir, "master.png");

	if (source.kind === "png") {
		resize(source.file, master, 1024);
		return master;
	}

	// iconutil writes the .iconset next to the source unless told otherwise.
	const iconset = path.join(workDir, "extracted.iconset");
	run("iconutil", ["--convert", "iconset", "--output", iconset, source.file]);

	const largest = ["icon_512x512@2x.png", "icon_512x512.png", "icon_256x256@2x.png"]
		.map((name) => path.join(iconset, name))
		.find((file) => existsSync(file));

	if (!largest) {
		throw new Error(
			`${path.relative(ROOT, source.file)} has no representation at 512px or larger. ` +
				`Re-export it including the 512pt slot.`,
		);
	}

	resize(largest, master, 1024);
	return master;
}

async function writeMacIcns(source, master, workDir) {
	await mkdir(MAC_DIR, { recursive: true });
	const dest = path.join(MAC_DIR, "icon.icns");

	if (source.kind === "icns") {
		// Ship Apple's export untouched — round-tripping it through sips would
		// discard representations the exporter put there on purpose.
		await writeFile(dest, await readFile(source.file));
		return;
	}

	const iconset = path.join(workDir, "build.iconset");
	await mkdir(iconset, { recursive: true });
	for (const [name, size] of ICONSET_ENTRIES) {
		resize(master, path.join(iconset, name), size);
	}
	run("iconutil", ["--convert", "icns", "--output", dest, iconset]);
}

async function writeLinuxPngs(master) {
	await mkdir(PNG_DIR, { recursive: true });
	for (const size of PNG_SIZES) {
		resize(master, path.join(PNG_DIR, `${size}x${size}.png`), size);
	}
}

async function writeWindowsIco(master, workDir) {
	await mkdir(WIN_DIR, { recursive: true });

	const images = [];
	for (const size of ICO_SIZES) {
		const file = path.join(workDir, `ico-${size}.png`);
		resize(master, file, size);
		images.push({ size, data: await readFile(file) });
	}

	await writeFile(path.join(WIN_DIR, "icon.ico"), buildIco(images));
}

async function main() {
	if (process.platform !== "darwin") {
		throw new Error("Icon generation relies on sips/iconutil and must run on macOS.");
	}

	const source = await resolveSource();
	const workDir = await mkdtemp(path.join(tmpdir(), "openscreen-icons-"));

	try {
		const master = await extractMaster(source, workDir);

		await writeMacIcns(source, master, workDir);
		await writeLinuxPngs(master);
		await writeWindowsIco(master, workDir);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}

	console.log(`Icons regenerated from ${path.relative(ROOT, source.file)}:`);
	console.log(`  ${path.relative(ROOT, path.join(MAC_DIR, "icon.icns"))}`);
	console.log(
		`  ${path.relative(ROOT, path.join(WIN_DIR, "icon.ico"))} (${ICO_SIZES.length} sizes)`,
	);
	console.log(`  ${path.relative(ROOT, PNG_DIR)}/ (${PNG_SIZES.length} sizes)`);
}

main().catch((error) => {
	console.error(`generate-icons: ${error.message}`);
	process.exit(1);
});
