import { describe, expect, it } from "vitest";
import {
	CursorFileParseError,
	isAniFile,
	parseAniFile,
	parseCurFile,
	parseCursorFile,
} from "./cursorFileFormats";

/** Row stride in a DIB: rows are padded up to a 4-byte boundary. */
function rowSize(width: number, bitCount: number) {
	return (((width * bitCount + 31) / 32) | 0) * 4;
}

function writeAndMask(
	bytes: Uint8Array,
	offset: number,
	width: number,
	height: number,
	/** top-down opacity flags */
	opaque: boolean[][],
) {
	const stride = rowSize(width, 1);
	for (let y = 0; y < height; y += 1) {
		const sourceRow = height - 1 - y;
		for (let x = 0; x < width; x += 1) {
			if (!opaque[y][x]) {
				// A set bit means transparent.
				const at = offset + sourceRow * stride + (x >> 3);
				bytes[at] |= 1 << (7 - (x & 7));
			}
		}
	}
}

function wrapInIconDir(
	payload: Uint8Array,
	opts: { width: number; height: number; hotspotX: number; hotspotY: number; type?: number },
) {
	const out = new Uint8Array(6 + 16 + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true);
	view.setUint16(2, opts.type ?? 2, true);
	view.setUint16(4, 1, true);
	view.setUint8(6, opts.width === 256 ? 0 : opts.width);
	view.setUint8(7, opts.height === 256 ? 0 : opts.height);
	view.setUint16(10, opts.hotspotX, true);
	view.setUint16(12, opts.hotspotY, true);
	view.setUint32(14, payload.byteLength, true);
	view.setUint32(18, 22, true);
	out.set(payload, 22);
	return out;
}

function writeDibHeader(
	view: DataView,
	opts: { width: number; height: number; bitCount: number; paletteCount?: number },
) {
	view.setUint32(0, 40, true);
	view.setInt32(4, opts.width, true);
	// biHeight covers the colour bitmap plus the AND mask.
	view.setInt32(8, opts.height * 2, true);
	view.setUint16(12, 1, true);
	view.setUint16(14, opts.bitCount, true);
	view.setUint32(16, 0, true);
	view.setUint32(32, opts.paletteCount ?? 0, true);
}

/** Builds a 32bpp `.cur` from top-down `[r,g,b,a]` rows. */
function buildCur32(opts: { hotspotX: number; hotspotY: number; pixels: number[][][] }) {
	const height = opts.pixels.length;
	const width = opts.pixels[0].length;
	const colorStride = rowSize(width, 32);
	const maskStride = rowSize(width, 1);
	const payload = new Uint8Array(40 + colorStride * height + maskStride * height);
	writeDibHeader(new DataView(payload.buffer), { width, height, bitCount: 32 });

	for (let y = 0; y < height; y += 1) {
		const sourceRow = height - 1 - y;
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a] = opts.pixels[y][x];
			const at = 40 + sourceRow * colorStride + x * 4;
			payload[at] = b;
			payload[at + 1] = g;
			payload[at + 2] = r;
			payload[at + 3] = a;
		}
	}

	return wrapInIconDir(payload, {
		width,
		height,
		hotspotX: opts.hotspotX,
		hotspotY: opts.hotspotY,
	});
}

/** Builds a 4bpp palettised `.cur` whose transparency comes only from the AND mask. */
function buildCur4bpp(opts: {
	hotspotX: number;
	hotspotY: number;
	/** palette indices, top-down */
	indices: number[][];
	opaque: boolean[][];
	palette: number[][];
}) {
	const height = opts.indices.length;
	const width = opts.indices[0].length;
	const paletteCount = 16;
	const colorStride = rowSize(width, 4);
	const maskStride = rowSize(width, 1);
	const colorOffset = 40 + paletteCount * 4;
	const maskOffset = colorOffset + colorStride * height;
	const payload = new Uint8Array(maskOffset + maskStride * height);
	writeDibHeader(new DataView(payload.buffer), { width, height, bitCount: 4, paletteCount });

	opts.palette.forEach(([r, g, b], index) => {
		const at = 40 + index * 4;
		payload[at] = b;
		payload[at + 1] = g;
		payload[at + 2] = r;
	});

	for (let y = 0; y < height; y += 1) {
		const sourceRow = height - 1 - y;
		for (let x = 0; x < width; x += 1) {
			const at = colorOffset + sourceRow * colorStride + (x >> 1);
			const value = opts.indices[y][x] & 0x0f;
			payload[at] |= x % 2 === 0 ? value << 4 : value;
		}
	}

	writeAndMask(payload, maskOffset, width, height, opts.opaque);

	return wrapInIconDir(payload, {
		width,
		height,
		hotspotX: opts.hotspotX,
		hotspotY: opts.hotspotY,
	});
}

