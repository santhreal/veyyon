/**
 * The Secret Manager's key map overlay.
 *
 * WHY THIS SUITE EXISTS. The card documented its actions in one row of footer chips. That row
 * truncates without saying so, so the actions at its end became invisible while their keys kept
 * working, and the card was about to gain five more. The overlay replaces that row, and it can
 * fail in ways the chips could not: it can document a key in a view where the key does nothing,
 * it can let each row pick its own indent so the descriptions no longer form a column, it can
 * serve one view's rows after the card switched to the other, and a later contributor can bind a
 * letter that an existing entry already claims.
 *
 * Each test below names one of those and asserts painted characters, exact counts or exact key
 * strings. Nothing here asserts a shape or a non-empty result, because every defect this suite
 * guards was a wrong value rather than a missing one.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { SECRET_MANAGER_HELP, SecretHelpOverlay } from "@veyyon/coding-agent/modes/components/secret-help-overlay";
import type { HelpEntry } from "@veyyon/coding-agent/modes/components/secret-manager-types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 80;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

/** The overlay's rows with styling removed, so assertions read as the operator sees them. */
function screen(view: "secrets" | "log", width = WIDTH, entries?: readonly HelpEntry[]): string[] {
	const overlay = entries === undefined ? new SecretHelpOverlay(view) : new SecretHelpOverlay(view, entries);
	return overlay.render(width).map(line => stripAnsi(line).trimEnd());
}

/**
 * Split a joined `keys` field into the individual keys it claims.
 *
 * `"/"` is both a separator and the filter binding, so splitting it naively yields two empty
 * tokens that then collide with each other. Treating the lone slash as one key is what lets the
 * duplicate detector see the filter key at all instead of reporting a phantom clash.
 *
 * The comma is the OTHER separator, and it has to be split on for the same reason: `up/down, j/k`
 * is four bindings in one field, and a detector that read it as `up` plus `down, j` plus `k`
 * would let a later entry claim `j` with nothing objecting.
 */
function atomicKeys(keys: string): readonly string[] {
	if (keys === "/") return ["/"];
	return keys
		.split(/[/,]/)
		.map(key => key.trim())
		.filter(key => key.length > 0);
}

/** Every individual key claimed by more than one entry visible in `view`. */
function duplicateBindings(entries: readonly HelpEntry[], view: "secrets" | "log"): string[] {
	const seen = new Set<string>();
	const clashes: string[] = [];
	for (const entry of entries) {
		if (entry.view !== view && entry.view !== "both") continue;
		for (const key of atomicKeys(entry.keys)) {
			if (seen.has(key)) clashes.push(key);
			else seen.add(key);
		}
	}
	return clashes.sort();
}

/** The column each description starts at, for every row of the rendered map. */
function descriptionColumns(lines: readonly string[]): number[] {
	const columns: number[] = [];
	for (const line of lines) {
		if (!line.startsWith("  ")) continue;
		// The keys field may hold spaces (`up/down, j/k`), so it runs to the two-space column gap
		// rather than to the first space. A `\S+` here stopped at the comma and threw on the row.
		const match = /^ {2}( *)(\S.*?) {2}(\S.*)$/.exec(line);
		if (match === null) throw new Error(`Row did not parse as a key map row: ${JSON.stringify(line)}`);
		columns.push(2 + match[1].length + match[2].length + 2);
	}
	return columns;
}

