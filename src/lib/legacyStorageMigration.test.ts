import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyStorageKeys } from "./legacyStorageMigration";

describe("migrateLegacyStorageKeys", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("renames underscore-separated keys", () => {
		localStorage.setItem("openscreen_user_preferences", '{"padding":10}');

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly_user_preferences")).toBe('{"padding":10}');
		expect(localStorage.getItem("openscreen_user_preferences")).toBeNull();
	});

	it("renames hyphen-separated keys", () => {
		localStorage.setItem("openscreen-locale", "fr");

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly-locale")).toBe("fr");
		expect(localStorage.getItem("openscreen-locale")).toBeNull();
	});

	it("migrates every owned key in one pass", () => {
		localStorage.setItem("openscreen_custom_fonts", "[]");
		localStorage.setItem("openscreen_custom_cursors", "[]");
		localStorage.setItem("openscreen-system-language-prompt-seen", "1");

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly_custom_fonts")).toBe("[]");
		expect(localStorage.getItem("screenly_custom_cursors")).toBe("[]");
		expect(localStorage.getItem("screenly-system-language-prompt-seen")).toBe("1");
	});

	it("keeps a value written since the upgrade instead of overwriting it", () => {
		localStorage.setItem("openscreen-locale", "fr");
		localStorage.setItem("screenly-locale", "ja-JP");

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly-locale")).toBe("ja-JP");
		expect(localStorage.getItem("openscreen-locale")).toBeNull();
	});

	it("leaves keys the app does not own alone", () => {
		localStorage.setItem("notes", "<p>hi</p>");

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("notes")).toBe("<p>hi</p>");
	});

	it("is a no-op on a second run", () => {
		localStorage.setItem("openscreen_user_preferences", '{"padding":10}');

		migrateLegacyStorageKeys();
		localStorage.setItem("screenly_user_preferences", '{"padding":20}');
		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly_user_preferences")).toBe('{"padding":20}');
	});

	it("preserves an empty-string value rather than dropping it", () => {
		localStorage.setItem("openscreen_custom_fonts", "");

		migrateLegacyStorageKeys();

		expect(localStorage.getItem("screenly_custom_fonts")).toBe("");
	});
});
