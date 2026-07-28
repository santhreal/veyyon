/**
 * The keybindings reference page names real ids and quotes their real default keys.
 *
 * WHY THIS SUITE EXISTS. `docs/handbook/src/reference/keybindings-ref.md` opens by
 * telling the reader that "every row below is taken from the default binding tables
 * in code, so it matches what a fresh profile does". Nothing checked that claim. The
 * page was hand-maintained against `KEYBINDINGS`, so a default key changed in code
 * left a row quoting the old chord, and an id removed from code left a row naming a
 * shortcut that no longer exists.
 *
 * Both happened. Removing the eight dead ids left `| `ctrl+c` | Copy the current
 * selection (`tui.input.copy`) |` behind, a row for a binding the code no longer has
 * and, before the removal, for a key that interrupts rather than copies.
 *
 * WHAT IT CHECKS, and the order matters. First that every id the page names still
 * exists, which is the drift that outlives a deletion. Then that the chords in the
 * key column are the id's actual `defaultKeys`, which is the drift that outlives a
 * rebind and is the more dangerous of the two: a row naming a dead id is at worst
 * confusing, while a row quoting the wrong chord is confidently wrong.
 *
 * WHAT IT DOES NOT CHECK, stated so nobody reads it as complete coverage: the page
 * documents the Editor and Lists sections by chord alone, without ids, because those
 * tables describe a family of related motions rather than one action each. Those rows
 * are outside this gate. So is "is every id documented somewhere", which would demand
 * a row per editor motion and turn a reference into an inventory.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultPasteImageKeys, KEYBINDINGS } from "@veyyon/coding-agent/config/keybindings";
import { canonicalKeyId } from "@veyyon/tui";

const REPO = path.resolve(import.meta.dir, "../../../..");
const REFERENCE = path.join(REPO, "docs", "handbook", "src", "reference", "keybindings-ref.md");

/**
 * The second page that tabulates chords, in the other column order.
 *
 * `docs/keybindings.md` is not a copy of the handbook page: it carries the
 * terminal-specific notes (Windows Terminal swallowing `Ctrl+Enter`, the `Alt+V`
 * paste fallback, OSC 5522) that a reference table has no room for. But it does
 * duplicate the chords, which is the part that drifts, so it is held to the same
 * rule. It writes the action id first and the chords second, the reverse of the
 * handbook page, which is why there are two readers below and one rule.
 */
const ACTION_TABLE = path.join(REPO, "docs", "keybindings.md");

const BINDINGS = KEYBINDINGS as Record<string, { defaultKeys: string | string[] }>;

/**
 * A row of the page that ties chords to ids.
 *
 * `keys` is every backticked chord in the first column, `ids` every backticked
 * dotted id in the second. A row with no id is not a row this gate has an opinion
 * about, and is dropped.
 */
export interface DocumentedRow {
	readonly keys: readonly string[];
	readonly ids: readonly string[];
}

/** Every table row of the page that names at least one binding id. */
export function documentedRows(markdown: string): DocumentedRow[] {
	const rows: DocumentedRow[] = [];
	for (const line of markdown.split("\n")) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map(cell => cell.trim());
		if (cells.length < 4) continue;
		const ids = [...(cells[2] ?? "").matchAll(/`([a-z]+(?:\.[a-zA-Z]+)+)`/g)].map(match => match[1] as string);
		if (ids.length === 0) continue;
		const keys = [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map(match => match[1] as string);
		rows.push({ keys, ids });
	}
	return rows;
}

/**
 * One chord, folded the way the config loader folds it.
 *
 * `canonicalKeyId` is the folding the matcher uses, which is what lets a page write
 * `esc` where the table declares `escape`. Both are the same key to a user and to
 * `KeybindingsManager`, so a gate that called them different would be demanding the
 * page use the less readable spelling.
 *
 * The lowercasing in front of it matters and is not cosmetic. `canonicalKeyId`
 * preserves shift on a printable uppercase letter, because for a KEY EVENT `A`
 * really is `shift+a`. Chord names in a config file are case-insensitive instead,
 * and `keybindings.yml` is normalized by lowercasing, so the two pages write the
 * same chord differently: the handbook writes `ctrl+p`, the repository table writes
 * the UI display form `Ctrl+P`. Canonicalizing the display form without lowercasing
 * first turns every such row into `ctrl+shift+p` and reports twelve mismatches that
 * do not exist.
 */