describe("SECRET_MANAGER_HELP as the single source of truth", () => {
	/**
	 * Locks the documented map. The defect: an action is added to the card and its key is never
	 * written down, so the one surface that would teach it stays silent and the action is
	 * discoverable only by reading the source. Asserting the exact list in order means a new
	 * binding cannot land without being documented here.
	 */
	it("documents every key the card binds, in render order", () => {
		expect(SECRET_MANAGER_HELP.map(entry => entry.keys)).toEqual([
			"c",
			"e",
			"n",
			"r",
			"a",
			"m",
			"i",
			"s",
			"u",
			"d",
			"up/down, j/k",
			"pgup/pgdn",
			"/",
			"left/right, tab",
			"?",
			"esc",
			"q",
		]);
	});

	/**
	 * Locks the scope of each entry. The defect: a row-level action such as revoke is marked
	 * `both`, so the Log view advertises a key that its input handler ignores.
	 */
	it("scopes the row actions to the Secrets view and the navigation keys to both", () => {
		const byKeys = new Map(SECRET_MANAGER_HELP.map(entry => [entry.keys, entry.view]));
		expect(byKeys.get("c")).toBe("secrets");
		expect(byKeys.get("e")).toBe("secrets");
		expect(byKeys.get("n")).toBe("secrets");
		expect(byKeys.get("r")).toBe("secrets");
		expect(byKeys.get("a")).toBe("secrets");
		expect(byKeys.get("m")).toBe("secrets");
		expect(byKeys.get("i")).toBe("secrets");
		expect(byKeys.get("s")).toBe("secrets");
		expect(byKeys.get("d")).toBe("secrets");
		expect(byKeys.get("up/down, j/k")).toBe("both");
		expect(byKeys.get("pgup/pgdn")).toBe("both");
		expect(byKeys.get("/")).toBe("both");
		expect(byKeys.get("left/right, tab")).toBe("both");
		expect(byKeys.get("?")).toBe("both");
		expect(byKeys.get("esc")).toBe("both");
		expect(byKeys.get("q")).toBe("both");
	});

	/**
	 * Locks every entry against being half-written. The defect: an entry lands with an empty
	 * description or a placeholder key, which renders as a blank row the operator reads as a bug
	 * in the card rather than a gap in the map.
	 */
	it("gives every entry a non-empty key and a lower-case description", () => {
		expect(SECRET_MANAGER_HELP.length).toBe(17);
		for (const entry of SECRET_MANAGER_HELP) {
			expect(entry.keys).toBe(entry.keys.trim());
			expect(entry.keys.length).toBeGreaterThan(0);
			expect(entry.description).toBe(entry.description.trim());
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.description[0]).toBe(entry.description[0].toLowerCase());
		}
	});

	/**
	 * REGRESSION: `esc` and `q` were one row reading `esc/q  close the card`, and they are not the
	 * same key. `q` calls `onClose` immediately. Escape UNWINDS: it drops a roster search, then a
	 * Log search, then the credential the Log is narrowed to, and only closes the card once there
	 * is nothing left to step back out of. An operator who read that row and pressed escape to
	 * leave a filtered roster stayed on the card, while the card's own status line was telling
	 * them escape clears the search. If this regresses, the key map contradicts the surface it
	 * documents on the two keys every operator reaches for first.
	 */
	it("documents escape as stepping back and q as closing, on separate rows", () => {
		const byKeys = new Map(SECRET_MANAGER_HELP.map(entry => [entry.keys, entry.description]));
		expect(byKeys.get("esc")).toBe("step back: clear the search, then the narrowing, then close");
		expect(byKeys.get("q")).toBe("close the card");
		expect(byKeys.has("esc/q")).toBe(false);
		// Both still work in either view, which is why they sit in the shared group.
		const shared = SECRET_MANAGER_HELP.filter(entry => entry.keys === "esc" || entry.keys === "q");
		expect(shared.map(entry => entry.view)).toEqual(["both", "both"]);
	});

	/**
	 * REGRESSION: `i` was described as "inspect what the selected secret has been used for", which
	 * is the job of `u` two rows below it. `i` opens and closes the detail panel, and most of what
	 * that panel shows is not usage at all: the scope, when the credential was added and when it
	 * expires. Two rows claiming one job leaves the operator pressing whichever they read first
	 * and getting the other surface.
	 */
	it("distinguishes the detail panel from the usage trace", () => {
		const byKeys = new Map(SECRET_MANAGER_HELP.map(entry => [entry.keys, entry.description]));
		expect(byKeys.get("i")).toBe("show or hide the selected secret's details");
		expect(byKeys.get("u")).toBe("show the log narrowed to the selected secret's uses");
	});

	/**
	 * REGRESSION: `tab` and `shift+tab` switch views and `j`/`k` move the selection, and neither
	 * pair appeared anywhere in the map. A key map is the only place those exist, so an operator
	 * whose hands are already on the home row had no way to learn the card takes them.
	 */
	it("names the tab and vim aliases the card also binds", () => {
		const keys = SECRET_MANAGER_HELP.flatMap(entry => atomicKeys(entry.keys));
		expect(keys).toContain("tab");
		expect(keys).toContain("j");
		expect(keys).toContain("k");
		expect(keys).toContain("up");
		expect(keys).toContain("down");
		expect(keys).toContain("left");
		expect(keys).toContain("right");
	});

	/**
	 * REGRESSION: both views route `tui.select.pageUp` and `tui.select.pageDown` through
	 * `#moveSelection`/`#moveLogSelection` by a whole screenful, and the map named neither. Paging
	 * is the only way to cross a long roster or an audit log without holding a key down, so the
	 * one binding that makes a big vault usable was the one binding nobody could find. If this
	 * regresses, the card silently supports paging again and the key map denies it.
	 */
	it("names the page keys both views bind", () => {
		const byKeys = new Map(SECRET_MANAGER_HELP.map(entry => [entry.keys, entry]));
		const paging = byKeys.get("pgup/pgdn");
		expect(paging?.description).toBe("move the selection by a screenful");
		expect(paging?.view).toBe("both");
		// It sits with the row-by-row movement it is the coarse form of, not at the end of the group.
		const order = SECRET_MANAGER_HELP.map(entry => entry.keys);
		expect(order.indexOf("pgup/pgdn")).toBe(order.indexOf("up/down, j/k") + 1);
	});

	/**
	 * Locks the promise that no module in this group prints a credential. The defect: a
	 * description is written with a live example pasted in, and the map leaks it on every open.
	 */
	it("renders no secret value in either view", () => {
		const painted = [...screen("secrets"), ...screen("log")].join("\n");
		expect(painted).not.toContain("sk_live");
		expect(painted).not.toContain("ghp_");
	});
});

