/**
 * A minimal ZIP reader for cursor set archives.
 *
 * Cursor packs download as a zip of `.cur`/`.ani` files, so the app opens the archive
 * itself rather than making the user extract it first. This reads the central directory
 * and inflates entries with the platform's own `DecompressionStream`, which keeps a whole
 * compression library out of the bundle for what amounts to a few hundred KB of cursors.
 *
 * Deliberately not a general-purpose ZIP implementation: no ZIP64, no encryption, no
 * multi-disk archives. Those never occur in a cursor pack and are reported as errors.
 */

export class CursorZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorZipError";
	}
}

export interface ZipEntry {
	/** Path as stored in the archive, e.g. "nyan-cat/Nyan-Cat-normal.cur". */
	path: string;
	bytes: Uint8Array<ArrayBuffer>;
}

/** Normalizes either input shape to a plain byte view without copying. */
function toBytes(source: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
	return (
		source instanceof Uint8Array ? source : new Uint8Array(source)
	) as Uint8Array<ArrayBuffer>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** ZIP32 sentinel: a value of 0xffff/0xffffffff means "see the ZIP64 record". */
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Guards against a malformed or hostile archive claiming an enormous entry. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

interface CentralEntry {
	path: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

function findEndOfCentralDirectory(view: DataView): number {
	// The EOCD sits at the very end unless the archive carries a trailing comment, which
	// is capped at 64 KB — so scanning back that far always finds it.
	const maxScan = Math.min(view.byteLength, EOCD_MIN_SIZE + 0xffff);
	for (let i = EOCD_MIN_SIZE; i <= maxScan; i += 1) {
		const at = view.byteLength - i;
		if (view.getUint32(at, true) === EOCD_SIGNATURE) {
			return at;
		}
	}
	throw new CursorZipError("Not a zip archive");
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
	// Cursor pack filenames are ASCII in practice, where UTF-8 and CP437 agree.
	return new TextDecoder(utf8Flag ? "utf-8" : "windows-1252").decode(bytes);
}

function readCentralDirectory(bytes: Uint8Array<ArrayBuffer>, view: DataView): CentralEntry[] {
	const eocd = findEndOfCentralDirectory(view);
	const entryCount = view.getUint16(eocd + 10, true);
	const directoryOffset = view.getUint32(eocd + 16, true);

	if (entryCount === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32) {
		throw new CursorZipError("ZIP64 archives are not supported");
	}
	if (directoryOffset >= view.byteLength) {
		throw new CursorZipError("Zip central directory is out of bounds");
	}

	const entries: CentralEntry[] = [];
	let offset = directoryOffset;

	for (let i = 0; i < entryCount; i += 1) {
		if (
			offset + 46 > view.byteLength ||
			view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE
		) {
			break;
		}

		const flags = view.getUint16(offset + 8, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);

		if ((flags & 0x1) !== 0) {
			throw new CursorZipError("Encrypted zip archives are not supported");
		}

		entries.push({
			path: decodeName(
				bytes.subarray(offset + 46, offset + 46 + nameLength),
				(flags & 0x800) !== 0,
			),
			method: view.getUint16(offset + 10, true),
			compressedSize: view.getUint32(offset + 20, true),
			uncompressedSize: view.getUint32(offset + 24, true),
			localHeaderOffset: view.getUint32(offset + 42, true),
		});

		offset += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

async function inflateRaw(compressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	if (typeof DecompressionStream === "undefined") {
		throw new CursorZipError("This platform cannot decompress zip archives");
	}

	const stream = new DecompressionStream("deflate-raw");
	const writer = stream.writable.getWriter();
	// Write and read concurrently: awaiting the write first would deadlock on any input
	// large enough to fill the stream's internal buffer.
	const written = (async () => {
		await writer.write(compressed);
		await writer.close();
	})();

	const reader = stream.readable.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(value);
			total += value.byteLength;
			if (total > MAX_ENTRY_BYTES) {
				throw new CursorZipError("Zip entry is unexpectedly large");
			}
		}
		await written;
	} finally {
		reader.releaseLock();
		written.catch(() => {
			// A failed read leaves the write promise rejected. Swallowing it here keeps
			// the original read error as the one that surfaces.
		});
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function readEntryData(
	bytes: Uint8Array<ArrayBuffer>,
	view: DataView,
	entry: CentralEntry,
): Promise<Uint8Array<ArrayBuffer>> {
	const header = entry.localHeaderOffset;
	if (header + 30 > view.byteLength || view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE) {
		throw new CursorZipError(`Corrupt zip entry: ${entry.path}`);
	}

	// The local header repeats the name and extra-field lengths, and they can differ from
	// the central directory's, so the data offset must come from the local header.
	const nameLength = view.getUint16(header + 26, true);
	const extraLength = view.getUint16(header + 28, true);
	const dataStart = header + 30 + nameLength + extraLength;
	const dataEnd = dataStart + entry.compressedSize;

	if (dataEnd > view.byteLength) {
		throw new CursorZipError(`Zip entry runs past the end of the archive: ${entry.path}`);
	}

	const raw = bytes.subarray(dataStart, dataEnd);
	if (entry.method === METHOD_STORED) {
		return raw.slice();
	}
	if (entry.method === METHOD_DEFLATE) {
		return inflateRaw(raw);
	}
	throw new CursorZipError(`Unsupported zip compression method ${entry.method}: ${entry.path}`);
}

/**
 * Extracts archive members whose path passes `filter`.
 *
 * Directory records, oversized members, and entries that fail to inflate are skipped
 * rather than failing the whole import — a pack with one bad file should still give the
 * user the rest of its cursors.
 */
export async function readZipEntries(
	source: ArrayBuffer | Uint8Array,
	filter: (path: string) => boolean,
): Promise<ZipEntry[]> {
	const bytes = toBytes(source);
	if (bytes.byteLength < EOCD_MIN_SIZE) {
		throw new CursorZipError("Not a zip archive");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries = readCentralDirectory(bytes, view);
	const results: ZipEntry[] = [];

	for (const entry of entries) {
		if (entry.path.endsWith("/") || !filter(entry.path)) {
			continue;
		}
		if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
			continue;
		}

		try {
			results.push({ path: entry.path, bytes: await readEntryData(bytes, view, entry) });
		} catch {
			// Skip the unreadable member; the caller reports on what did come through.
		}
	}

	return results;
}

/** True when the bytes begin with a local file header, i.e. a zip archive. */
export function isZipFile(source: ArrayBuffer | Uint8Array): boolean {
	const bytes = toBytes(source);
	if (bytes.byteLength < 4) {
		return false;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint32(0, true) === LOCAL_HEADER_SIGNATURE;
}