function buildAni(frames: Uint8Array[]) {
	const iconChunks = frames.map((frame) => {
		const padded = frame.byteLength % 2 === 1 ? frame.byteLength + 1 : frame.byteLength;
		const chunk = new Uint8Array(8 + padded);
		chunk.set(new TextEncoder().encode("icon"), 0);
		new DataView(chunk.buffer).setUint32(4, frame.byteLength, true);
		chunk.set(frame, 8);
		return chunk;
	});

	const framListBody = iconChunks.reduce((total, chunk) => total + chunk.byteLength, 4);
	const anihSize = 36;
	const total = 12 + (8 + anihSize) + (8 + framListBody);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	const encoder = new TextEncoder();

	out.set(encoder.encode("RIFF"), 0);
	view.setUint32(4, total - 8, true);
	out.set(encoder.encode("ACON"), 8);

	// An `anih` chunk sits before the frames in every real file; it must be skipped over.
	out.set(encoder.encode("anih"), 12);
	view.setUint32(16, anihSize, true);
	view.setUint32(20, anihSize, true);
	view.setUint32(24, frames.length, true);

	let offset = 12 + 8 + anihSize;
	out.set(encoder.encode("LIST"), offset);
	view.setUint32(offset + 4, framListBody, true);
	out.set(encoder.encode("fram"), offset + 8);
	offset += 12;

	for (const chunk of iconChunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return out;
}

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

function pixelAt(result: { width: number; data: { kind: string } }, x: number, y: number) {
	if (result.data.kind !== "rgba") {
		throw new Error("expected decoded rgba");
	}
	const rgba = (result.data as { rgba: Uint8ClampedArray }).rgba;
	const at = (y * result.width + x) * 4;
	return [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]];
}

