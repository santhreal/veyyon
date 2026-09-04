/**
 * WHY THIS SUITE EXISTS. `tools/core/diagnostics.ts` is the one place a compiler's diagnostic lines
 * become the rows a card shows, for every host. Two surfaces read it: the string form in
 * `tools/core/render-utils.ts` still formats for the callers that have not converted, and the
 * `ViewSection` form the converted cards state. A drift in the grammar, the ordering or the
 * hold-back arithmetic changes what a reader is told a build did, and a green type check would not
 * see it: every field is a string or a number that still compiles when it is wrong.
 *
 * THE CLASS THIS CLOSES. "A diagnostic reaches a reader saying something other than what the
 * compiler said." Four mechanisms carry that, and each is asserted at its own boundary rather than
 * through one card that happens to exercise all four: the line grammar (which fields are optional
 * and where a path ends), the within-file ordering (worst first, then position), the grouping
 * (compiler order across files, never re-sorted by name), and the collapsed hold-back count, which
 * must account for the lines the grammar did not match or a card claims to have shown everything
 * while dropping them.
 *
 * WHAT IT DOES NOT CATCH. How a host DRAWS the section: the tones and symbol keys asserted here are
 * the contract vocabulary, and whether a terminal resolves `status.error` to a red glyph is
 * `draw-tool-view`'s claim, pinned in the converted-tool differential suite. It also does not assert
 * that the string form in `render-utils` and the view form state the same facts, which no caller
 * depends on while both exist.
 */

import { describe, expect, it } from "bun:test";
import {
	diagnosticsSection,
	getSeverityRank,
	type ParsedDiagnostic,
	parseDiagnosticMessage,
	sanitizeDiagnosticDisplayText,
	type ToolDiagnostics,
} from "@veyyon/coding-agent/tools/core/diagnostics";
import type { ViewLine, ViewSection } from "@veyyon/view";

/**
 * Every severity the parsed shape admits. A fifth makes the module's own switch non-exhaustive, so a
 * new member fails the type check rather than slipping past a list this file forgot to grow.
 */
const SEVERITIES: readonly ParsedDiagnostic["severity"][] = ["error", "warning", "info", "hint"];

/** The visible words of a line, which is what a reader ends up with. */
function words(line: ViewLine): string {
	return line.map(span => span.symbol ?? span.text).join("");
}

function section(messages: string[], expanded: boolean, overrides: Partial<ToolDiagnostics> = {}): ViewSection {
	const built = diagnosticsSection({ errored: true, summary: "", messages, ...overrides }, expanded);
	if (built === undefined) throw new Error("expected a section");
	return built;
}

describe("the diagnostic line grammar", () => {
	it("reads the path, the position, the severity and the message off a bare line", () => {
		expect(parseDiagnosticMessage("src/app.ts:12:5 [error] Cannot find name 'foo'")).toEqual({
			filePath: "src/app.ts",
			line: 12,
			col: 5,
			severity: "error",
			source: undefined,
			message: "Cannot find name 'foo'",
			code: undefined,
		});
	});

	it("reads the optional source and the optional trailing code, and each without the other", () => {
		expect(parseDiagnosticMessage("src/app.ts:1:1 [warning] [biome] unused import (lint/correctness)")).toEqual({
			filePath: "src/app.ts",
			line: 1,
			col: 1,
			severity: "warning",
			source: "biome",
			message: "unused import",
			code: "lint/correctness",
		});
		expect(parseDiagnosticMessage("src/app.ts:1:1 [warning] [biome] unused import")?.code).toBeUndefined();
		expect(parseDiagnosticMessage("src/app.ts:1:1 [warning] unused import (TS6133)")).toMatchObject({
			source: undefined,
			message: "unused import",
			code: "TS6133",
		});
	});

	/**
	 * The path is matched non-greedily up to the position, so a Windows drive letter is the boundary
	 * that decides whether the grammar reads `C` as the whole file and gives up, or backtracks to the
	 * real path. Every Windows diagnostic carries one, so the platform rides on that backtrack.
	 */
	it("keeps a drive-lettered path whole rather than stopping at its colon", () => {
		expect(parseDiagnosticMessage("C:\\repo\\src\\app.ts:3:4 [error] boom")).toMatchObject({
			filePath: "C:\\repo\\src\\app.ts",
			line: 3,
			col: 4,
			message: "boom",
		});
	});

	it("reports a line it cannot read as unmatched instead of guessing at its fields", () => {
		for (const line of [
			"",
			"error: something went wrong",
			"src/app.ts [error] no position",
			"src/app.ts:12 [error] no column",
			"src/app.ts:12:5 error missing brackets",
		]) {
			expect(parseDiagnosticMessage(line), line).toBeNull();
		}
	});

	it("replaces a tab in every field it parses, since a tab lands on the terminal's own stops", () => {
		const parsed = parseDiagnosticMessage("src/a\tb.ts:1:1 [error] [ts\tc] bad\tvalue (TS\t1)");

		expect(parsed).not.toBeNull();
		for (const value of [parsed?.filePath, parsed?.source, parsed?.message, parsed?.code]) {
			expect(value).not.toContain("\t");
		}
		expect(parsed?.message).toContain("bad");
		expect(parsed?.message).toContain("value");
	});

	it("touches nothing but the tabs of a display string", () => {
		expect(sanitizeDiagnosticDisplayText("plain (text) [here] 1:2")).toBe("plain (text) [here] 1:2");
		expect(sanitizeDiagnosticDisplayText("a\tb")).not.toContain("\t");
	});
});

