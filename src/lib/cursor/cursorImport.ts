import type { NativeCursorType } from "@/native/contracts";
import { type DecodedCursorBitmap, parseCursorFile } from "./cursorFileFormats";
import { assignCursorRoles, type RoleMatchConfidence } from "./cursorRoleMapping";
import type { CursorThemeAsset } from "./cursorThemes";
import { isZipFile, readZipEntries } from "./cursorZip";
import {
	type CustomCursorPack,
	fingerprintCursorAssets,
	generateCustomCursorId,
} from "./customCursors";

/**
 * Turns downloaded cursor files into a pack the editor can draw.
 *
 * Accepts a cursor set's `.zip` straight from the download folder, or loose `.cur`/`.ani`
 * files, and nothing else — those formats carry the hotspot, which is what makes an
 * imported cursor land on the right pixel instead of being guessed from the artwork.
 */

export const CURSOR_IMPORT_ACCEPT = ".cur,.ani,.zip";

/**
 * The logical size every theme asset is expressed in, matching the bundled packs, so an
 * imported cursor appears the same size on screen as the default art whatever resolution
 * its source happened to be.
 */
const LOGICAL_REFERENCE_SIZE = 32;
/** Stored artwork is capped here: enough for crisp retina output, small enough to keep. */
const MAX_STORED_PIXELS = 128;
/** A cursor pack should never contain more files than a generous full Windows scheme. */
const MAX_FILES_PER_IMPORT = 64;

export interface ImportedCursorFile {
	/** Path inside the archive, or the plain file name for a loose upload. */
	path: string;
	/** PNG data URL of the artwork, downscaled for storage. */
	dataUrl: string;
	/** Role guessed from the file name; null when it could not be placed. */
	role: NativeCursorType | null;
	confidence: RoleMatchConfidence;
	/** Metrics already normalized to the logical reference size. */
	asset: Omit<CursorThemeAsset, "assetPath">;
}

export interface CursorImportResult {
	files: ImportedCursorFile[];
	/** Names of files that could not be read, for reporting after a partial import. */
	skipped: string[];
	suggestedName: string;
}

export class CursorImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorImportError";
	}
}

function hasCursorExtension(path: string): boolean {
	return /\.(cur|ani)$/i.test(path);
}

/**
 * Rescales a cursor's intrinsic size and hotspot into the logical reference space.
 *
 * The longest side maps to the reference so non-square art keeps its proportions, and the
 * hotspot moves with it — a 128px pack's hotspot ends up divided by four.
 */
export function normalizeCursorMetrics(
	width: number,
	height: number,
	hotspotX: number,
	hotspotY: number,
): Omit<CursorThemeAsset, "assetPath"> {
	const longestSide = Math.max(width, height);
	const scale = longestSide > 0 ? LOGICAL_REFERENCE_SIZE / longestSide : 1;

	return {
		width: width * scale,
		height: height * scale,
		// Clamp inside the artwork: a corrupt header should not fling the cursor off-target.
		hotspotX: Math.min(Math.max(hotspotX, 0), width) * scale,
		hotspotY: Math.min(Math.max(hotspotY, 0), height) * scale,
	};
}

/** Suggests a pack name from the archive name, or the shared prefix of the files. */
export function suggestPackName(sourceName: string, filePaths: readonly string[]): string {
	const titleCase = (value: string) =>
		value
			.split(/[-_\s]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");

	const archiveBase = sourceName.replace(/\.[^.]+$/, "").trim();
	if (archiveBase && !hasCursorExtension(sourceName)) {
		return titleCase(archiveBase);
	}

	// Loose files: fall back to the common prefix, e.g. "Nyan-Cat-normal.cur" -> "Nyan Cat".
	const names = filePaths.map((path) =>
		(path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, ""),
	);
	if (names.length === 0) {
		return "";
	}

	let prefix = names[0];
	for (const name of names.slice(1)) {
		let i = 0;
		while (
			i < prefix.length &&
			i < name.length &&
			prefix[i].toLowerCase() === name[i].toLowerCase()
		) {
			i += 1;
		}
		prefix = prefix.slice(0, i);
	}

	const cleaned = prefix.replace(/[-_\s]+$/, "").trim();
	return titleCase(cleaned || names[0]);
}

async function decodeToImage(bitmap: DecodedCursorBitmap): Promise<CanvasImageSource> {
	if (bitmap.data.kind === "png") {
		// Copy into a fresh buffer: the slice may be a view over the whole archive.
		const bytes = new Uint8Array(bitmap.data.bytes);
		return createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
	}

	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new CursorImportError("Could not read cursor image data");
	}
	context.putImageData(new ImageData(bitmap.data.rgba, bitmap.width, bitmap.height), 0, 0);
	return canvas;
}

