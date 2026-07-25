import type { NativeCursorType } from "@/native/contracts";

/**
 * Guesses which cursor role a file in an imported pack is meant to fill, from its name.
 *
 * Cursor packs follow the Windows scheme naming loosely at best — the convention is a
 * habit, not a rule — so every guess is surfaced in the import screen for the user to
 * correct. Low-confidence guesses are flagged so the UI can draw attention to them.
 *
 * Two traps this encodes, both from real packs:
 * - "hand" is the Windows *handwriting* pen, not the pointing hand. The pointing hand is
 *   "link" (Link Select). Naming it "hand" is common enough in casual packs that we still
 *   guess pointer, but only with low confidence.
 * - "Diagonal Resize 1" is the ↖↘ (NWSE) arrow and "2" is ↗↙ (NESW), following the order
 *   Windows lists them in, which is the opposite of what the numbering suggests.
 */

/** Roles the user can assign in the import screen, in the order Windows lists them. */
export const ASSIGNABLE_CURSOR_ROLES: readonly NativeCursorType[] = [
	"arrow",
	"pointer",
	"text",
	"wait",
	"app-starting",
	"crosshair",
	"move",
	"resize-ns",
	"resize-ew",
	"resize-nwse",
	"resize-nesw",
	"not-allowed",
	"help",
	"up-arrow",
	"open-hand",
	"closed-hand",
];

export type RoleMatchConfidence = "high" | "low";

export interface RoleGuess {
	role: NativeCursorType | null;
	confidence: RoleMatchConfidence;
}

interface RoleRule {
	role: NativeCursorType;
	/** Matched as whole hyphen-delimited words, so "no" never matches inside "normal". */
	aliases: readonly string[];
	confidence?: RoleMatchConfidence;
}

const ROLE_RULES: readonly RoleRule[] = [
	{
		role: "resize-nwse",
		aliases: ["nwse", "size-nwse", "sizenwse", "resize-1", "resize1", "diagonal-1", "diag-1"],
	},
	{
		role: "resize-nesw",
		aliases: ["nesw", "size-nesw", "sizenesw", "resize-2", "resize2", "diagonal-2", "diag-2"],
	},
	{
		role: "resize-ns",
		aliases: ["vertical", "vert", "size-ns", "sizens", "resize-ns", "north-south", "up-down"],
	},
	{
		role: "resize-ew",
		aliases: ["horizontal", "horz", "horiz", "size-we", "sizewe", "resize-ew", "left-right"],
	},
	{ role: "move", aliases: ["move", "size-all", "sizeall", "sizemove", "all-scroll"] },
	{
		role: "not-allowed",
		aliases: ["unav", "unavailable", "no", "not-allowed", "notallowed", "forbidden", "nodrop"],
	},
	{ role: "wait", aliases: ["busy", "wait", "hourglass", "loading", "beachball"] },
	{
		role: "app-starting",
		aliases: ["background", "working", "app-starting", "appstarting", "startup"],
	},
	{ role: "help", aliases: ["help", "question"] },
	{ role: "text", aliases: ["text", "ibeam", "i-beam", "beam", "caret"] },
	{ role: "crosshair", aliases: ["precision", "cross", "crosshair", "crosshairs"] },
	{ role: "up-arrow", aliases: ["alter", "alternate", "up-arrow", "uparrow"] },
	{ role: "open-hand", aliases: ["open-hand", "openhand", "grab"] },
	{ role: "closed-hand", aliases: ["closed-hand", "closedhand", "grabbing", "grabbed"] },
	{ role: "pointer", aliases: ["link", "linkselect", "pointing", "point"] },
	{ role: "arrow", aliases: ["normal", "arrow", "default", "standard", "regular"] },
	// Casual packs call the pointing hand "hand", but in a real Windows scheme that name
	// belongs to the handwriting pen. Guess, but ask the user to confirm.
	{ role: "pointer", aliases: ["hand"], confidence: "low" },
];

/** Strips the directory and extension, and reduces the name to hyphen-delimited words. */
export function toRoleSlug(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? path;
	const withoutExtension = base.replace(/\.[^.]+$/, "");
	return withoutExtension
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Index of the last occurrence of `needle` in `slug` that is delimited by word bounds,
 * or -1. Matching the *last* occurrence means the role suffix wins over a set name that
 * happens to contain a role word, e.g. "Move-Pack-normal.cur" resolves to arrow.
 */
function lastBoundedIndexOf(slug: string, needle: string): number {
	let from = slug.length;

	while (from >= 0) {
		const index = slug.lastIndexOf(needle, from);
		if (index === -1) {
			return -1;
		}
		const beforeOk = index === 0 || slug[index - 1] === "-";
		const after = index + needle.length;
		const afterOk = after === slug.length || slug[after] === "-";
		if (beforeOk && afterOk) {
			return index;
		}
		from = index - 1;
	}

	return -1;
}

/**
 * Guesses the role for a file name, preferring whichever alias appears furthest right —
 * pack names are prefixes, role names are suffixes.
 */
export function guessCursorRole(path: string): RoleGuess {
	const slug = toRoleSlug(path);
	if (!slug) {
		return { role: null, confidence: "low" };
	}

	let best: { rule: RoleRule; end: number; length: number } | null = null;

	for (const rule of ROLE_RULES) {
		for (const alias of rule.aliases) {
			const index = lastBoundedIndexOf(slug, alias);
			if (index === -1) {
				continue;
			}
			// Compare where each match *ends*, so the role suffix beats a pack name that
			// contains a role word. On a tie the longer alias is the more specific match,
			// which is what makes "up-arrow" win over the "arrow" nested inside it.
			const end = index + alias.length;
			if (!best || end > best.end || (end === best.end && alias.length > best.length)) {
				best = { rule, end, length: alias.length };
			}
		}
	}

	if (!best) {
		return { role: null, confidence: "low" };
	}

	return { role: best.rule.role, confidence: best.rule.confidence ?? "high" };
}

/**
 * Assigns roles across a whole pack, keeping one file per role.
 *
 * When several files claim the same role the more confident guess wins, and ties go to
 * the first file so the result does not depend on directory ordering. Losers come back
 * with a null role for the user to place by hand.
 */
export function assignCursorRoles<T extends { path: string }>(
	files: readonly T[],
): Array<T & RoleGuess> {
	const claimed = new Map<NativeCursorType, number>();
	const results: Array<T & RoleGuess> = files.map((file) => ({
		...file,
		...guessCursorRole(file.path),
	}));

	results.forEach((result, index) => {
		if (!result.role) {
			return;
		}

		const heldBy = claimed.get(result.role);
		if (heldBy === undefined) {
			claimed.set(result.role, index);
			return;
		}

		const incumbent = results[heldBy];
		if (result.confidence === "high" && incumbent.confidence === "low") {
			incumbent.role = null;
			claimed.set(result.role, index);
		} else {
			result.role = null;
		}
	});

	return results;
}