describe("view filtering", () => {
	/**
	 * Locks the Secrets view's content. The defect: the overlay renders the whole table, so keys
	 * are listed under a view that does not handle them.
	 */
	it("shows the row actions in the Secrets view", () => {
		const lines = screen("secrets");
		expect(lines).toContain("In the Secrets view");
		expect(lines.some(line => line.endsWith("revoke the selected secret"))).toBe(true);
		expect(lines.some(line => line.endsWith("move the selected secret to another scope"))).toBe(true);
		expect(lines.some(line => line.endsWith("close the card"))).toBe(true);
		expect(lines).not.toContain("In the Log view");
	});

	/**
	 * Locks the other direction. The defect: `secrets` entries survive into the Log view, so `r`
	 * is documented on a surface where pressing it does nothing.
	 */
	it("hides the Secrets-only keys while the Log view is active", () => {
		const lines = screen("log");
		expect(lines.some(line => line.endsWith("revoke the selected secret"))).toBe(false);
		expect(lines.some(line => line.endsWith("add a credential to the vault"))).toBe(false);
		expect(lines.some(line => line.endsWith("discard a vault file that would not open"))).toBe(false);
		expect(lines.some(line => line.endsWith("move the selection"))).toBe(true);
		expect(lines.some(line => line.endsWith("switch between the Secrets and Log views"))).toBe(true);
	});

	/**
	 * Locks the count and the grouping. The defect: the shared keys are merged into the
	 * view-specific group, so the operator cannot tell which keys survive a view switch.
	 */
	it("separates the view-specific group from the shared one with a blank line", () => {
		expect(screen("secrets")).toEqual([
			"In the Secrets view",
			"                c  copy the selected secret's placeholder",
			"                e  extend how long the selected secret lasts",
			"                n  rename the selected secret",
			"                r  revoke the selected secret",
			"                a  add a credential to the vault",
			"                m  move the selected secret to another scope",
			"                i  show or hide the selected secret's details",
			"                s  sort the table by another column",
			"                u  show the log narrowed to the selected secret's uses",
			"                d  discard a vault file that would not open",
			"",
			"Anywhere in the card",
			"     up/down, j/k  move the selection",
			"        pgup/pgdn  move the selection by a screenful",
			"                /  filter the rows",
			"  left/right, tab  switch between the Secrets and Log views",
			"                ?  show this key map",
			"              esc  step back: clear the search, then the narrowing, then close",
			"                q  close the card",
		]);
	});

	/**
	 * Locks the Log view's whole surface. The defect: the Log view renders an empty heading for a
	 * group with no entries, leaving a stray title over nothing.
	 */
	it("renders only the shared group when the view contributes no keys of its own", () => {
		expect(screen("log")).toEqual([
			"Anywhere in the card",
			"     up/down, j/k  move the selection",
			"        pgup/pgdn  move the selection by a screenful",
			"                /  filter the rows",
			"  left/right, tab  switch between the Secrets and Log views",
			"                ?  show this key map",
			"              esc  step back: clear the search, then the narrowing, then close",
			"                q  close the card",
		]);
	});

	/**
	 * Locks re-pointing an overlay the card keeps between opens. The defect: the memoized rows
	 * from the previous view are served after the switch, so the Log view shows `revoke`.
	 */
	it("drops the previous view's rows when the view changes", () => {
		const overlay = new SecretHelpOverlay("secrets");
		const before = overlay.render(WIDTH).map(line => stripAnsi(line).trimEnd());
		expect(before).toContain("In the Secrets view");
		overlay.setView("log");
		const after = overlay.render(WIDTH).map(line => stripAnsi(line).trimEnd());
		expect(after).not.toContain("In the Secrets view");
		expect(after[0]).toBe("Anywhere in the card");
		expect(after.length).toBe(8);
	});

	/**
	 * Locks the memo itself. The defect: the overlay rebuilds every frame, which the container's
	 * unchanged-array fast path reads as a repaint of the whole card on every keystroke.
	 */
	it("returns the same array for a repeated render at the same width", () => {
		const overlay = new SecretHelpOverlay("secrets");
		expect(overlay.render(WIDTH)).toBe(overlay.render(WIDTH));
	});
});