/** Renders decoded cursor art to a PNG data URL, downscaling only when oversized. */
async function toPngDataUrl(bitmap: DecodedCursorBitmap): Promise<string> {
	const source = await decodeToImage(bitmap);
	const longestSide = Math.max(bitmap.width, bitmap.height);
	const scale = longestSide > MAX_STORED_PIXELS ? MAX_STORED_PIXELS / longestSide : 1;

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const context = canvas.getContext("2d");
	if (!context) {
		throw new CursorImportError("Could not read cursor image data");
	}
	context.imageSmoothingQuality = "high";
	context.drawImage(source, 0, 0, canvas.width, canvas.height);

	if (source instanceof ImageBitmap) {
		source.close();
	}

	return canvas.toDataURL("image/png");
}

/** Expands the selection into individual cursor files, unpacking any archives. */
async function collectCursorSources(
	files: readonly File[],
): Promise<{ sources: Array<{ path: string; bytes: Uint8Array }>; skipped: string[] }> {
	const sources: Array<{ path: string; bytes: Uint8Array }> = [];
	const skipped: string[] = [];

	for (const file of files) {
		const buffer = new Uint8Array(await file.arrayBuffer());

		if (isZipFile(buffer)) {
			try {
				const entries = await readZipEntries(buffer, hasCursorExtension);
				if (entries.length === 0) {
					skipped.push(file.name);
					continue;
				}
				sources.push(...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes })));
			} catch {
				skipped.push(file.name);
			}
			continue;
		}

		if (!hasCursorExtension(file.name)) {
			skipped.push(file.name);
			continue;
		}
		sources.push({ path: file.name, bytes: buffer });
	}

	return { sources, skipped };
}

/**
 * Reads a selection of cursor files into decoded, role-tagged entries ready for the
 * import screen. Unreadable files are reported rather than failing the whole import, so
 * one bad member of a pack still leaves the rest usable.
 */
export async function readCursorImport(files: readonly File[]): Promise<CursorImportResult> {
	if (files.length === 0) {
		throw new CursorImportError("No files selected");
	}

	const { sources, skipped } = await collectCursorSources(files);
	if (sources.length === 0) {
		throw new CursorImportError("No cursor files found");
	}

	const decoded: Array<{ path: string; bitmap: DecodedCursorBitmap }> = [];
	for (const source of sources.slice(0, MAX_FILES_PER_IMPORT)) {
		try {
			decoded.push({ path: source.path, bitmap: parseCursorFile(source.bytes) });
		} catch {
			skipped.push(source.path);
		}
	}

	if (decoded.length === 0) {
		throw new CursorImportError("No cursor files could be read");
	}

	const withRoles = assignCursorRoles(decoded);
	const imported: ImportedCursorFile[] = [];

	for (const entry of withRoles) {
		try {
			imported.push({
				path: entry.path,
				dataUrl: await toPngDataUrl(entry.bitmap),
				role: entry.role,
				confidence: entry.confidence,
				asset: normalizeCursorMetrics(
					entry.bitmap.width,
					entry.bitmap.height,
					entry.bitmap.hotspotX,
					entry.bitmap.hotspotY,
				),
			});
		} catch {
			skipped.push(entry.path);
		}
	}

	if (imported.length === 0) {
		throw new CursorImportError("No cursor files could be read");
	}

	return {
		files: imported,
		skipped,
		suggestedName: suggestPackName(
			files.length === 1 ? files[0].name : "",
			imported.map((entry) => entry.path),
		),
	};
}

/**
 * Builds a storable pack from the roles the user confirmed. Entries left unassigned are
 * dropped; their roles simply fall back to the default cursor art at draw time.
 */
export async function buildCursorPack(
	name: string,
	files: readonly ImportedCursorFile[],
): Promise<CustomCursorPack> {
	const assets: Partial<Record<NativeCursorType, CursorThemeAsset>> = {};

	for (const file of files) {
		if (!file.role || assets[file.role]) {
			continue;
		}
		assets[file.role] = { ...file.asset, assetUrl: file.dataUrl };
	}

	if (Object.keys(assets).length === 0) {
		throw new CursorImportError("No cursors were assigned a role");
	}

	return {
		id: generateCustomCursorId(),
		name: name.trim() || "Custom cursors",
		fingerprint: await fingerprintCursorAssets(assets),
		createdAt: Date.now(),
		assets,
	};
}
