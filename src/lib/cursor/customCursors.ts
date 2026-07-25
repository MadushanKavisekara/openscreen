import type { NativeCursorType } from "@/native/contracts";
import type { CursorThemeAsset } from "./cursorThemes";

/**
 * The user's own cursor packs, imported from `.cur`/`.ani` files.
 *
 * Packs live on the machine and are shared by every project, mirroring how custom fonts
 * are stored. Their artwork is embedded as data URLs so a pack is self-contained: it can
 * be written into a project file and rebuilt on someone else's machine without needing
 * the original download.
 *
 * An in-memory cache backs every read because theme lookup happens inside the render
 * loop, and re-parsing storage per frame would be wasteful.
 */

export const CUSTOM_CURSOR_ID_PREFIX = "custom:";
const STORAGE_KEY = "openscreen_custom_cursors";

/** Keeps one runaway import from crowding out the rest of the app's stored settings. */
export const MAX_CUSTOM_CURSOR_PACKS = 24;
export const MAX_CUSTOM_CURSOR_BYTES = 2 * 1024 * 1024;

export interface CustomCursorPack {
	id: string;
	name: string;
	/** Content fingerprint, used to recognise a pack that arrives twice. */
	fingerprint: string;
	createdAt: number;
	assets: Partial<Record<NativeCursorType, CursorThemeAsset>>;
}

export type AddCustomCursorResult =
	| { ok: true; pack: CustomCursorPack; alreadyPresent: boolean }
	| { ok: false; reason: "too-many" | "too-large" | "storage-failed" };

let cache: CustomCursorPack[] | null = null;
const listeners = new Set<() => void>();

function isValidAsset(value: unknown): value is CursorThemeAsset {
	if (!value || typeof value !== "object") {
		return false;
	}
	const asset = value as Partial<CursorThemeAsset>;
	return (
		typeof asset.assetUrl === "string" &&
		asset.assetUrl.length > 0 &&
		typeof asset.width === "number" &&
		typeof asset.height === "number" &&
		typeof asset.hotspotX === "number" &&
		typeof asset.hotspotY === "number"
	);
}

/** Drops anything malformed rather than letting one bad record break the whole library. */
function normalizePack(value: unknown): CustomCursorPack | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const pack = value as Partial<CustomCursorPack>;
	if (typeof pack.id !== "string" || !pack.id.startsWith(CUSTOM_CURSOR_ID_PREFIX)) {
		return null;
	}
	if (typeof pack.name !== "string" || !pack.assets || typeof pack.assets !== "object") {
		return null;
	}

	const assets: Partial<Record<NativeCursorType, CursorThemeAsset>> = {};
	for (const [role, asset] of Object.entries(pack.assets)) {
		if (isValidAsset(asset)) {
			assets[role as NativeCursorType] = asset;
		}
	}
	if (Object.keys(assets).length === 0) {
		return null;
	}

	return {
		id: pack.id,
		name: pack.name,
		fingerprint: typeof pack.fingerprint === "string" ? pack.fingerprint : "",
		createdAt: typeof pack.createdAt === "number" ? pack.createdAt : 0,
		assets,
	};
}

function read(): CustomCursorPack[] {
	if (cache) {
		return cache;
	}

	try {
		const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		cache = Array.isArray(parsed)
			? parsed.map(normalizePack).filter((pack): pack is CustomCursorPack => pack !== null)
			: [];
	} catch (error) {
		console.error("Failed to load custom cursors from storage:", error);
		cache = [];
	}

	return cache;
}

function write(packs: CustomCursorPack[]): boolean {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(packs));
		cache = packs;
		for (const listener of listeners) {
			listener();
		}
		return true;
	} catch (error) {
		console.error("Failed to save custom cursors to storage:", error);
		return false;
	}
}

/** All imported packs, newest last. */
export function getCustomCursorPacks(): readonly CustomCursorPack[] {
	return read();
}

export function getCustomCursorPack(id: string): CustomCursorPack | null {
	return read().find((pack) => pack.id === id) ?? null;
}

export function findCustomCursorPackByFingerprint(fingerprint: string): CustomCursorPack | null {
	if (!fingerprint) {
		return null;
	}
	return read().find((pack) => pack.fingerprint === fingerprint) ?? null;
}

export function generateCustomCursorId(): string {
	return `${CUSTOM_CURSOR_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isCustomCursorId(id: string | null | undefined): boolean {
	return typeof id === "string" && id.startsWith(CUSTOM_CURSOR_ID_PREFIX);
}

/**
 * Adds a pack, or returns the existing one when the same artwork is already in the
 * library. Deduplicating by fingerprint is what stops a shared project from stacking up
 * copies of its cursor every time it is opened.
 */
export function addCustomCursorPack(pack: CustomCursorPack): AddCustomCursorResult {
	const packs = read();

	const duplicate = pack.fingerprint
		? packs.find((existing) => existing.fingerprint === pack.fingerprint)
		: undefined;
	if (duplicate) {
		return { ok: true, pack: duplicate, alreadyPresent: true };
	}

	if (packs.length >= MAX_CUSTOM_CURSOR_PACKS) {
		return { ok: false, reason: "too-many" };
	}

	const next = [...packs, pack];
	if (JSON.stringify(next).length > MAX_CUSTOM_CURSOR_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	if (!write(next)) {
		return { ok: false, reason: "storage-failed" };
	}

	return { ok: true, pack, alreadyPresent: false };
}

export function removeCustomCursorPack(id: string): readonly CustomCursorPack[] {
	const packs = read();
	const next = packs.filter((pack) => pack.id !== id);
	if (next.length !== packs.length) {
		write(next);
	}
	return read();
}

export function renameCustomCursorPack(id: string, name: string): readonly CustomCursorPack[] {
	const trimmed = name.trim();
	if (!trimmed) {
		return read();
	}
	write(read().map((pack) => (pack.id === id ? { ...pack, name: trimmed } : pack)));
	return read();
}

/** Subscribes to library changes; returns an unsubscribe function. */
export function subscribeToCustomCursorPacks(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test seam: drops the in-memory cache so the next read hits storage again. */
export function resetCustomCursorCacheForTests(): void {
	cache = null;
}

/**
 * A stable content fingerprint for a pack's artwork.
 *
 * Roles are sorted so two imports of the same pack agree regardless of the order their
 * files happened to be read in.
 */
export async function fingerprintCursorAssets(
	assets: Partial<Record<NativeCursorType, CursorThemeAsset>>,
): Promise<string> {
	const canonical = Object.keys(assets)
		.sort()
		.map((role) => {
			const asset = assets[role as NativeCursorType];
			return `${role}|${asset?.hotspotX},${asset?.hotspotY}|${asset?.assetUrl ?? asset?.assetPath ?? ""}`;
		})
		.join("\n");

	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