describe("key column alignment", () => {
	/**
	 * Locks the shared column. The defect: each row pads to its own key length, so descriptions
	 * start at ten different columns and the map stops reading as a table.
	 */
	it("starts every description at one column across both groups", () => {
		const columns = descriptionColumns(screen("secrets"));
		expect(columns.length).toBe(17);
		expect(new Set(columns).size).toBe(1);
		// Two spaces of indent, the widest shown key ("left/right, tab"), then the two-space gap.
		expect(columns[0]).toBe(19);
	});

	/**
	 * Locks right alignment. The defect: the keys are left-aligned and the descriptions padded
	 * instead, which leaves a ragged key column that is harder to scan than the ragged
	 * descriptions it was meant to fix.
	 */
	it("right-aligns keys of differing lengths into the measured column", () => {
		const lines = screen("secrets");
		const single = lines.find(line => line.endsWith("revoke the selected secret"));
		const widest = lines.find(line => line.endsWith("switch between the Secrets and Log views"));
		expect(single).toBe("                r  revoke the selected secret");
		expect(widest).toBe("  left/right, tab  switch between the Secrets and Log views");
	});

	/**
	 * Locks the measuring scope. The defect: the column is measured over the whole table, so a
	 * long Log-only binding indents every Secrets row by keys that view never shows.
	 */
	it("measures only the entries being shown, not the whole table", () => {
		const table: readonly HelpEntry[] = [
			{ keys: "r", description: "revoke the selected secret", view: "secrets" },
			{ keys: "ctrl+shift+pageup", description: "jump to the oldest record", view: "log" },
			{ keys: "?", description: "show this key map", view: "both" },
		];
		expect(screen("secrets", WIDTH, table)).toEqual([
			"In the Secrets view",
			"  r  revoke the selected secret",
			"",
			"Anywhere in the card",
			"  ?  show this key map",
		]);
		expect(screen("log", WIDTH, table)).toEqual([
			"In the Log view",
			"  ctrl+shift+pageup  jump to the oldest record",
			"",
			"Anywhere in the card",
			"                  ?  show this key map",
		]);
	});
});