describe("severity ordering", () => {
	it("ranks every severity, worst first, with no two sharing a rank", () => {
		const ranks = SEVERITIES.map(getSeverityRank);

		expect(ranks).toEqual([0, 1, 2, 3]);
		expect(new Set(ranks).size).toBe(SEVERITIES.length);
	});

	it("sorts a file's diagnostics by severity, then line, then column, then wording", () => {
		const built = section(
			[
				"src/a.ts:9:1 [hint] hint late",
				"src/a.ts:2:9 [error] second column",
				"src/a.ts:2:1 [error] first column",
				"src/a.ts:1:1 [error] earliest line",
				"src/a.ts:3:3 [warning] a warning",
				"src/a.ts:1:1 [error] beats by wording",
			],
			true,
		);

		// Row 0 is the section's own header; row 1 is the file the group belongs to.
		expect(built.lines.slice(2).map(words)).toEqual([
			"  status.error:1:1 beats by wording",
			"  status.error:1:1 earliest line",
			"  status.error:2:1 first column",
			"  status.error:2:9 second column",
			"  status.warning:3:3 a warning",
			"  status.info:9:1 hint late",
		]);
	});
});

describe("a diagnostics section", () => {
	it("is nothing at all when the run reported no diagnostics", () => {
		expect(diagnosticsSection({ errored: false, summary: "2 errors", messages: [] }, true)).toBeUndefined();
	});

	it("states the outcome mark, the title and the summary on its first row", () => {
		const errored = section(["src/a.ts:1:1 [error] boom"], true, { summary: "1 error" });
		expect(words(errored.lines[0]!)).toBe("status.error Diagnostics (1 error)");

		const warned = section(["src/a.ts:1:1 [warning] hmm"], true, { errored: false, summary: "1 warning" });
		expect(words(warned.lines[0]!)).toBe("status.warning Diagnostics (1 warning)");

		// A summary the tool did not write leaves no empty parentheses behind.
		expect(words(section(["src/a.ts:1:1 [error] boom"], true).lines[0]!)).toBe("status.error Diagnostics");

		// And a caller that titles the block gets its own word.
		const titled = diagnosticsSection({ errored: true, summary: "", messages: ["src/a.ts:1:1 [error] boom"] }, true, {
			title: "Typecheck",
		});
		expect(words(titled!.lines[0]!)).toBe("status.error Typecheck");
	});

	it("keeps the files in the order the compiler reported them, so a group does not move under a reader", () => {
		const built = section(
			["z/last.ts:1:1 [warning] w", "a/first.ts:1:1 [error] e", "z/last.ts:2:1 [error] e2"],
			true,
		);

		// `z/last.ts` was reported first and stays first, though it holds the lesser severity and sorts
		// later by name. Its two diagnostics are its own, worst first.
		expect(built.lines.slice(1).map(words)).toEqual([
			"z/last.ts",
			"  status.error:2:1 e2",
			"  status.warning:1:1 w",
			"a/first.ts",
			"  status.error:1:1 e",
		]);
	});

	it("marks a file whose language it cannot name rather than leaving the row nameless", () => {
		const built = section(["notes:1:1 [error] boom", "src/a.ts:1:1 [error] boom"], true);
		const fileRows = built.lines.filter(line => line.length === 1);

		expect(fileRows.map(line => line[0]!.language)).toEqual(["", "typescript"]);
	});

	it("holds back everything past the fifth diagnostic while collapsed, and nothing when expanded", () => {
		const messages = Array.from({ length: 8 }, (_, i) => `src/a.ts:${i + 1}:1 [error] e${i + 1}`);

		const collapsed = section(messages, false);
		// One header row, one file row, five diagnostics.
		expect(collapsed.lines).toHaveLength(7);
		expect(collapsed.hidden).toEqual({ count: 3, revealable: true });

		const expanded = section(messages, true);
		expect(expanded.lines).toHaveLength(10);
		expect(expanded.hidden).toBeUndefined();
	});

	/**
	 * The hold-back count is the arithmetic a card gets wrong silently. A line the grammar did not
	 * match is still a diagnostic the run produced, so it counts toward the total; a count taken from
	 * the parsed groups alone reads "nothing held back" while dropping the unmatched lines, which is
	 * the case a reader cannot detect from the card.
	 */
	it("counts the lines it could not parse toward what it held back", () => {
		const collapsed = section(
			[
				...Array.from({ length: 4 }, (_, i) => `src/a.ts:${i + 1}:1 [error] e${i + 1}`),
				"note: something the grammar does not know",
				"another unmatched line",
				"a third unmatched line",
			],
			false,
		);

		expect(collapsed.hidden).toEqual({ count: 2, revealable: true });
		// Five shown: four parsed, then the first unmatched line.
		expect(collapsed.lines.slice(2).map(words)).toEqual([
			"  status.error:1:1 e1",
			"  status.error:2:1 e2",
			"  status.error:3:1 e3",
			"  status.error:4:1 e4",
			"  note: something the grammar does not know",
		]);
	});

	it("reads an unmatched line's severity out of the line, so a failure is not shaded like a note", () => {
		const built = section(
			["?? [error] a broken error line", "?? [warning] a broken warning line", "?? just a note"],
			true,
		);

		expect(built.lines.slice(1).map(line => line.at(-1)!.tone)).toEqual(["error", "warning", "dim"]);
	});

	/**
	 * A diagnostic carries its severity twice: in the mark a host resolves to a glyph, and in the
	 * shade of the diagnostic's own words. Only a failure colours its words, so a hint does not read
	 * as one. Neither is visible in the text of a row, which is why the spans are asserted whole.
	 */
	it("shades both a diagnostic's mark and its own words by its severity", () => {
		const rows = section(
			[
				"src/a.ts:1:1 [error] an error",
				"src/a.ts:2:2 [warning] a warning",
				"src/a.ts:3:3 [info] a note",
				"src/a.ts:4:4 [hint] a hint",
			],
			true,
		).lines.slice(2);

		// Span 1 is the mark, span 4 the diagnostic's words.
		expect(rows.map(row => [row[1], row[4]!.tone])).toEqual([
			[{ text: "", symbol: "status.error", tone: "error" }, "error"],
			[{ text: "", symbol: "status.warning", tone: "warning" }, "warning"],
			[{ text: "", symbol: "status.info", tone: "muted" }, "output"],
			[{ text: "", symbol: "status.info", tone: "muted" }, "output"],
		]);
	});

	it("states a diagnostic's code beside it, in the shade the position uses", () => {
		const row = section(["src/a.ts:1:1 [error] boom (TS2304)"], true).lines[2]!;

		expect(words(row)).toBe("  status.error:1:1 boom (TS2304)");
		expect(row.at(-1)).toEqual({ text: " (TS2304)", tone: "dim" });
		// A diagnostic with no code ends on its own words rather than an empty run.
		expect(section(["src/a.ts:1:1 [error] boom"], true).lines[2]!.at(-1)).toEqual({
			text: "boom",
			tone: "error",
		});
	});

	it("nests a diagnostic two columns under the file it belongs to, and never the file itself", () => {
		const built = section(["src/a.ts:1:1 [error] boom"], true);

		expect(built.lines[1]![0]!.text).toBe("src/a.ts");
		expect(built.lines[2]![0]).toEqual({ text: "  " });
	});
});
