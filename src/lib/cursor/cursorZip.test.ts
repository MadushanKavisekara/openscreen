import { describe, expect, it } from "vitest";
import { CursorZipError, isZipFile, readZipEntries } from "./cursorZip";

interface ZipInput {
	path: string;
	data: Uint8Array;
	/** 0 = stored, 8 = deflate */
	method: number;
	/** Stored verbatim instead of compressing `data`, to simulate a damaged member. */
	payloadOverride?: Uint8Array;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("deflate-raw");
	const writer = stream.writable.getWriter();
	const written = (async () => {
		await writer.write(bytes);
		await writer.close();
	})();

	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	await written;

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Builds a ZIP32 archive. CRCs are left zero — the reader does not verify them. */
async function buildZip(inputs: ZipInput[]): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const prepared = await Promise.all(
		inputs.map(async (input) => ({
			...input,
			name: encoder.encode(input.path),
			payload:
				input.payloadOverride ?? (input.method === 8 ? await deflateRaw(input.data) : input.data),
		})),
	);

	const localSize = prepared.reduce(
		(total, item) => total + 30 + item.name.byteLength + item.payload.byteLength,
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
		view.setUint16(offset + 8, item.method, true);
		view.setUint32(offset + 18, item.payload.byteLength, true);
		view.setUint32(offset + 22, item.data.byteLength, true);
		view.setUint16(offset + 26, item.name.byteLength, true);
		out.set(item.name, offset + 30);
		out.set(item.payload, offset + 30 + item.name.byteLength);
		offset += 30 + item.name.byteLength + item.payload.byteLength;
	}

	const centralStart = offset;
	prepared.forEach((item, index) => {
		view.setUint32(offset, 0x02014b50, true);
		view.setUint16(offset + 10, item.method, true);
		view.setUint32(offset + 20, item.payload.byteLength, true);
		view.setUint32(offset + 24, item.data.byteLength, true);
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

const acceptCursors = (path: string) => /\.(cur|ani)$/i.test(path);

describe("readZipEntries", () => {
	it("reads stored entries", async () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const zip = await buildZip([{ path: "pack/arrow.cur", data, method: 0 }]);

		const entries = await readZipEntries(zip, acceptCursors);

		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe("pack/arrow.cur");
		expect(Array.from(entries[0].bytes)).toEqual([1, 2, 3, 4, 5]);
	});

	it("inflates deflated entries", async () => {
		// Repetitive data so it actually compresses.
		const data = new Uint8Array(2048).fill(7);
		const zip = await buildZip([{ path: "pack/link.ani", data, method: 8 }]);

		const entries = await readZipEntries(zip, acceptCursors);

		expect(entries[0].bytes.byteLength).toBe(2048);
		expect(entries[0].bytes.every((byte) => byte === 7)).toBe(true);
	});

	it("keeps only the members the caller asks for", async () => {
		const data = new Uint8Array([9]);
		const zip = await buildZip([
			{ path: "pack/readme.txt", data, method: 0 },
			{ path: "pack/arrow.cur", data, method: 0 },
			{ path: "pack/preview.png", data, method: 0 },
			{ path: "pack/", data: new Uint8Array(0), method: 0 },
		]);

		const entries = await readZipEntries(zip, acceptCursors);

		expect(entries.map((entry) => entry.path)).toEqual(["pack/arrow.cur"]);
	});

	it("returns the readable cursors when one member is corrupt", async () => {
		const data = new Uint8Array([1, 2, 3]);
		const zip = await buildZip([
			{ path: "pack/good.cur", data, method: 0 },
			// Claims deflate but holds bytes that cannot be inflated.
			{
				path: "pack/bad.cur",
				data,
				method: 8,
				payloadOverride: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
			},
		]);

		const entries = await readZipEntries(zip, acceptCursors);

		expect(entries.map((entry) => entry.path)).toEqual(["pack/good.cur"]);
	});

	it("rejects data that is not a zip", async () => {
		await expect(readZipEntries(new Uint8Array([1, 2, 3]), acceptCursors)).rejects.toThrow(
			CursorZipError,
		);
	});

	it("detects a zip from its signature", async () => {
		const zip = await buildZip([{ path: "a.cur", data: new Uint8Array([1]), method: 0 }]);

		expect(isZipFile(zip)).toBe(true);
		expect(isZipFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
	});
});
