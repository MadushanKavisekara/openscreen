/**
 * Decoders for Windows cursor files (`.cur`) and animated cursors (`.ani`).
 *
 * These are the two formats the rw-designer cursor library ships, and the reason we
 * prefer them over plain images: a `.cur` stores its hotspot — the pixel that actually
 * points at things — in the file header, so an imported cursor lands exactly where the
 * recorded one did instead of being guessed from the artwork.
 *
 * Everything here is pure (no DOM), so it runs in tests and in the main process if ever
 * needed. PNG-encoded entries are handed back as raw bytes for the caller to decode with
 * whatever image API it has; DIB entries are decoded to RGBA in place.
 */

/** A cursor image decoded from a `.cur`/`.ani` container, with its hotspot. */
export interface DecodedCursorBitmap {
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	/**
	 * Straight RGBA for classic DIB entries, or the untouched PNG payload for the
	 * PNG-compressed entries that modern high-resolution cursors use.
	 */
	data:
		| { kind: "rgba"; rgba: Uint8ClampedArray<ArrayBuffer> }
		| { kind: "png"; bytes: Uint8Array<ArrayBuffer> };
}

/** Normalizes either input shape to a plain byte view without copying. */
function toBytes(source: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
	return (
		source instanceof Uint8Array ? source : new Uint8Array(source)
	) as Uint8Array<ArrayBuffer>;
}

export class CursorFileParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorFileParseError";
	}
}

const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;
const BITMAPINFOHEADER_MIN_SIZE = 40;
const BI_RGB = 0;
/** ICONDIR type field: 1 is an icon (no hotspot), 2 is a cursor. */
const RESOURCE_TYPE_ICON = 1;
const RESOURCE_TYPE_CURSOR = 2;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface IconDirEntry {
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	byteLength: number;
	offset: number;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	let result = "";
	for (let i = 0; i < length; i += 1) {
		result += String.fromCharCode(bytes[offset + i] ?? 0);
	}
	return result;
}

function hasPngMagic(bytes: Uint8Array, offset: number): boolean {
	return PNG_MAGIC.every((byte, index) => bytes[offset + index] === byte);
}

/** Row stride in a DIB: every row is padded up to a 4-byte boundary. */
function dibRowSize(width: number, bitCount: number): number {
	return (((width * bitCount + 31) / 32) | 0) * 4;
}

/**
 * Decodes a classic (non-PNG) icon/cursor DIB: a BITMAPINFOHEADER, an optional palette,
 * the bottom-up colour bitmap, and a 1-bit AND mask that supplies transparency for the
 * formats without an alpha channel.
 */
