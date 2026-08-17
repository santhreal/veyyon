/**
 * WHY: two blocks the session commits into the transcript — the todo reminder and
 * the injected-rule notification — were each built as
 * `new Box(1, 1, t => theme.inverse(theme.fg("warning", t)))`. A `Box` pads every row
 * out to the width it is given, so that is a full-width slab of saturated mustard
 * carrying black text, starting at column 0, in the middle of a grey transcript. It
 * was the loudest object on the screen, for a note. Inverting also spends the
 * foreground: `ttsr-notification.ts` carried the comment "fg colors conflict with
 * inverse, so styling inside the block is limited to bold (names) and italic
 * (descriptions)", so the block could not use colour to say anything.
 *
 * The class this closes is "a note that shouts": any transcript note that gets its
 * emphasis by inverting a rectangle, by spanning the terminal, or by starting at
 * column 0. Five ways to land in it, each with a case here:
 *
 *   1. INVERSE. No note may emit SGR 7 anywhere, on any terminal, ever.
 *   2. A WALL. The paint must stop at the note's own content, not at the terminal
 *      edge — measured off the painted columns, not from a hug flag.
 *   3. COLUMN 0. Every row starts on the transcript's one left rail.
 *   4. NO ELEVATION. On a ground that is actually known, the note's rows must stand
 *      strictly off the page, in the direction that ground's own luminance chooses,
 *      so a paper-white terminal darkens instead of lifting toward invisible white.
 *   5. A NOTE THAT DISAPPEARS. With no ground and without truecolor there is no
 *      surface to paint, and the note still has to be a note: the rail, the hue and
 *      every word of the content survive.
 *
 * The variant space is derived at run time from the exported note components rather
 * than listed, so a third note added next year is swept by all of it and turns this
 * suite red until it is decided for.
 *
 * NOT covered here: how big the lift should be (0.075 versus 0.1 is taste, judged by
 * `scripts/demos/render-todo-reminder.ts` and a real-terminal recording); the content
 * budgeting of either note, which their own suites own; and whether the rail glyph is
 * the right glyph, which is the symbol theme's business.
 */
