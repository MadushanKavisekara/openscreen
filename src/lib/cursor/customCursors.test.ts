import { beforeEach, describe, expect, it } from "vitest";
import { normalizeCursorMetrics, suggestPackName } from "./cursorImport";
import { getCursorTheme, normalizeCursorThemeId } from "./cursorThemes";
import {
	addCustomCursorPack,
	type CustomCursorPack,
	fingerprintCursorAssets,
	generateCustomCursorId,
	getCustomCursorPacks,
	isCustomCursorId,
	MAX_CUSTOM_CURSOR_PACKS,
	removeCustomCursorPack,
	renameCustomCursorPack,
	resetCustomCursorCacheForTests,
} from "./customCursors";

function makePack(overrides: Partial<CustomCursorPack> = {}): CustomCursorPack {
	return {
		id: generateCustomCursorId(),
		name: "Nyan Cat",
		fingerprint: `fp-${Math.random()}`,
		createdAt: 1,
		assets: {
			arrow: {
				assetUrl: "data:image/png;base64,AAAA",
				width: 32,
				height: 32,
				hotspotX: 1,
				hotspotY: 2,
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	localStorage.clear();
	resetCustomCursorCacheForTests();
});

describe("custom cursor library", () => {
	it("stores a pack and reads it back after a reload", () => {
		const pack = makePack();
		expect(addCustomCursorPack(pack).ok).toBe(true);

		resetCustomCursorCacheForTests();

		const stored = getCustomCursorPacks();
		expect(stored).toHaveLength(1);
		expect(stored[0].name).toBe("Nyan Cat");
		expect(stored[0].assets.arrow?.hotspotX).toBe(1);
	});

	it("recognises the same artwork instead of storing it twice", () => {
		const first = makePack({ fingerprint: "same" });
		addCustomCursorPack(first);

		const result = addCustomCursorPack(makePack({ fingerprint: "same", name: "Copy" }));

		expect(result).toMatchObject({ ok: true, alreadyPresent: true });
		expect(result.ok && result.pack.id).toBe(first.id);
		expect(getCustomCursorPacks()).toHaveLength(1);
	});

	it("refuses to grow past the pack limit", () => {
		for (let i = 0; i < MAX_CUSTOM_CURSOR_PACKS; i += 1) {
			expect(addCustomCursorPack(makePack()).ok).toBe(true);
		}

		expect(addCustomCursorPack(makePack())).toEqual({ ok: false, reason: "too-many" });
	});

	it("rejects a pack too large to store", () => {
		const huge = makePack({
			assets: {
				arrow: {
					assetUrl: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`,
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
			},
		});

		expect(addCustomCursorPack(huge)).toEqual({ ok: false, reason: "too-large" });
	});

	it("removes and renames packs", () => {
		const pack = makePack();
		addCustomCursorPack(pack);

		renameCustomCursorPack(pack.id, "  Renamed  ");
		expect(getCustomCursorPacks()[0].name).toBe("Renamed");

		removeCustomCursorPack(pack.id);
		expect(getCustomCursorPacks()).toHaveLength(0);
	});

	it("discards malformed records rather than breaking the library", () => {
		localStorage.setItem(
			"screenly_custom_cursors",
			JSON.stringify([{ id: "custom:broken" }, makePack()]),
		);
		resetCustomCursorCacheForTests();

		expect(getCustomCursorPacks()).toHaveLength(1);
	});

	it("fingerprints the same artwork identically regardless of role order", async () => {
		const a = await fingerprintCursorAssets({
			arrow: { assetUrl: "a", width: 32, height: 32, hotspotX: 0, hotspotY: 0 },
			pointer: { assetUrl: "b", width: 32, height: 32, hotspotX: 1, hotspotY: 1 },
		});
		const b = await fingerprintCursorAssets({
			pointer: { assetUrl: "b", width: 32, height: 32, hotspotX: 1, hotspotY: 1 },
			arrow: { assetUrl: "a", width: 32, height: 32, hotspotX: 0, hotspotY: 0 },
		});

		expect(a).toBe(b);
	});
});

describe("theme registry with imported packs", () => {
	it("resolves an imported pack by id", () => {
		const pack = makePack();
		addCustomCursorPack(pack);

		expect(isCustomCursorId(pack.id)).toBe(true);
		expect(getCursorTheme(pack.id)?.name).toBe("Nyan Cat");
		expect(getCursorTheme(pack.id)?.assets.arrow?.assetUrl).toBe("data:image/png;base64,AAAA");
	});

	it("keeps a project's imported pack id when the pack is installed", () => {
		const pack = makePack();
		addCustomCursorPack(pack);

		expect(normalizeCursorThemeId(pack.id)).toBe(pack.id);
	});

	it("falls back to the default when a project names a pack that is not installed", () => {
		expect(normalizeCursorThemeId("custom:missing")).toBe("default");
		expect(normalizeCursorThemeId("nonsense")).toBe("default");
		// Bundled packs still resolve.
		expect(normalizeCursorThemeId("black-pixel")).toBe("black-pixel");
	});
});

describe("normalizeCursorMetrics", () => {
	it("leaves a 32px cursor and its hotspot untouched", () => {
		expect(normalizeCursorMetrics(32, 32, 5, 3)).toEqual({
			width: 32,
			height: 32,
			hotspotX: 5,
			hotspotY: 3,
		});
	});

	it("scales a high-resolution cursor down to the logical reference", () => {
		// A 128px pack's hotspot ends up divided by four.
		expect(normalizeCursorMetrics(128, 128, 8, 4)).toEqual({
			width: 32,
			height: 32,
			hotspotX: 2,
			hotspotY: 1,
		});
	});

	it("keeps proportions for non-square art", () => {
		const result = normalizeCursorMetrics(64, 32, 0, 0);
		expect(result.width).toBe(32);
		expect(result.height).toBe(16);
	});

	it("clamps a hotspot that falls outside the artwork", () => {
		const result = normalizeCursorMetrics(32, 32, 999, -5);
		expect(result.hotspotX).toBe(32);
		expect(result.hotspotY).toBe(0);
	});
});

describe("suggestPackName", () => {
	it("names a pack after its archive", () => {
		expect(suggestPackName("nyan-cat.zip", ["Nyan-Cat-normal.cur"])).toBe("Nyan Cat");
	});

	it("falls back to the shared prefix of loose files", () => {
		expect(
			suggestPackName("", ["Nyan-Cat-normal.cur", "Nyan-Cat-link.ani", "Nyan-Cat-text.ani"]),
		).toBe("Nyan Cat");
	});

	it("copes with a single loose file", () => {
		expect(suggestPackName("", ["Cool-Arrow.cur"])).toBe("Cool Arrow");
	});
});