function foldChord(chord: string): string {
	return canonicalKeyId(chord.toLowerCase());
}

/**
 * The default chords for an id, folded and sorted.
 *
 * `app.clipboard.pasteImage` is the one id whose defaults depend on the platform:
 * Windows adds `alt+v` and macOS adds `super+v`, because those terminals deliver the
 * system paste differently. Both pages document all three with the platform named,
 * so the comparison uses the union across platforms rather than whatever this test
 * happens to be running on, which would otherwise make the row fail on Linux and
 * pass on a Mac.
 */
export function defaultChords(id: string): string[] {
	const declared =
		id === "app.clipboard.pasteImage"
			? (["win32", "darwin", "linux"] as const).flatMap(platform => getDefaultPasteImageKeys(platform))
			: [BINDINGS[id]?.defaultKeys ?? []].flat();
	return [...new Set(declared.filter(Boolean).map(key => foldChord(key)))].sort();
}

/**
 * The whole "Unbound by default" paragraph, not just its first line.
 *
 * Markdown paragraphs wrap, and this one does: it runs to a second line, so reading
 * a single line finds three of the five ids and reports the other two as missing
 * from a list that plainly contains them.
 */
export function unboundParagraph(markdown: string): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex(line => line.startsWith("Unbound by default"));
	if (start === -1) throw new Error("the 'Unbound by default' paragraph is gone from the keybindings reference");
	const end = lines.findIndex((line, index) => index > start && line.trim() === "");
	return lines.slice(start, end === -1 ? undefined : end).join(" ");
}

/**
 * Rows of `docs/keybindings.md`, whose table puts the id first and the chords second.
 *
 * A row whose chord cell begins with `Unbound` is claiming the action ships with no
 * key, so its chords are read as none. `app.stt.toggle` is written that way and adds
 * "(hold `Space`)", which is a gesture rather than a chord and must not be compared
 * against `defaultKeys`.
 */
