import { describe, expect, it } from "vitest";
import { assignCursorRoles, guessCursorRole, toRoleSlug } from "./cursorRoleMapping";

describe("guessCursorRole", () => {
	it("maps a real rw-designer cursor set", () => {
		// Filenames taken from the published "Nyan Cat" set.
		const set: Array<[string, string | null]> = [
			["Nyan-Cat-normal.cur", "arrow"],
			["Nyan-Cat-link.ani", "pointer"],
			["Nyan-Cat-text.ani", "text"],
			["Nyan-Cat-busy.ani", "wait"],
			["Nyan-Cat-background.ani", "app-starting"],
			["Nyan-Cat-precision.cur", "crosshair"],
			["Nyan-Cat-move.ani", "move"],
			["Nyan-Cat-vertical.ani", "resize-ns"],
			["Nyan-Cat-horizontal.ani", "resize-ew"],
			["Nyan-Cat-resize-1.ani", "resize-nwse"],
			["Nyan-Cat-resize-2.ani", "resize-nesw"],
			["Nyan-Cat-unav.cur", "not-allowed"],
			["Nyan-Cat-help.ani", "help"],
			["Nyan-Cat-alter.cur", "up-arrow"],
		];

		for (const [file, expected] of set) {
			expect(guessCursorRole(file).role, file).toBe(expected);
		}
	});

	it("follows the Windows order for the two diagonal resize cursors", () => {
		// Windows lists Diagonal Resize 1 as the NWSE arrow, not NESW.
		expect(guessCursorRole("set-resize-1.cur").role).toBe("resize-nwse");
		expect(guessCursorRole("set-resize-2.cur").role).toBe("resize-nesw");
	});

	it("treats a bare 'hand' as a low-confidence pointer", () => {
		// In a strict Windows scheme this name is the handwriting pen, so the user is
		// asked to confirm rather than silently getting the wrong art.
		const guess = guessCursorRole("Nyan-Cat-hand.cur");
		expect(guess.role).toBe("pointer");
		expect(guess.confidence).toBe("low");

		expect(guessCursorRole("Nyan-Cat-link.ani").confidence).toBe("high");
	});

	it("does not match a role word buried inside another word", () => {
		// "no" (unavailable) must not fire on "normal".
		expect(guessCursorRole("normal.cur").role).toBe("arrow");
		expect(guessCursorRole("no.cur").role).toBe("not-allowed");
	});

	it("prefers the role suffix over a pack name that contains a role word", () => {
		expect(guessCursorRole("Move-Pack-normal.cur").role).toBe("arrow");
		expect(guessCursorRole("Crosshair-Theme-link.cur").role).toBe("pointer");
	});

	it("prefers the more specific alias on a tie", () => {
		expect(guessCursorRole("up-arrow.cur").role).toBe("up-arrow");
		expect(guessCursorRole("arrow.cur").role).toBe("arrow");
	});

	it("ignores directories and extensions", () => {
		expect(toRoleSlug("nyan-cat/Nyan-Cat-normal.cur")).toBe("nyan-cat-normal");
		expect(guessCursorRole("nyan-cat/frames/Nyan-Cat-normal.cur").role).toBe("arrow");
	});

	it("returns no guess for a name it cannot place", () => {
		expect(guessCursorRole("mystery-file.cur").role).toBeNull();
	});
});

describe("assignCursorRoles", () => {
	it("keeps one file per role and leaves the loser unassigned", () => {
		const assigned = assignCursorRoles([{ path: "pack-normal.cur" }, { path: "pack-arrow.cur" }]);

		expect(assigned[0].role).toBe("arrow");
		expect(assigned[1].role).toBeNull();
	});

	it("lets a confident guess take a role from a low-confidence one", () => {
		// "hand" grabs pointer first, but the real Link Select file should win it.
		const assigned = assignCursorRoles([{ path: "pack-hand.cur" }, { path: "pack-link.cur" }]);

		expect(assigned[0].role).toBeNull();
		expect(assigned[1].role).toBe("pointer");
	});

	it("assigns every role of a full set exactly once", () => {
		const files = [
			"s-normal.cur",
			"s-link.ani",
			"s-text.ani",
			"s-busy.ani",
			"s-background.ani",
			"s-precision.cur",
			"s-move.ani",
			"s-vertical.ani",
			"s-horizontal.ani",
			"s-resize-1.ani",
			"s-resize-2.ani",
			"s-unav.cur",
			"s-help.ani",
			"s-alter.cur",
		].map((path) => ({ path }));

		const roles = assignCursorRoles(files)
			.map((entry) => entry.role)
			.filter(Boolean);

		expect(roles).toHaveLength(14);
		expect(new Set(roles).size).toBe(14);
	});
});
