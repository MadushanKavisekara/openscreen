/**
 * Carries settings across the OpenScreen → Screenly rename.
 *
 * Every localStorage key the app owns was prefixed `openscreen`; they are now
 * prefixed `screenly`. Without this pass an upgrading user silently loses their
 * preferences, custom fonts, imported cursor packs and language choice, because
 * the new code reads keys that have never been written.
 *
 * The rename is one-way and runs once: a legacy key is copied only when the new
 * key is absent, so a value written since the upgrade always wins. Legacy keys
 * are removed afterwards, which also makes the migration idempotent.
 */

const LEGACY_PREFIX = "openscreen";
const CURRENT_PREFIX = "screenly";

/** Renames `openscreen_foo` / `openscreen-foo` to `screenly_foo` / `screenly-foo`. */
export function migrateLegacyStorageKeys(storage: Storage = localStorage): void {
	let legacyKeys: string[];
	try {
		legacyKeys = Object.keys(storage).filter((key) => key.startsWith(LEGACY_PREFIX));
	} catch {
		// Storage can throw in sandboxed/private contexts; there is nothing to migrate there.
		return;
	}
	if (legacyKeys.length === 0) return;

	for (const legacyKey of legacyKeys) {
		const currentKey = `${CURRENT_PREFIX}${legacyKey.slice(LEGACY_PREFIX.length)}`;
		try {
			if (storage.getItem(currentKey) === null) {
				const value = storage.getItem(legacyKey);
				if (value !== null) storage.setItem(currentKey, value);
			}
			storage.removeItem(legacyKey);
		} catch (error) {
			// A single unmovable key (quota, corrupt entry) must not block the rest.
			console.warn(`Failed to migrate legacy storage key "${legacyKey}":`, error);
		}
	}
}
