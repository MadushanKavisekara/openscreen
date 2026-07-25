import type { NativeCursorType } from "@/native/contracts";
import { getCustomCursorPack, getCustomCursorPacks, isCustomCursorId } from "./customCursors";

/**
 * A single themed cursor image override for one {@link NativeCursorType}.
 *
 * width/height/hotspot are in the same ~32-logical-pixel reference as the built-in
 * PRETTY_NATIVE_CURSOR_ASSETS, so a theme asset matches the default cursor's on-screen
 * size regardless of source PNG resolution. The PNG can be higher-res (e.g. 128x128)
 * and is downscaled at draw time for crisper retina output.
 */
export interface CursorThemeAsset {
	/**
	 * Path relative to the public asset root, e.g. "cursors/hello-kitty-watermelon/arrow.png".
	 * Bundled packs only; user-imported packs carry {@link assetUrl} instead.
	 */
	assetPath?: string;
	/**
	 * A self-contained image URL (a data URL) for user-imported packs, so the artwork
	 * travels with the pack instead of depending on a file on disk.
	 */
	assetUrl?: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
}

export interface CursorTheme {
	id: string;
	/** Display label. Proper nouns, so not run through i18n. */
	name: string;
	/** Attribution / origin for the artwork. */
	source?: string;
	/**
	 * Per-cursor-type overrides. Missing types fall back to the built-in default art.
	 * Sweezy packs only ship "arrow" and "pointer".
	 */
	assets: Partial<Record<NativeCursorType, CursorThemeAsset>>;
}

/** Sentinel id for the built-in cursor art (no theme override). */
export const DEFAULT_CURSOR_THEME_ID = "default";

/**
 * Bundled cursor themes. To add a pack: drop arrow.png/pointer.png into
 * public/cursors/<id>/ and add an entry here with hotspots normalized to the
 * 32-logical reference (divide a 128px-pack hotspot by 4). No renderer changes needed.
 */
export const CURSOR_THEMES: readonly CursorTheme[] = [
	{
		id: "hello-kitty-watermelon",
		name: "Hello Kitty & Watermelon",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/hello-kitty-watermelon/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/hello-kitty-watermelon/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 4,
				hotspotY: 2,
			},
		},
	},
	{
		id: "among-us-sus-knife-and-red-animated",
		name: "Among Us Sus Knife & Red Animated",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/among-us-sus-knife-and-red-animated/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.6,
				hotspotY: 0.96,
			},
			pointer: {
				assetPath: "cursors/among-us-sus-knife-and-red-animated/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 12,
				hotspotY: 2,
			},
		},
	},
	{
		id: "black-and-rainbow-stroke-gradient-animated",
		name: "Black & Rainbow Stroke Gradient Animated",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/black-and-rainbow-stroke-gradient-animated/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.6,
				hotspotY: 0.96,
			},
			pointer: {
				assetPath: "cursors/black-and-rainbow-stroke-gradient-animated/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 8,
				hotspotY: 1.5,
			},
		},
	},
	{
		id: "black-pixel",
		name: "Black Pixel",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/black-pixel/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 2,
				hotspotY: 3.5,
			},
			pointer: {
				assetPath: "cursors/black-pixel/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 8,
				hotspotY: 1.5,
			},
		},
	},
	{
		id: "christmas-miles-morales",
		name: "Christmas Miles Morales",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/christmas-miles-morales/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/christmas-miles-morales/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 5.5,
				hotspotY: 3,
			},
		},
	},
	{
		id: "hollow-knight-and-game-arrow",
		name: "Hollow Knight & Game Arrow",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/hollow-knight-and-game-arrow/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 0.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/hollow-knight-and-game-arrow/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 5,
				hotspotY: 0.5,
			},
		},
	},
	{
		id: "hollow-knight-nail-sword-and-mask",
		name: "Hollow Knight Nail Sword & Mask",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/hollow-knight-nail-sword-and-mask/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 0.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/hollow-knight-nail-sword-and-mask/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 3.5,
				hotspotY: 2,
			},
		},
	},
	{
		id: "naruto-akatsuki-cloud-arrow",
		name: "Naruto Akatsuki Cloud Arrow",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/naruto-akatsuki-cloud-arrow/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 0.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/naruto-akatsuki-cloud-arrow/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 1,
				hotspotY: 1,
			},
		},
	},
	{
		id: "old-roblox",
		name: "Old Roblox",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/old-roblox/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 2.5,
				hotspotY: 1.5,
			},
			pointer: {
				assetPath: "cursors/old-roblox/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 3.5,
				hotspotY: 1.5,
			},
		},
	},
	{
		id: "pink-glossy-arrow-and-hand-3d",
		name: "Pink Glossy Arrow & Hand 3D",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/pink-glossy-arrow-and-hand-3d/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.5,
				hotspotY: 1.5,
			},
			pointer: {
				assetPath: "cursors/pink-glossy-arrow-and-hand-3d/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 3,
				hotspotY: 1,
			},
		},
	},
	{
		id: "pinky-pixel",
		name: "Pinky Pixel",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/pinky-pixel/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 0.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/pinky-pixel/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 7,
				hotspotY: 1,
			},
		},
	},
	{
		id: "pokemon-neon-gengar",
		name: "Pokemon Neon Gengar",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/pokemon-neon-gengar/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/pokemon-neon-gengar/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 2,
				hotspotY: 2.5,
			},
		},
	},
	{
		id: "sanrio-gudetama-and-arrow-kawaii",
		name: "Sanrio Gudetama & Arrow Kawaii",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/sanrio-gudetama-and-arrow-kawaii/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 0.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/sanrio-gudetama-and-arrow-kawaii/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 8,
				hotspotY: 4,
			},
		},
	},
	{
		id: "spring-gradient",
		name: "Spring Gradient",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/spring-gradient/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/spring-gradient/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 8,
				hotspotY: 0.5,
			},
		},
	},
	{
		id: "mickey-mouse-black-hand-inflated-glove",
		name: "Mickey Mouse Black Hand Inflated Glove",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/mickey-mouse-black-hand-inflated-glove/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 2.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/mickey-mouse-black-hand-inflated-glove/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 10,
				hotspotY: 0.5,
			},
		},
	},
	{
		id: "sanrio-kuromi-skull-arrow",
		name: "Sanrio Kuromi Skull Arrow",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/sanrio-kuromi-skull-arrow/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 1.5,
				hotspotY: 0.5,
			},
			pointer: {
				assetPath: "cursors/sanrio-kuromi-skull-arrow/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 9.5,
				hotspotY: 1,
			},
		},
	},
	{
		id: "solo-leveling-sung-jinwoo-dark-flames",
		name: "Solo Leveling Sung Jinwoo Dark Flames",
		source: "sweezy-cursors.com",
		assets: {
			arrow: {
				assetPath: "cursors/solo-leveling-sung-jinwoo-dark-flames/arrow.png",
				width: 32,
				height: 32,
				hotspotX: 2,
				hotspotY: 1,
			},
			pointer: {
				assetPath: "cursors/solo-leveling-sung-jinwoo-dark-flames/pointer.png",
				width: 32,
				height: 32,
				hotspotX: 7,
				hotspotY: 4.5,
			},
		},
	},
];