import { describe, expect, it } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { createSourceMeta } from "@veyyon/coding-agent/discovery/helpers";
import { TodoReminderComponent } from "@veyyon/coding-agent/modes/components/todo-reminder";
import { renderTranscriptNote } from "@veyyon/coding-agent/modes/components/transcript-note";
import { TtsrNotificationComponent } from "@veyyon/coding-agent/modes/components/ttsr-notification";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "@veyyon/coding-agent/modes/theme/ground-tints";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Component } from "@veyyon/tui";
import { setAnsiPolicy, TERMINAL, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 100;

/** The one writable capability this suite drives; `TERMINAL` declares it readonly. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

/** A bundled rule with the shape the loader gives one, so the note gets the real value. */
function rule(name: string, description: string): Rule {
	return {
		name,
		path: `builtin-defaults:core/${name}.md`,
		content: description,
		description,
		_source: createSourceMeta("builtin-defaults", `builtin-defaults:core/${name}.md`, "user"),
	};
}

/**
 * Every kind of note the transcript commits, constructed the way the session
 * constructs it. A note added to the product and not to this table is a hole, so the
 * sweep below also asserts the table is not empty.
 */
const NOTES: ReadonlyArray<{ name: string; build: () => Component; words: readonly string[] }> = [
	{
		name: "the todo reminder",
		build: () =>
			new TodoReminderComponent(
				[
					{ content: "Close identity cache docs enforcement", status: "in_progress" },
					{ content: "Verify forty-two criteria and release contracts", status: "pending" },
				],
				1,
				3,
			),
		words: ["Continue: 2 todos remain", "Close identity cache docs enforcement"],
	},
	{
		name: "an injected rule",
		build: () => new TtsrNotificationComponent([rule("commit-drift", "Commit the green tree")]),
		words: ["Injecting rule: commit-drift", "Commit the green tree"],
	},
	{
		name: "several injected rules",
		build: () =>
			new TtsrNotificationComponent([
				rule("commit-drift", "Commit the green tree"),
				rule("test-scope", "Run the narrowest suite"),
			]),
		words: ["Injecting 2 rules", "commit-drift", "test-scope"],
	},
];

/**
 * The grounds a note may be committed onto, and which way "off the page" points on
 * each. A ground added here without a direction turns the sweep red rather than
 * inheriting a guess.
 */
const GROUNDS = [
	{ name: "a grey terminal", hex: "#1e2127", brighter: true },
	{ name: "a black terminal", hex: "#000000", brighter: true },
	{ name: "a paper-white terminal", hex: "#f7f7f8", brighter: false },
] as const;

async function prepare(ground: string | undefined, trueColor: boolean): Promise<void> {
	await initTheme(false);
	setAnsiPolicy("full");
	resetGroundTintsForTest();
	terminalCaps.trueColor = trueColor;
	if (ground !== undefined) setDetectedTerminalGround(ground);
}

/** Rows a note actually emits, blank transcript padding dropped. */
function rowsOf(component: Component): string[] {
	return component
		.render(WIDTH)
		.filter(line => stripAnsi(line).trim() !== "")
		.map(line => line);
}

/** The truecolor background in force at every column of a row. */
function backgroundsByColumn(line: string): Map<number, string> {
	const found = new Map<number, string>();
	const sgr = /\x1b\[([0-9;:]*)m/g;
	let col = 0;
	let index = 0;
	let background: string | null = null;
	const advance = (text: string): void => {
		const width = visibleWidth(text);
		for (let step = 0; step < width; step++) {
			if (background !== null) found.set(col + step, background);
		}
		col += width;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		advance(line.slice(index, match.index));
		index = match.index + match[0].length;
		const params = match[1] ?? "";
		const truecolor = /48;2;(\d+);(\d+);(\d+)/.exec(params);
		if (truecolor !== null) {
			const channel = (value: string) => Number(value).toString(16).padStart(2, "0");
			background = `#${channel(truecolor[1] as string)}${channel(truecolor[2] as string)}${channel(truecolor[3] as string)}`;
		} else if (params === "49" || params === "0" || params === "") background = null;
	}
	advance(line.slice(index));
	return found;
}

/** BT.601, the weighting the terminal itself uses to call a ground light or dark. */
function luminance(hex: string): number {
	const value = Number.parseInt(hex.slice(1), 16);
	return (0.299 * ((value >> 16) & 0xff) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff)) / 255;
}

describe("a transcript note is a raised card, not a slab", () => {
	it("has a note to sweep", () => {
		expect(NOTES.length, "the sweeps below prove nothing about an empty table").toBeGreaterThan(1);
	});

	for (const note of NOTES) {
		describe(note.name, () => {
			it("never inverts", async () => {
				// SGR 7 is the whole defect. It is checked on a known ground AND on an
				// unknown one, because the fallback path is the one a reader is most
				// tempted to make loud again.
				for (const trueColor of [true, false]) {
					for (const ground of ["#1e2127", undefined]) {
						await prepare(ground, trueColor);
						const rendered = rowsOf(note.build()).join("\n");
						expect(rendered, `${note.name} inverted on ${ground ?? "no ground"}`).not.toMatch(
							/\x1b\[[0-9;]*\b7m/,
						);
						expect(rendered).not.toContain("\x1b[7m");
					}
				}
			});

			it("stops at its own content instead of spanning the terminal", async () => {
				await prepare("#1e2127", true);
				const rows = rowsOf(note.build());
				expect(rows.length, "a note with no rows is not a note").toBeGreaterThan(1);
				// The rightmost column any of the note's own text reaches. A hug is the
				// paint ending within a column or two of THAT, which is a different claim
				// from the paint merely stopping short of the terminal edge: a note padded
				// to the transcript's content width also stops short of the edge, and that
				// is exactly the wall this closes.
				const textEnd = Math.max(...rows.map(row => visibleWidth(stripAnsi(row).replace(/\s+$/, ""))));
				expect(textEnd, "the note has no text").toBeGreaterThan(4);
				for (const row of rows) {
					const painted = [...backgroundsByColumn(row).keys()];
					expect(painted.length, "a row of the note carries no surface at all").toBeGreaterThan(0);
					const rightmost = Math.max(...painted) + 1;
					expect(rightmost, `the note painted ${rightmost} columns for ${textEnd} of text`).toBeLessThanOrEqual(
						textEnd + 2,
					);
					expect(rightmost, "the note painted past the terminal").toBeLessThan(WIDTH);
				}
			});

			it("sits on the transcript's left rail, not at column 0", async () => {
				await prepare("#1e2127", true);
				for (const row of rowsOf(note.build())) {
					const painted = [...backgroundsByColumn(row).keys()];
					expect(Math.min(...painted), "the note's surface starts at column 0").toBeGreaterThan(0);
					expect(stripAnsi(row).startsWith(" "), "the note's text starts at column 0").toBe(true);
				}
			});

			it("carries the warning rail on every one of its rows", async () => {
				await prepare("#1e2127", true);
				const rail = theme.sep.block;
				const rows = rowsOf(note.build());
				for (const row of rows) {
					expect(stripAnsi(row).includes(rail), `a row of ${note.name} has no rail`).toBe(true);
				}
				// The hue lives on the rail rather than on a rectangle, so the glyph has to
				// carry the warning foreground. The surface fill opens its background
				// between that colour and the glyph, so the assertion is that the colour is
				// in force AT the rail, not that the two are adjacent bytes.
				const warning = theme.fg("warning", "x").replace(/x\x1b\[39m$/, "");
				expect(warning, "the theme gave no foreground for warning").not.toBe("");
				for (const row of rows) {
					const openedBeforeRail = row.indexOf(warning) !== -1 && row.indexOf(warning) < row.indexOf(rail);
					expect(openedBeforeRail, `the rail of ${note.name} is not the warning colour`).toBe(true);
				}
			});

			for (const ground of GROUNDS) {
				it(`stands off ${ground.name} in the direction that ground chooses`, async () => {
					await prepare(ground.hex, true);
					const page = luminance(ground.hex);
					for (const row of rowsOf(note.build())) {
						const surfaces = new Set(backgroundsByColumn(row).values());
						expect(surfaces.size, "the row is painted more than one surface").toBeLessThanOrEqual(2);
						for (const hex of surfaces) {
							const step = luminance(hex) - page;
							if (ground.brighter) {
								expect(step, `${hex} did not stand off ${ground.hex}`).toBeGreaterThan(0.01);
							} else {
								expect(step, `${hex} did not stand off ${ground.hex}`).toBeLessThan(-0.01);
							}
						}
					}
				});
			}

			it("is still a note with no ground to mix out of", async () => {
				await prepare(undefined, true);
				const rows = rowsOf(note.build());
				const rendered = rows.join("\n");
				// No answer from the terminal means no surface: painting one would be a
				// guess at the page, which is the black-slab-on-grey defect.
				for (const row of rows) {
					expect(backgroundsByColumn(row).size, "a note painted a surface onto an unknown ground").toBe(0);
				}
				expect(stripAnsi(rendered)).toContain(theme.sep.block);
				expect(rendered).toContain(theme.fg("warning", theme.sep.block));
				for (const word of note.words) {
					expect(stripAnsi(rendered).replace(/\s+/g, " ")).toContain(word);
				}
			});

			it("is still a note on a terminal that cannot take a 24-bit surface", async () => {
				await prepare("#1e2127", false);
				const rows = rowsOf(note.build());
				for (const row of rows) {
					expect(backgroundsByColumn(row).size, "a 24-bit surface on a terminal without truecolor").toBe(0);
				}
				for (const word of note.words) {
					expect(stripAnsi(rows.join("\n")).replace(/\s+/g, " ")).toContain(word);
				}
			});
		});
	}

	it("wraps a row too wide for the note instead of losing its rail", async () => {
		// A row wider than the note used to be wrapped by `Text` AFTER the rail was
		// composed, which puts the continuation on the page with no rail and no
		// surface. The wrap belongs to the note.
		await prepare("#1e2127", true);
		const long = "a description long enough to need three of the rows this note is allowed to be wide, and more";
		const lines = renderTranscriptNote({ tone: "warning", headline: "Injecting rule: verbose", rows: [long] }, 40);
		expect(lines.length, "the long row did not wrap").toBeGreaterThan(3);
		for (const line of lines) {
			expect(stripAnsi(line).includes(theme.sep.block), "a wrapped continuation lost its rail").toBe(true);
			expect(backgroundsByColumn(line).size, "a wrapped continuation lost its surface").toBeGreaterThan(0);
		}
		expect(stripAnsi(lines.join(" ")).replace(/\s+/g, " ")).toContain("and more");
	});

	it("grades down the note, so it reads as lit from above", async () => {
		await prepare("#1e2127", true);
		const lines = renderTranscriptNote(
			{ tone: "warning", headline: "Continue", rows: ["one", "two", "three", "four", "five"] },
			40,
		);
		const material = (line: string): number => {
			const tally = new Map<string, number>();
			for (const hex of backgroundsByColumn(line).values()) tally.set(hex, (tally.get(hex) ?? 0) + 1);
			let best = "";
			let bestCount = 0;
			for (const [hex, count] of tally) {
				if (count > bestCount) {
					best = hex;
					bestCount = count;
				}
			}
			return luminance(best);
		};
		const first = material(lines[0] as string);
		const last = material(lines[lines.length - 1] as string);
		expect(first, "the note is a flat wash rather than a lit surface").toBeGreaterThan(last);
		// …and the whole grade still stands off the page.
		expect(last).toBeGreaterThan(luminance("#1e2127") + 0.01);
	});
});
