import { describe, expect, it } from "vitest";
import { buildCursorPack, readCursorImport } from "./cursorImport";

/**
 * End-to-end import in a real browser.
 *
 * The decoding steps that matter here — canvas rasterisation, `createImageBitmap`, and
 * `DecompressionStream` for archives — do not exist under jsdom, so this is the only
 * place the full path from downloaded file to drawable artwork is actually exercised.
 */

/** Row stride in a DIB: rows are padded up to a 4-byte boundary. */
function rowSize(width: number, bitCount: number) {
	return (((width * bitCount + 31) / 32) | 0) * 4;
}

/** Builds a real 32bpp `.cur` of a solid colour with the given hotspot. */
function buildCur(size: number, hotspotX: number, hotspotY: number, rgb: [number, number, number]) {
	const colorStride = rowSize(size, 32);
	const maskStride = rowSize(size, 1);
	const payloadLength = 40 + colorStride * size + maskStride * size;
	const out = new Uint8Array(6 + 16 + payloadLength);
	const view = new DataView(out.buffer);

	view.setUint16(2, 2, true);
	view.setUint16(4, 1, true);
	view.setUint8(6, size);
	view.setUint8(7, size);
	view.setUint16(10, hotspotX, true);
	view.setUint16(12, hotspotY, true);
	view.setUint32(14, payloadLength, true);
	view.setUint32(18, 22, true);

	const dib = 22;
	view.setUint32(dib, 40, true);
	view.setInt32(dib + 4, size, true);
	view.setInt32(dib + 8, size * 2, true);
	view.setUint16(dib + 12, 1, true);
	view.setUint16(dib + 14, 32, true);

	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const at = dib + 40 + y * colorStride + x * 4;
			out[at] = rgb[2];
			out[at + 1] = rgb[1];
			out[at + 2] = rgb[0];
			out[at + 3] = 255;
		}
	}

	return out;
}

function toFile(bytes: Uint8Array, name: string) {
	return new File([bytes as BlobPart], name);
}

async function buildZip(entries: Array<{ path: string; bytes: Uint8Array }>) {
	const encoder = new TextEncoder();
	const prepared = entries.map((entry) => ({ ...entry, name: encoder.encode(entry.path) }));
	const localSize = prepared.reduce(
		(total, item) => total + 30 + item.name.byteLength + item.bytes.byteLength,
		0,
	);
	const centralSize = prepared.reduce((total, item) => total + 46 + item.name.byteLength, 0);
	const out = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(out.buffer);

	let offset = 0;
	const localOffsets: number[] = [];
	for (const item of prepared) {
		localOffsets.push(offset);
		view.setUint32(offset, 0x04034b50, true);
		view.setUint32(offset + 18, item.bytes.byteLength, true);
		view.setUint32(offset + 22, item.bytes.byteLength, true);
		view.setUint16(offset + 26, item.name.byteLength, true);
		out.set(item.name, offset + 30);
		out.set(item.bytes, offset + 30 + item.name.byteLength);
		offset += 30 + item.name.byteLength + item.bytes.byteLength;
	}

	const centralStart = offset;
	prepared.forEach((item, index) => {
		view.setUint32(offset, 0x02014b50, true);
		view.setUint32(offset + 20, item.bytes.byteLength, true);
		view.setUint32(offset + 24, item.bytes.byteLength, true);
		view.setUint16(offset + 28, item.name.byteLength, true);
		view.setUint32(offset + 42, localOffsets[index], true);
		out.set(item.name, offset + 46);
		offset += 46 + item.name.byteLength;
	});

	view.setUint32(offset, 0x06054b50, true);
	view.setUint16(offset + 8, prepared.length, true);
	view.setUint16(offset + 10, prepared.length, true);
	view.setUint32(offset + 12, centralSize, true);
	view.setUint32(offset + 16, centralStart, true);

	return out;
}

/** Reads a data URL back into pixels so the decoded artwork can be checked. */
async function readPixel(dataUrl: string): Promise<[number, number, number, number]> {
	const image = new Image();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("failed to load imported cursor"));
		image.src = dataUrl;
	});

	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext("2d")!;
	context.drawImage(image, 0, 0);
	const data = context.getImageData(0, 0, 1, 1).data;
	return [data[0], data[1], data[2], data[3]];
}

describe("importing real cursor files", () => {
	it("turns a loose .cur into drawable artwork with its hotspot intact", async () => {
		const cur = buildCur(32, 6, 4, [255, 0, 0]);

		const result = await readCursorImport([toFile(cur, "Nyan-Cat-normal.cur")]);

		expect(result.files).toHaveLength(1);
		const [entry] = result.files;
		expect(entry.role).toBe("arrow");
		// A 32px cursor maps 1:1 onto the logical reference.
		expect(entry.asset).toEqual({ width: 32, height: 32, hotspotX: 6, hotspotY: 4 });
		expect(entry.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		expect(await readPixel(entry.dataUrl)).toEqual([255, 0, 0, 255]);
	});

	it("imports a whole cursor set from its downloaded zip", async () => {
		const zip = await buildZip([
			{ path: "nyan-cat/Nyan-Cat-normal.cur", bytes: buildCur(32, 1, 1, [255, 0, 0]) },
			{ path: "nyan-cat/Nyan-Cat-link.cur", bytes: buildCur(32, 8, 2, [0, 255, 0]) },
			{ path: "nyan-cat/Nyan-Cat-text.cur", bytes: buildCur(32, 4, 8, [0, 0, 255]) },
			{ path: "nyan-cat/readme.txt", bytes: new Uint8Array([1, 2, 3]) },
		]);

		const result = await readCursorImport([toFile(zip, "nyan-cat.zip")]);

		expect(result.suggestedName).toBe("Nyan Cat");
		expect(result.files.map((file) => file.role).sort()).toEqual(["arrow", "pointer", "text"]);

		const pack = await buildCursorPack(result.suggestedName, result.files);
		expect(pack.name).toBe("Nyan Cat");
		expect(Object.keys(pack.assets).sort()).toEqual(["arrow", "pointer", "text"]);
		// The Link Select file keeps the hotspot its author set.
		expect(pack.assets.pointer?.hotspotX).toBe(8);
		expect(pack.assets.pointer?.assetUrl?.startsWith("data:image/png;base64,")).toBe(true);
		expect(pack.fingerprint).toHaveLength(64);
	});

	it("scales a high-resolution cursor down to the logical reference", async () => {
		const cur = buildCur(128, 32, 16, [255, 255, 0]);

		const [entry] = (await readCursorImport([toFile(cur, "big-normal.cur")])).files;

		expect(entry.asset).toEqual({ width: 32, height: 32, hotspotX: 8, hotspotY: 4 });
	});

	it("rejects a selection with no cursor files in it", async () => {
		const notACursor = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

		await expect(readCursorImport([toFile(notACursor, "photo.png")])).rejects.toThrow();
	});
});