describe("parseCurFile", () => {
	it("reads the hotspot the cursor author baked into the file", () => {
		const cur = buildCur32({
			hotspotX: 7,
			hotspotY: 3,
			pixels: [
				[RED, CLEAR],
				[CLEAR, CLEAR],
			],
		});

		const result = parseCurFile(cur);

		expect(result.hotspotX).toBe(7);
		expect(result.hotspotY).toBe(3);
		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
	});

	it("decodes 32bpp pixels the right way up", () => {
		const cur = buildCur32({
			hotspotX: 0,
			hotspotY: 0,
			pixels: [
				[RED, CLEAR],
				[CLEAR, CLEAR],
			],
		});

		const result = parseCurFile(cur);

		// The red pixel is top-left in the image even though DIBs store rows bottom-up.
		expect(pixelAt(result, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixelAt(result, 1, 0)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(result, 0, 1)).toEqual([0, 0, 0, 0]);
	});

	it("takes transparency from the AND mask for palettised cursors", () => {
		const cur = buildCur4bpp({
			hotspotX: 1,
			hotspotY: 1,
			indices: [
				[1, 1],
				[1, 1],
			],
			opaque: [
				[true, false],
				[false, false],
			],
			palette: [
				[0, 0, 0],
				[0, 255, 0],
			],
		});

		const result = parseCurFile(cur);

		expect(pixelAt(result, 0, 0)).toEqual([0, 255, 0, 255]);
		expect(pixelAt(result, 1, 0)).toEqual([0, 255, 0, 0]);
	});

	it("falls back to the AND mask when a 32bpp cursor ships a zeroed alpha channel", () => {
		// Older packs leave alpha at 0 everywhere and rely on the mask; trusting alpha
		// would render the whole cursor invisible.
		const cur = buildCur32({
			hotspotX: 0,
			hotspotY: 0,
			pixels: [
				[[255, 0, 0, 0], CLEAR],
				[CLEAR, CLEAR],
			],
		});
		// Mark only the top-left opaque in the AND mask.
		const maskOffset = 22 + 40 + rowSize(2, 32) * 2;
		writeAndMask(cur, maskOffset, 2, 2, [
			[true, false],
			[false, false],
		]);

		const result = parseCurFile(cur);

		expect(pixelAt(result, 0, 0)[3]).toBe(255);
		expect(pixelAt(result, 1, 0)[3]).toBe(0);
	});

	it("hands back PNG-compressed entries untouched", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const cur = wrapInIconDir(png, { width: 128, height: 128, hotspotX: 4, hotspotY: 2 });

		const result = parseCurFile(cur);

		expect(result.data.kind).toBe("png");
		expect(result.hotspotX).toBe(4);
		expect(result.width).toBe(128);
	});

	it("picks the largest image when a cursor ships several sizes", () => {
		const small = buildCur32({ hotspotX: 0, hotspotY: 0, pixels: [[RED]] });
		const smallPayload = small.slice(22);
		const bigPixels = [
			[RED, RED],
			[RED, RED],
		];
		const big = buildCur32({ hotspotX: 0, hotspotY: 0, pixels: bigPixels });
		const bigPayload = big.slice(22);

		const out = new Uint8Array(6 + 32 + smallPayload.byteLength + bigPayload.byteLength);
		const view = new DataView(out.buffer);
		view.setUint16(2, 2, true);
		view.setUint16(4, 2, true);
		// Entry 0: the 1x1 image. Entry 1: the 2x2 image.
		view.setUint8(6, 1);
		view.setUint8(7, 1);
		view.setUint32(14, smallPayload.byteLength, true);
		view.setUint32(18, 38, true);
		view.setUint8(22, 2);
		view.setUint8(23, 2);
		view.setUint32(30, bigPayload.byteLength, true);
		view.setUint32(34, 38 + smallPayload.byteLength, true);
		out.set(smallPayload, 38);
		out.set(bigPayload, 38 + smallPayload.byteLength);

		expect(parseCurFile(out).width).toBe(2);
	});

	it("ignores the hotspot fields on plain icon containers", () => {
		// Type 1 reuses those bytes for colour planes and bit depth.
		const payload = buildCur32({ hotspotX: 99, hotspotY: 99, pixels: [[RED]] }).slice(22);
		const ico = wrapInIconDir(payload, {
			width: 1,
			height: 1,
			hotspotX: 99,
			hotspotY: 99,
			type: 1,
		});

		const result = parseCurFile(ico);

		expect(result.hotspotX).toBe(0);
		expect(result.hotspotY).toBe(0);
	});

	it("rejects files that are not cursors", () => {
		expect(() => parseCurFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
			CursorFileParseError,
		);
	});
});

describe("parseAniFile", () => {
	it("decodes the first frame of an animated cursor", () => {
		const frame = buildCur32({
			hotspotX: 5,
			hotspotY: 6,
			pixels: [
				[RED, CLEAR],
				[CLEAR, CLEAR],
			],
		});

		const result = parseAniFile(buildAni([frame]));

		expect(result.hotspotX).toBe(5);
		expect(result.hotspotY).toBe(6);
		expect(pixelAt(result, 0, 0)).toEqual([255, 0, 0, 255]);
	});

	it("rejects a RIFF file that is not an animated cursor", () => {
		const notAni = buildAni([buildCur32({ hotspotX: 0, hotspotY: 0, pixels: [[RED]] })]);
		notAni.set(new TextEncoder().encode("WAVE"), 8);

		expect(() => parseAniFile(notAni)).toThrow(CursorFileParseError);
	});
});

describe("parseCursorFile", () => {
	it("sniffs the container from magic bytes rather than the extension", () => {
		const cur = buildCur32({ hotspotX: 1, hotspotY: 2, pixels: [[RED]] });
		const ani = buildAni([cur]);

		expect(isAniFile(cur)).toBe(false);
		expect(isAniFile(ani)).toBe(true);
		expect(parseCursorFile(cur).hotspotX).toBe(1);
		expect(parseCursorFile(ani).hotspotX).toBe(1);
	});
});