describe("no duplicate bindings", () => {
	/**
	 * Locks the Secrets view against a shadowed binding. The defect: a later action claims a
	 * letter an existing entry already uses, the input handler reaches the first branch, and the
	 * key map documents an action that can never fire.
	 */
	it("claims each key at most once in the Secrets view", () => {
		expect(duplicateBindings(SECRET_MANAGER_HELP, "secrets")).toEqual([]);
	});

	/**
	 * Locks the same invariant for the Log view, where the shared entries are the whole map and a
	 * clash between two of them would be visible in both views at once.
	 */
	it("claims each key at most once in the Log view", () => {
		expect(duplicateBindings(SECRET_MANAGER_HELP, "log")).toEqual([]);
	});

	/**
	 * Locks the detector. The defect: `atomicKeys` stops splitting joined fields, the two tests
	 * above pass against any table at all, and the invariant they claim to hold stops being
	 * checked. The `q` case is the one that a naive whole-string comparison misses, because
	 * `esc/q` and `q` are different strings that bind the same key.
	 */
	it("reports a clash between a joined field and a bare key", () => {
		const broken: readonly HelpEntry[] = [
			{ keys: "esc/q", description: "close the card", view: "both" },
			{ keys: "q", description: "quit to the transcript", view: "secrets" },
			{ keys: "r", description: "revoke the selected secret", view: "secrets" },
			{ keys: "r", description: "reload the log", view: "log" },
		];
		expect(duplicateBindings(broken, "secrets")).toEqual(["q"]);
		expect(duplicateBindings(broken, "log")).toEqual([]);
	});

	/**
	 * Locks the slash. The defect: the filter binding is split on its own separator into two empty
	 * tokens, which report a duplicate that does not exist and make the invariant unfixable.
	 */
	it("treats the lone slash as one key rather than an empty pair", () => {
		expect(atomicKeys("/")).toEqual(["/"]);
		expect(atomicKeys("up/down")).toEqual(["up", "down"]);
		expect(duplicateBindings([{ keys: "/", description: "filter the rows", view: "both" }], "secrets")).toEqual([]);
	});
});

describe("narrow widths", () => {
	/**
	 * Locks truncation. The defect: a row longer than the card overflows its width, and the row
	 * below it is pushed onto the next physical line, which shears the whole overlay.
	 */
	it("cuts every row to the width it was given", () => {
		const lines = new SecretHelpOverlay("secrets").render(24);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		const plain = lines.map(line => stripAnsi(line));
		expect(plain[0]).toBe("In the Secrets view");
		expect(plain[1]).toBe("                c  copy ");
		// The Secrets group is ten rows plus its heading, so the blank separator sits at 11.
		expect(plain[11]).toBe("");
		expect(plain[12]).toBe("Anywhere in the card");
		expect(plain[15]).toBe("                /  filte");
	});

	/**
	 * Locks the smallest width a layout can hand down. The defect: the key column measurement goes
	 * negative, the pad helper or the truncation throws, and a one-column card takes the whole TUI
	 * down instead of drawing nothing useful.
	 */
	it("renders without throwing at width 1", () => {
		const lines = new SecretHelpOverlay("secrets").render(1);
		expect(lines.length).toBe(20);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		expect(stripAnsi(lines[1])).toBe(" ");
	});

	/**
	 * Locks the degenerate width. The defect: a zero or negative width reaches the row builder and
	 * produces a column of empty strings that still cost the card rows of height.
	 */
	it("renders nothing at width 0 or below", () => {
		expect(new SecretHelpOverlay("secrets").render(0)).toEqual([]);
		expect(new SecretHelpOverlay("log").render(-5)).toEqual([]);
	});

	/**
	 * Locks the empty table. The defect: an empty entry list still emits its headings, so the card
	 * shows two titles over nothing.
	 */
	it("renders nothing when no entry applies to the view", () => {
		expect(screen("secrets", WIDTH, [])).toEqual([]);
		expect(screen("secrets", WIDTH, [{ keys: "x", description: "jump to a record", view: "log" }])).toEqual([]);
	});
});