function decodeDib(
	bytes: Uint8Array<ArrayBuffer>,
	payloadOffset: number,
	payloadLength: number,
	entryHeight: number,
): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
	if (payloadLength < BITMAPINFOHEADER_MIN_SIZE) {
		throw new CursorFileParseError("Cursor image header is truncated");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset + payloadOffset, payloadLength);
	const headerSize = view.getUint32(0, true);
	if (headerSize < BITMAPINFOHEADER_MIN_SIZE || headerSize > payloadLength) {
		throw new CursorFileParseError(`Unsupported cursor bitmap header size: ${headerSize}`);
	}

	const width = view.getInt32(4, true);
	const storedHeight = view.getInt32(8, true);
	const bitCount = view.getUint16(14, true);
	const compression = view.getUint32(16, true);
	const paletteEntriesUsed = view.getUint32(32, true);

	if (compression !== BI_RGB) {
		throw new CursorFileParseError(
			`Compressed cursor bitmaps are not supported (compression ${compression})`,
		);
	}
	if (width <= 0 || storedHeight === 0) {
		throw new CursorFileParseError("Cursor bitmap has no pixels");
	}

	// biHeight covers the colour bitmap *and* the AND mask stacked beneath it, so it is
	// normally twice the real height. Tolerate files that omit the mask.
	const hasAndMask = storedHeight === entryHeight * 2 || (storedHeight % 2 === 0 && !entryHeight);
	const height = hasAndMask ? Math.floor(storedHeight / 2) : storedHeight;
	if (height <= 0) {
		throw new CursorFileParseError("Cursor bitmap has no pixels");
	}

	const paletteCount = bitCount <= 8 ? paletteEntriesUsed || 1 << bitCount : 0;
	const paletteOffset = headerSize;
	const colorOffset = paletteOffset + paletteCount * 4;
	const colorRowSize = dibRowSize(width, bitCount);
	const maskRowSize = dibRowSize(width, 1);
	const maskOffset = colorOffset + colorRowSize * height;

	const requiredLength = hasAndMask ? maskOffset + maskRowSize * height : maskOffset;
	if (requiredLength > payloadLength) {
		throw new CursorFileParseError("Cursor bitmap data is truncated");
	}

	const base = payloadOffset;
	const rgba = new Uint8ClampedArray(width * height * 4);
	let sawNonZeroAlpha = false;

	const maskSaysOpaque = (x: number, sourceRow: number): boolean => {
		if (!hasAndMask) {
			return true;
		}
		const byte = bytes[base + maskOffset + sourceRow * maskRowSize + (x >> 3)] ?? 0;
		// A set bit means "leave the screen alone", i.e. transparent.
		return ((byte >> (7 - (x & 7))) & 1) === 0;
	};

	const readPaletteColor = (index: number): [number, number, number] => {
		const at = base + paletteOffset + index * 4;
		return [bytes[at + 2] ?? 0, bytes[at + 1] ?? 0, bytes[at] ?? 0];
	};

	for (let y = 0; y < height; y += 1) {
		// DIBs are stored bottom-up.
		const sourceRow = height - 1 - y;
		const rowStart = base + colorOffset + sourceRow * colorRowSize;

		for (let x = 0; x < width; x += 1) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 255;

			switch (bitCount) {
				case 32: {
					const at = rowStart + x * 4;
					b = bytes[at] ?? 0;
					g = bytes[at + 1] ?? 0;
					r = bytes[at + 2] ?? 0;
					a = bytes[at + 3] ?? 0;
					if (a !== 0) {
						sawNonZeroAlpha = true;
					}
					break;
				}
				case 24: {
					const at = rowStart + x * 3;
					b = bytes[at] ?? 0;
					g = bytes[at + 1] ?? 0;
					r = bytes[at + 2] ?? 0;
					a = maskSaysOpaque(x, sourceRow) ? 255 : 0;
					break;
				}
				case 8: {
					[r, g, b] = readPaletteColor(bytes[rowStart + x] ?? 0);
					a = maskSaysOpaque(x, sourceRow) ? 255 : 0;
					break;
				}
				case 4: {
					const byte = bytes[rowStart + (x >> 1)] ?? 0;
					const index = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
					[r, g, b] = readPaletteColor(index);
					a = maskSaysOpaque(x, sourceRow) ? 255 : 0;
					break;
				}
				case 1: {
					const byte = bytes[rowStart + (x >> 3)] ?? 0;
					const index = (byte >> (7 - (x & 7))) & 1;
					[r, g, b] = readPaletteColor(index);
					a = maskSaysOpaque(x, sourceRow) ? 255 : 0;
					break;
				}
				default:
					throw new CursorFileParseError(`Unsupported cursor colour depth: ${bitCount}-bit`);
			}

			const target = (y * width + x) * 4;
			rgba[target] = r;
			rgba[target + 1] = g;
			rgba[target + 2] = b;
			rgba[target + 3] = a;
		}
	}

	// Plenty of older 32-bit cursors ship a zeroed alpha channel and rely entirely on the
	// AND mask. Taking their alpha at face value would render the cursor fully invisible.
	if (bitCount === 32 && !sawNonZeroAlpha && hasAndMask) {
		for (let y = 0; y < height; y += 1) {
			const sourceRow = height - 1 - y;
			for (let x = 0; x < width; x += 1) {
				rgba[(y * width + x) * 4 + 3] = maskSaysOpaque(x, sourceRow) ? 255 : 0;
			}
		}
	}

	return { width, height, rgba };
}

function readIconDirEntries(
	bytes: Uint8Array<ArrayBuffer>,
	isCursor: boolean,
	count: number,
): IconDirEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries: IconDirEntry[] = [];

	for (let i = 0; i < count; i += 1) {
		const at = ICONDIR_SIZE + i * ICONDIRENTRY_SIZE;
		if (at + ICONDIRENTRY_SIZE > bytes.byteLength) {
			break;
		}
		entries.push({
			// A stored dimension of 0 means 256 — the byte cannot hold 256 itself.
			width: view.getUint8(at) || 256,
			height: view.getUint8(at + 1) || 256,
			// Icons reuse these two fields for colour planes and bit depth, so only trust
			// them as a hotspot when the container is actually a cursor.
			hotspotX: isCursor ? view.getUint16(at + 4, true) : 0,
			hotspotY: isCursor ? view.getUint16(at + 6, true) : 0,
			byteLength: view.getUint32(at + 8, true),
			offset: view.getUint32(at + 12, true),
		});
	}

	return entries;
}