/** Ids of the bundled themes, plus the built-in default. */
export const CURSOR_THEME_IDS: ReadonlySet<string> = new Set([
	DEFAULT_CURSOR_THEME_ID,
	...CURSOR_THEMES.map((theme) => theme.id),
]);

/**
 * Every selectable theme: the bundled packs followed by the user's imported ones.
 *
 * Imported packs are read from a synchronous in-memory cache, so this stays cheap enough
 * for the settings UI to call on each render and carries no load-order hazard — a project
 * restored at startup can resolve a custom id immediately.
 */
export function getAllCursorThemes(): CursorTheme[] {
	const custom: CursorTheme[] = getCustomCursorPacks().map((pack) => ({
		id: pack.id,
		name: pack.name,
		assets: pack.assets,
	}));
	return [...CURSOR_THEMES, ...custom];
}

/** Returns the theme for `id`, or null for the default / unknown ids. */
export function getCursorTheme(id: string | null | undefined): CursorTheme | null {
	if (!id || id === DEFAULT_CURSOR_THEME_ID) {
		return null;
	}
	if (isCustomCursorId(id)) {
		const pack = getCustomCursorPack(id);
		return pack ? { id: pack.id, name: pack.name, assets: pack.assets } : null;
	}
	return CURSOR_THEMES.find((theme) => theme.id === id) ?? null;
}

/**
 * Normalizes a persisted/incoming theme id to a known value, falling back to the
 * default for anything unrecognized.
 *
 * Imported packs are validated against the live library rather than a fixed list, so a
 * project that names one keeps it — and falls back gracefully if that pack is gone.
 */
export function normalizeCursorThemeId(id: unknown): string {
	if (typeof id !== "string") {
		return DEFAULT_CURSOR_THEME_ID;
	}
	if (CURSOR_THEME_IDS.has(id)) {
		return id;
	}
	if (isCustomCursorId(id) && getCustomCursorPack(id)) {
		return id;
	}
	return DEFAULT_CURSOR_THEME_ID;
}