export function actionTableRows(markdown: string): DocumentedRow[] {
	const rows: DocumentedRow[] = [];
	for (const line of markdown.split("\n")) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map(cell => cell.trim());
		if (cells.length < 4) continue;
		const ids = [...(cells[1] ?? "").matchAll(/`([a-z]+(?:\.[a-zA-Z]+)+)`/g)].map(match => match[1] as string);
		if (ids.length !== 1) continue;
		const chordCell = cells[2] ?? "";
		const keys = chordCell.startsWith("Unbound")
			? []
			: [...chordCell.matchAll(/`([^`]+)`/g)].map(match => match[1] as string);
		rows.push({ keys, ids });
	}
	return rows;
}

/**
 * Every row whose chords are not the id's real defaults, as readable one-liners.
 *
 * A row naming one id owns all of its chords; a row naming several pairs them
 * positionally, which is how the handbook writes the model-cycle row (`ctrl+p` /
 * `shift+ctrl+p` for forward and backward). Rows naming an id the table does not
 * have are skipped: that is the previous rule's failure, and reporting it twice
 * buries the chord mismatches this one exists to find.
 */
export function misquotedChords(rows: readonly DocumentedRow[]): string[] {
	const wrong: string[] = [];
	for (const row of rows) {
		if (!row.ids.every(id => id in BINDINGS)) continue;
		const claimed =
			row.ids.length === 1
				? [row.keys]
				: row.ids.map((_, index) => (row.keys[index] === undefined ? [] : [row.keys[index]]));
		row.ids.forEach((id, index) => {
			const said = [...new Set((claimed[index] ?? []).map(key => foldChord(key)))].sort();
			const real = defaultChords(id);
			if (said.join(" ") !== real.join(" ")) wrong.push(`${id}: page says [${said}], code says [${real}]`);
		});
	}
	return wrong.sort();
}

const PAGE = fs.readFileSync(REFERENCE, "utf8");
const ROWS = documentedRows(PAGE);

const ACTION_PAGE = fs.readFileSync(ACTION_TABLE, "utf8");
const ACTION_ROWS = actionTableRows(ACTION_PAGE);

describe("the keybindings reference names ids that exist", () => {
	/**
	 * The scan found a page with tables in it. A path that read the wrong file, or a
	 * row pattern that matched nothing, would satisfy every rule below while checking
	 * nothing, which is how a source-scanning gate dies quietly.
	 */
	it("reads a page with real rows in it", () => {
		expect(ROWS.length).toBeGreaterThan(20);
		expect(ROWS.flatMap(row => row.ids)).toContain("app.agents.hub");
		expect(Object.keys(BINDINGS).length).toBeGreaterThan(50);
	});

	/**
	 * The rule that catches a deletion. A failure names the id, and the fix is to
	 * remove the row, because the id was removed for a reason.
	 */
	it("names no id the binding table does not have", () => {
		const ghosts = [...new Set(ROWS.flatMap(row => row.ids))].filter(id => !(id in BINDINGS)).sort();

		expect(
			ghosts,
			"these ids are documented and not in KEYBINDINGS. Remove the row: the binding does not exist",
		).toEqual([]);
	});

	/**
	 * And the removed `tui.input.copy` row specifically, because it is the one this
	 * suite was written after and the rule above would stop catching it the moment
	 * somebody re-added the id for an unrelated reason.
	 */
	it("does not tell the reader that ctrl+c copies the selection", () => {
		expect(PAGE).not.toContain("tui.input.copy");
		expect(PAGE).toContain("The composer does not copy.");
	});
});

describe("the keybindings reference quotes the real default keys", () => {
	/**
	 * The rule that catches a rebind, and the reason the page's opening claim is
	 * worth anything. A row pairs its chords with its ids positionally, which is how
	 * the page writes the two-id rows (`ctrl+p` / `shift+ctrl+p` for cycle forward and
	 * backward), so a row with one id owns all of its chords and a row with N ids
	 * owns one each.
	 */
	it("quotes the declared default chords for every id it names", () => {
		expect(
			misquotedChords(ROWS),
			"the reference quotes a chord the binding table does not declare. Update the page, it claims to match a fresh profile",
		).toEqual([]);
	});

	/**
	 * The list of deliberately unbound actions is really the unbound ones. This
	 * paragraph is the page's answer to "why is this action not in any table", and
	 * an action that gained a default key while staying on that list reads to a user
	 * as a shortcut they have to set up before they can use it.
	 */
	it("lists exactly the actions that ship with no default key", () => {
		const listed = [...unboundParagraph(PAGE).matchAll(/`([a-z]+(?:\.[a-zA-Z]+)+)`/g)]
			.map(match => match[1] as string)
			.sort();

		const unbound = Object.keys(BINDINGS)
			.filter(id => defaultChords(id).length === 0)
			.sort();

		expect(
			listed,
			"the 'Unbound by default' list and the binding table disagree about which actions have no key",
		).toEqual(unbound);
	});
});

describe("the repository action-ID table says the same thing", () => {
	/**
	 * Its rows were found, in the other column order. A reader that matched nothing
	 * here would make both rules below pass while comparing nothing, and the page
	 * writes its ids in column one rather than column two, so it needs its own.
	 */
	it("reads a table with real rows in it", () => {
		expect(ACTION_ROWS.length).toBeGreaterThan(15);
		expect(ACTION_ROWS.map(row => row.ids[0])).toContain("app.model.cycleForward");
	});

	/** No row names an id the binding table does not have. */
	it("names no id the binding table does not have", () => {
		const ghosts = ACTION_ROWS.flatMap(row => row.ids)
			.filter(id => !(id in BINDINGS))
			.sort();

		expect(ghosts, "docs/keybindings.md documents an action id that no longer exists. Remove the row").toEqual([]);
	});

	/**
	 * And its Default column is the real defaults. This page is where a user goes to
	 * copy a line into their own `keybindings.yml`, so a wrong chord here is copied
	 * forward rather than merely read.
	 */
	it("quotes the declared default chords for every id it names", () => {
		expect(
			misquotedChords(ACTION_ROWS),
			"docs/keybindings.md quotes a Default the binding table does not declare. Update the row",
		).toEqual([]);
	});
});

describe("the row reader sees what the page actually says", () => {
	/**
	 * A row with one id owns every chord in its key column, which is how the
	 * follow-up-message row documents its two chords.
	 */
	it("reads every chord on a single-id row", () => {
		const rows = documentedRows("| `ctrl+q` or `ctrl+enter` | Send a follow-up (`app.message.followUp`) |");

		expect(rows).toEqual([{ keys: ["ctrl+q", "ctrl+enter"], ids: ["app.message.followUp"] }]);
	});

	/**
	 * A row with two ids pairs them with its chords in order, which is the model-cycle
	 * row. Getting this wrong in the other direction would report `cycleBackward` as
	 * claiming both chords and fail forever.
	 */
	it("reads a row that pairs two chords with two ids", () => {
		const rows = documentedRows(
			"| `ctrl+p` / `shift+ctrl+p` | Cycle (`app.model.cycleForward` / `app.model.cycleBackward`) |",
		);

		expect(rows[0]?.keys).toEqual(["ctrl+p", "shift+ctrl+p"]);
		expect(rows[0]?.ids).toEqual(["app.model.cycleForward", "app.model.cycleBackward"]);
	});

	/**
	 * A table row with no id is not this gate's business, and neither is prose. The
	 * Editor and Lists sections are full of the former.
	 */
	it("ignores a row with no id and prose that is not a row", () => {
		const markdown = [
			"| `ctrl+u` | Delete to the start of the line |",
			"Set `app.model.select` in your config.",
		].join("\n");

		expect(documentedRows(markdown)).toEqual([]);
	});

	/**
	 * The alias folding, which is the only reason `esc` in the page matches `escape`
	 * in the table. Without it the very first row of the page reads as wrong.
	 */
	it("folds a key alias the same way the matcher does", () => {
		expect(canonicalKeyId("esc")).toBe("escape");
		expect(defaultChords("app.interrupt")).toEqual(["escape"]);
	});

	/**
	 * And it folds case before canonicalizing, because the two pages spell the same
	 * chord differently. Without this the display form `Ctrl+P` reads as
	 * `ctrl+shift+p`, since to a key event an uppercase letter really does carry
	 * shift, and twelve rows of `docs/keybindings.md` are reported as wrong.
	 */
	it("reads the UI display spelling of a chord as the same chord", () => {
		expect(foldChord("Ctrl+P")).toBe("ctrl+p");
		expect(foldChord("Alt+Shift+L")).toBe(foldChord("alt+shift+l"));
		expect(canonicalKeyId("Ctrl+P")).toBe("ctrl+shift+p");
	});

	/**
	 * And the platform union, so the paste row passes on every machine rather than
	 * only on a Mac. A test that agreed with the host it runs on is a test that fails
	 * in CI or fails on a laptop, and either way gets deleted.
	 */
	/**
	 * The unbound paragraph is read whole rather than by line. It wraps in the page,
	 * and reading only its first line finds three of the five ids and reports the
	 * other two as missing from a list that plainly contains them.
	 */
	it("reads a wrapped paragraph to its blank line and no further", () => {
		const markdown = [
			"# Heading",
			"",
			"Unbound by default: `app.a.one`,",
			"`app.b.two` and nothing else.",
			"",
			"`app.c.three` is elsewhere.",
		].join("\n");

		const paragraph = unboundParagraph(markdown);

		expect(paragraph).toContain("app.b.two");
		expect(paragraph).not.toContain("app.c.three");
	});

	/**
	 * The other column order, and the `Unbound` spelling that goes with it. A row
	 * saying an action ships with no key must read as no chords, or the `Space` in
	 * "(hold `Space`)" is compared against `defaultKeys` and reported as a wrong
	 * chord for an action that has none.
	 */
	it("reads the id-first table and its Unbound rows", () => {
		const markdown = [
			"| `app.model.select` | `Alt+M` | Open the model selector |",
			"| `app.stt.toggle` | Unbound (hold `Space`) | Speech to text |",
		].join("\n");

		expect(actionTableRows(markdown)).toEqual([
			{ keys: ["Alt+M"], ids: ["app.model.select"] },
			{ keys: [], ids: ["app.stt.toggle"] },
		]);
	});

	it("unions the platform-dependent paste chords", () => {
		expect(defaultChords("app.clipboard.pasteImage")).toEqual(["alt+v", "ctrl+v", "super+v"]);
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
	});
});