/**
 * Decodes a `.cur` (or bare `.ico`) container, picking the largest available image so a
 * pack that ships both 32px and 128px art keeps the crisper one.
 */
export function parseCurFile(source: ArrayBuffer | Uint8Array): DecodedCursorBitmap {
	const bytes = toBytes(source);
	if (bytes.byteLength < ICONDIR_SIZE + ICONDIRENTRY_SIZE) {
		throw new CursorFileParseError("File is too small to be a cursor");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(0, true) !== 0) {
		throw new CursorFileParseError("Not a cursor file");
	}

	const resourceType = view.getUint16(2, true);
	if (resourceType !== RESOURCE_TYPE_CURSOR && resourceType !== RESOURCE_TYPE_ICON) {
		throw new CursorFileParseError("Not a cursor file");
	}

	const count = view.getUint16(4, true);
	if (count === 0) {
		throw new CursorFileParseError("Cursor file contains no images");
	}

	const entries = readIconDirEntries(bytes, resourceType === RESOURCE_TYPE_CURSOR, count).filter(
		(entry) => entry.byteLength > 0 && entry.offset + entry.byteLength <= bytes.byteLength,
	);
	if (entries.length === 0) {
		throw new CursorFileParseError("Cursor file contains no usable images");
	}

	const best = entries.reduce((chosen, entry) =>
		entry.width * entry.height > chosen.width * chosen.height ? entry : chosen,
	);

	if (hasPngMagic(bytes, best.offset)) {
		return {
			width: best.width,
			height: best.height,
			hotspotX: best.hotspotX,
			hotspotY: best.hotspotY,
			data: { kind: "png", bytes: bytes.slice(best.offset, best.offset + best.byteLength) },
		};
	}

	const decoded = decodeDib(bytes, best.offset, best.byteLength, best.height);
	return {
		width: decoded.width,
		height: decoded.height,
		hotspotX: best.hotspotX,
		hotspotY: best.hotspotY,
		data: { kind: "rgba", rgba: decoded.rgba },
	};
}

/**
 * Finds the first embedded `icon` chunk inside a RIFF range, descending into LIST chunks.
 * Chunk bodies are word-aligned, so odd-length bodies carry a trailing pad byte.
 */
function findFirstIconChunk(
	bytes: Uint8Array<ArrayBuffer>,
	start: number,
	end: number,
): Uint8Array<ArrayBuffer> | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = start;

	while (offset + 8 <= end) {
		const id = readAscii(bytes, offset, 4);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (body + size > end) {
			break;
		}

		if (id === "icon") {
			return bytes.subarray(body, body + size);
		}
		if (id === "LIST" && size >= 4) {
			const nested = findFirstIconChunk(bytes, body + 4, body + size);
			if (nested) {
				return nested;
			}
		}

		offset = body + size + (size % 2);
	}

	return null;
}

/**
 * Decodes an animated cursor by taking its first frame.
 *
 * The editor paints one cursor image per video frame, so animation would be a separate
 * feature; flattening matches how the bundled "animated" packs already ship as stills.
 */
export function parseAniFile(source: ArrayBuffer | Uint8Array): DecodedCursorBitmap {
	const bytes = toBytes(source);
	if (bytes.byteLength < 12) {
		throw new CursorFileParseError("File is too small to be an animated cursor");
	}
	if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "ACON") {
		throw new CursorFileParseError("Not an animated cursor file");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const riffSize = view.getUint32(4, true);
	const end = Math.min(bytes.byteLength, 8 + riffSize);

	const iconChunk = findFirstIconChunk(bytes, 12, end);
	if (!iconChunk) {
		throw new CursorFileParseError("Animated cursor contains no frames");
	}

	return parseCurFile(iconChunk);
}

/** True when the bytes start with a RIFF/ACON signature, i.e. an animated cursor. */
export function isAniFile(source: ArrayBuffer | Uint8Array): boolean {
	const bytes = toBytes(source);
	return (
		bytes.byteLength >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "ACON"
	);
}

/**
 * Decodes a cursor file of either supported format, sniffing the container from its magic
 * bytes rather than trusting the file extension.
 */
export function parseCursorFile(source: ArrayBuffer | Uint8Array): DecodedCursorBitmap {
	return isAniFile(source) ? parseAniFile(source) : parseCurFile(source);
}
